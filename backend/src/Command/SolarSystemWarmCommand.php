<?php

namespace App\Command;

use App\Service\HorizonsClient;
use App\Service\MoonClient;
use App\Service\PlanetOrientationClient;
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
        private readonly PlanetOrientationClient $orientations,
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

    /**
     * One slice: skip it when cached, else fetch and save it under the same key and TTL as the
     * route (a null for an hour, a value for SLICE_TTL_SECONDS).
     *
     * @param callable(): mixed $fetch
     */
    private function warm(SymfonyStyle $io, bool $dryRun, string $key, string $label, callable $fetch, int &$fetched, int &$skipped, int &$failed): void
    {
        $item = $this->pool->getItem($key);
        if ($item->isHit()) {
            ++$skipped;

            return;
        }
        $io->text($label);
        if ($dryRun) {
            ++$fetched;

            return;
        }
        try {
            $value = $fetch();
        } catch (ExceptionInterface $e) {
            $io->warning(sprintf('%s: %s', $label, $e->getMessage()));
            ++$failed;

            return;
        }
        $this->pool->save($item->set($value)->expiresAfter(null === $value ? SolarSystemClient::NULL_TTL_SECONDS : SolarSystemClient::SLICE_TTL_SECONDS));
        null === $value ? ++$failed : ++$fetched;
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);
        $dryRun = (bool) $input->getOption('dry-run');
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));

        $fetched = 0;
        $skipped = 0;
        $failed = 0;

        // --- planets: yearly slices Y-1..Y+4 (lot 3, 2026-11-05) -------------
        //
        // Positions first, then orbits, then orientations: a position is what the scene needs
        // to draw a planet at all, an orbit and a pole are décor. The monthly window is no
        // longer warmed (the web asks for `year=` only). Each slice is immutable, so once warm
        // a run only fetches the new year: ~27 calls on 1 January, ~160 from cold.

        foreach (SolarSystemClient::years($now) as $year) {
            foreach (SolarSystemClient::ids() as $id) {
                $this->warm($io, $dryRun, SolarSystemClient::slicePositionsKey($id, $year), sprintf('position %s %d', $id, $year), fn () => $this->planets->getSlicePositions($id, $year), $fetched, $skipped, $failed);
            }
        }
        foreach (SolarSystemClient::years($now) as $year) {
            foreach (SolarSystemClient::planetIds() as $id) {
                $this->warm($io, $dryRun, SolarSystemClient::sliceOrbitKey($id, $year), sprintf('orbit %s %d', $id, $year), fn () => $this->planets->getOrbit($id, SolarSystemClient::yearStart($year)), $fetched, $skipped, $failed);
            }
        }
        foreach (SolarSystemClient::years($now) as $year) {
            foreach (PlanetOrientationClient::ids() as $id) {
                $this->warm($io, $dryRun, SolarSystemClient::sliceOrientationKey($id, $year), sprintf('orientation %s %d', $id, $year), fn () => $this->orientations->getOrientation($id, SolarSystemClient::yearStart($year)), $fetched, $skipped, $failed);
            }
        }

        // --- moons of planets people actually visit ---------------------------

        $planets = $this->planetsToWarm((bool) $input->getOption('all-moons'));
        if ([] === $planets) {
            $io->text('no planet visited yet — no moon to warm (use --all-moons to force)');
        }

        foreach ($planets as $planet) {
            foreach (MoonClient::forPlanet($planet) as $id) {
                $start = MoonClient::windowStart($id, $now);
                $item = $this->pool->getItem('moon_'.$id.'_'.$start->getTimestamp().'_'.MoonClient::stepSeconds($id).'_'.HorizonsClient::TIME_SCALE);
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
