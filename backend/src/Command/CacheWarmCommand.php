<?php

namespace App\Command;

use App\Service\CachedFeeds;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;

/**
 * Renews the /api/apod and /api/neo cache entries before they lapse, so a
 * visitor is never the one who waits for them -- the counterpart of
 * `app:solar-system:warm` for the two feeds that command does not cover.
 *
 * Unlike that command, this one does not skip a fresh entry: it **recomputes**
 * (CachedFeeds, `$refresh`), because a skip-if-fresh warm only fills holes and
 * leaves the first visitor after each expiry to pay. Run hourly, the TTL of
 * 3600 s never runs out between two runs.
 *
 * APOD is keyless (science.nasa.gov) and always warmed. Forcing it matters even
 * though its key carries the date: the entry stays cached 24 h under today's
 * key, so a run just after local midnight, before NASA has published the new
 * picture, would otherwise pin yesterday's image for the whole day.
 *
 * NEO is behind `--neo` for one reason: NeoWs spends the shared DEMO_KEY budget
 * (50 calls/day), and an hourly warm is 24 of them with zero visitors.
 */
#[AsCommand(
    name: 'app:cache:warm',
    description: 'Refresh the /api/apod (and, with --neo, /api/neo) cache entries before they expire',
    help: <<<'HELP'
        Meant for an hourly cron, after app:solar-system:warm:

          php bin/console app:solar-system:warm && php bin/console app:cache:warm

        APOD is keyless and refreshed on every run.

        --neo also refreshes the default /api/neo range (today to tomorrow), and
        every run spends ONE NeoWs call. Use --neo only with a real NASA_API_KEY:
        on the shared DEMO_KEY (30 calls/hour, 50/day) an hourly run burns 24 of
        the 50 daily calls even when nobody visits.
        HELP,
)]
final class CacheWarmCommand extends Command
{
    public function __construct(
        private readonly CachedFeeds $feeds,
    ) {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this
            ->addOption('neo', null, InputOption::VALUE_NONE, 'Also refresh /api/neo. Spends NeoWs quota: use only with a real NASA_API_KEY, never on DEMO_KEY.')
            ->addOption('dry-run', null, InputOption::VALUE_NONE, 'List what would be refreshed, fetch nothing.');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);
        $dryRun = (bool) $input->getOption('dry-run');

        $refreshed = 0;
        $failed = 0;

        $io->text('apod');
        if ($dryRun) {
            ++$refreshed;
        } else {
            try {
                $this->feeds->apod(refresh: true);
                ++$refreshed;
            } catch (ExceptionInterface $e) {
                $io->warning('apod: '.$e->getMessage());
                ++$failed;
            }
        }

        if ($input->getOption('neo')) {
            [$start, $end] = CachedFeeds::defaultNeoRange();
            $io->text(sprintf('neo %s -> %s (1 NeoWs call)', $start, $end));
            if ($dryRun) {
                ++$refreshed;
            } else {
                try {
                    $this->feeds->neoFeed($start, $end, refresh: true);
                    ++$refreshed;
                } catch (ExceptionInterface $e) {
                    $io->warning('neo: '.$e->getMessage());
                    ++$failed;
                }
            }
        } else {
            $io->text('neo skipped (no --neo: it spends NeoWs quota)');
        }

        $io->success(sprintf('%s%d refreshed, %d failed', $dryRun ? '[dry run] ' : '', $refreshed, $failed));

        // Upstream failures are transient; the previous entry stays in place and
        // the routes still compute on demand. Never a non-zero exit, which a
        // cron would otherwise mail about every hour.
        return Command::SUCCESS;
    }
}
