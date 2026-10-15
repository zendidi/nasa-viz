<?php

namespace App\Command;

use App\Service\MoonClient;
use App\Service\SolarSystemClient;
use Psr\Cache\CacheItemPoolInterface;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;

/**
 * Refreshes the solar-system tables before anyone asks for them — the eager half
 * of the design whose lazy half is the routes themselves.
 *
 * Meant for a cron (hourly is plenty). Everything it touches is keyless JPL
 * Horizons, so it spends no NASA quota; what it buys is that no visitor ever
 * waits on Horizons, whose latency is a range, ~1 s on a good day and up to 16 s
 * on a bad one (docs/agent/gotchas.md).
 *
 * **It runs in CLI, and that is the point.** `max_execution_time` is 0 here
 * against 30 s for a web request — verified 2026-09-29 — so the "one body per
 * call" rule the routes must obey does not apply. This command can work through
 * forty bodies in one process without any risk of the fatal that made
 * `/api/solar-system/positions` return an 80 ko HTML error page and cache
 * nothing.
 *
 * What it refreshes is deliberately **not** the whole catalogue: only planets,
 * plus the moons of planets someone has actually centred on (`MoonClient::INDEX_KEY`,
 * written by the route). A moon nobody has ever looked at is never fetched, and
 * one nobody has looked at for 90 days stops being refreshed on its own.
 */
#[AsCommand(
    name: 'app:solar-system:warm',
    description: 'Pre-fetch planet and moon tables into the shared cache, before visitors need them',
)]
final class SolarSystemWarmCommand extends Command
{
    public function __construct(
        private readonly SolarSystemClient $planets,
        private readonly MoonClient $moons,
        #[Autowire(service: 'cache.app')] private readonly CacheItemPoolInterface $pool,
    ) {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this
            ->addOption(
                'all-moons',
                null,
                InputOption::VALUE_NONE,
                'Warm every planet\'s moons, not only the ones visitors have asked for. Use once after a deploy, not on a cron.',
            )
            ->addOption('dry-run', null, InputOption::VALUE_NONE, 'List what would be fetched, fetch nothing.');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);
        $dryRun = (bool) $input->getOption('dry-run');
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));

        $fetched = 0;
        $skipped = 0;
        $failed = 0;

        // --- planets: positions, then orbits ---------------------------------
        //
        // Positions first and orbits second, the same order the web client uses:
        // a position is what the scene needs to draw a planet at all, an orbit is
        // décor. If this run is cut short, the useful half is already done.

        $planetStart = SolarSystemClient::windowStart($now);

        foreach (SolarSystemClient::ids() as $id) {
            $item = $this->pool->getItem('solar_system_'.$id.'_'.$planetStart->format('Y-m-d'));
            if ($item->isHit()) {
                ++$skipped;
                continue;
            }
            $io->text(sprintf('position %s', $id));
            if ($dryRun) {
                ++$fetched;
                continue;
            }
            try {
                $positions = $this->planets->getPositions([$id], $planetStart)[$id];
            } catch (ExceptionInterface $e) {
                $io->warning(sprintf('%s: %s', $id, $e->getMessage()));
                ++$failed;
                continue;
            }
            $this->pool->save($item->set($positions)->expiresAfter(null === $positions ? 3600 : 40 * 86400));
            null === $positions ? ++$failed : ++$fetched;
        }

        foreach (SolarSystemClient::planetIds() as $id) {
            $item = $this->pool->getItem('solar_system_orbit_'.$id.'_'.$planetStart->format('Y-m-d'));
            if ($item->isHit()) {
                ++$skipped;
                continue;
            }
            $io->text(sprintf('orbit %s', $id));
            if ($dryRun) {
                ++$fetched;
                continue;
            }
            try {
                $orbit = $this->planets->getOrbit($id, $planetStart);
            } catch (ExceptionInterface $e) {
                $io->warning(sprintf('%s orbit: %s', $id, $e->getMessage()));
                ++$failed;
                continue;
            }
            $this->pool->save($item->set($orbit)->expiresAfter(null === $orbit ? 3600 : 40 * 86400));
            null === $orbit ? ++$failed : ++$fetched;
        }

        // --- moons of planets people actually visit ---------------------------

        $planets = $this->planetsToWarm((bool) $input->getOption('all-moons'));
        if ([] === $planets) {
            $io->text('no planet visited yet — no moon to warm (use --all-moons to force)');
        }

        foreach ($planets as $planet) {
            foreach (MoonClient::forPlanet($planet) as $id) {
                $start = MoonClient::windowStart($id, $now);
                $item = $this->pool->getItem('moon_'.$id.'_'.$start->getTimestamp());
                if ($item->isHit()) {
                    ++$skipped;
                    continue;
                }
                $io->text(sprintf('moon %s (%s)', $id, $planet));
                if ($dryRun) {
                    ++$fetched;
                    continue;
                }
                try {
                    $table = $this->moons->getPositions($id, $start);
                } catch (ExceptionInterface $e) {
                    $io->warning(sprintf('%s: %s', $id, $e->getMessage()));
                    ++$failed;
                    continue;
                }
                $this->pool->save($item->set($table)->expiresAfter(null === $table ? 3600 : MoonClient::windowSeconds($id) + 86400));
                null === $table ? ++$failed : ++$fetched;
            }
        }

        $io->success(sprintf(
            '%s%d fetched, %d already fresh, %d failed',
            $dryRun ? '[dry run] ' : '',
            $fetched,
            $skipped,
            $failed,
        ));

        // A failure here is upstream and transient by nature; the next run picks
        // it up, and the routes still fall back to fetching on demand. Never a
        // non-zero exit, which a cron would otherwise mail about every hour.
        return Command::SUCCESS;
    }

    /**
     * Planets whose moons are worth refreshing: the ones a visitor has centred
     * on, or all of them under --all-moons.
     *
     * @return list<string>
     */
    private function planetsToWarm(bool $all): array
    {
        if ($all) {
            return array_values(array_filter(
                SolarSystemClient::planetIds(),
                static fn (string $id) => [] !== MoonClient::forPlanet($id),
            ));
        }

        $index = $this->pool->getItem(MoonClient::INDEX_KEY);

        return $index->isHit() ? array_keys($index->get()) : [];
    }
}
