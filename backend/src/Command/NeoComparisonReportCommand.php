<?php

namespace App\Command;

use App\Service\NeoComparisonLog;
use App\Service\NeoOrbitComparisonLog;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

/**
 * Summarizes var/log/neo-comparison.jsonl (close approaches) and
 * var/log/neo-orbit-comparison.jsonl (orbital elements). Each close approach,
 * and each object's orbit, is counted once, using its most recent journal
 * line — sources refine their fit over time, the latest state is the one
 * worth judging.
 */
#[AsCommand(name: 'app:neo:comparison-report', description: 'Summarize how JPL CAD, NASA NeoWs and ESA NEOCC agree on NEO close approaches and orbits')]
final class NeoComparisonReportCommand extends Command
{
    /**
     * Relative deviation (spread ÷ |mean|, spread ÷ 360 for angles) flagged as
     * a genuine disagreement rather than two independent fits landing a hair
     * apart. Apophis — about as well-observed as a NEO gets — measures ~1e-7
     * between SBDB and ESA (fixture dated 2026-10-12); 0.1% is two orders of
     * magnitude above that, and matches NeoFeedMerger::NEOWS_DISTANCE_TOLERANCE,
     * this project's existing idea of "no longer a rounding difference".
     */
    private const ORBIT_DISAGREEMENT_THRESHOLD = 0.001;

    public function __construct(
        private readonly NeoComparisonLog $log,
        private readonly NeoOrbitComparisonLog $orbitLog,
    ) {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this->addOption('days', null, InputOption::VALUE_REQUIRED, 'Only journal lines from the last N days (0 = all)', '30');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);
        $days = (int) $input->getOption('days');
        $since = $days > 0 ? new \DateTimeImmutable(sprintf('-%d days', $days)) : null;

        $lines = 0;
        $approaches = [];
        foreach ($this->log->read($since) as $entry) {
            ++$lines;
            foreach ($entry['objects'] as $object) {
                $date = $object['jpl_cad']['date'] ?? $object['nasa_neows']['date'] ?? $object['esa_neocc']['date'] ?? '?';
                $approaches[$object['designation'].'|'.$date] = $object;
            }
        }

        $io->title('Comparaison des sources NEO');
        $io->text(sprintf('Journal : %s — %d ligne(s)%s, %d approche(s) distincte(s).', $this->log->getPath(), $lines, $since ? sprintf(' depuis %s', $since->format('Y-m-d')) : '', count($approaches)));
        if ($approaches === []) {
            $io->warning('Rien à analyser.');

            return Command::SUCCESS;
        }

        foreach (['nasa_neows' => 'NASA NeoWs ↔ JPL (cohérence)', 'esa_neocc' => 'ESA NEOCC ↔ JPL (calculs indépendants)', 'jpl_cad' => 'JPL CAD (objets vus ailleurs)'] as $source => $title) {
            $io->section($title);
            $statuses = [];
            $missing = [];
            foreach ($approaches as $key => $object) {
                $comparison = $object['comparison'][$source];
                $label = $comparison['status'].(isset($comparison['reason']) ? ' ('.$comparison['reason'].')' : '');
                $statuses[$label] = ($statuses[$label] ?? 0) + 1;
                if ($comparison['status'] === 'missing') {
                    $missing[] = [$key, $comparison['reason']];
                }
            }
            ksort($statuses);
            $io->table(['statut', 'approches'], array_map(null, array_keys($statuses), array_values($statuses)));
            if ($missing !== []) {
                $io->text('Absents :');
                $io->table(['objet|date', 'raison'], $missing);
            }

            if ($source === 'nasa_neows') {
                $rows = [];
                foreach ($approaches as $key => $object) {
                    foreach ($object['comparison']['nasa_neows']['mismatches'] ?? [] as $mismatch) {
                        $rows[] = [$key, $mismatch['field'], json_encode($mismatch['jpl_cad']), json_encode($mismatch['nasa_neows'])];
                    }
                }
                $rows === [] ? $io->text('Aucun écart de valeur.') : $io->table(['objet|date', 'champ', 'JPL', 'NeoWs'], $rows);
            }

            if ($source === 'esa_neocc') {
                $this->esaStatistics($io, $approaches);
            }
        }

        $io->section('Listes de risque d\'impact (JPL Sentry ↔ ESA)');
        $disagreements = [];
        foreach ($approaches as $key => $object) {
            $lists = $object['comparison']['impact_risk_lists'];
            if ($lists !== null && !$lists['agree']) {
                $disagreements[] = [$key, $lists['jpl_sentry'] ? 'oui' : 'non', $lists['esa_neocc'] ? 'oui' : 'non'];
            }
        }
        $disagreements === [] ? $io->text('Aucun désaccord sur les objets journalisés.') : $io->table(['objet|date', 'Sentry', 'ESA'], $disagreements);

        $this->orbitsSection($io, $since);

        return Command::SUCCESS;
    }

    /** @param ?\DateTimeImmutable $since */
    private function orbitsSection(SymfonyStyle $io, ?\DateTimeImmutable $since): void
    {
        $lines = 0;
        $orbits = [];
        foreach ($this->orbitLog->read($since) as $entry) {
            ++$lines;
            $orbits[$entry['designation']] = $entry;
        }

        $io->section('Comparaison des orbites (SBDB ↔ ESA ↔ ssoCard)');
        $io->text(sprintf('Journal : %s — %d ligne(s)%s, %d objet(s) distinct(s).', $this->orbitLog->getPath(), $lines, $since ? sprintf(' depuis %s', $since->format('Y-m-d')) : '', count($orbits)));
        if ($orbits === []) {
            $io->warning('Rien à analyser.');

            return;
        }

        $fields = ['a_au', 'e', 'i_deg', 'node_deg', 'peri_deg', 'period_days'];
        $spreadsByField = array_fill_keys($fields, []);
        $worst = [];
        foreach ($orbits as $designation => $entry) {
            $comparison = $entry['comparison'];
            foreach ($fields as $field) {
                if ($comparison['spread'][$field] !== null) {
                    $spreadsByField[$field][] = $comparison['spread'][$field];
                }
            }
            if ($comparison['worst'] !== null && $comparison['worst']['relative'] > self::ORBIT_DISAGREEMENT_THRESHOLD) {
                $worst[] = [$designation, implode(',', $comparison['compared']), $comparison['worst']['field'], sprintf('%.6f', $comparison['worst']['relative'])];
            }
        }

        $rows = [];
        foreach ($fields as $field) {
            $values = $spreadsByField[$field];
            if ($values === []) {
                $rows[] = [$field, '—', '—', 0];
                continue;
            }
            sort($values);
            $count = count($values);
            $median = $count % 2 ? $values[intdiv($count, 2)] : ($values[$count / 2 - 1] + $values[$count / 2]) / 2;
            $rows[] = [$field, sprintf('%.3g', $median), sprintf('%.3g', end($values)), $count];
        }
        $io->table(['champ', 'étendue médiane', 'étendue max', 'objets comparés'], $rows);

        if ($worst === []) {
            $io->text(sprintf('Aucun objet au-delà du seuil de désaccord (%.1f %%).', self::ORBIT_DISAGREEMENT_THRESHOLD * 100));
        } else {
            $io->text(sprintf('Objets au-delà du seuil de désaccord (%.1f %%) :', self::ORBIT_DISAGREEMENT_THRESHOLD * 100));
            $io->table(['désignation', 'sources comparées', 'champ le plus divergent', 'écart relatif'], $worst);
        }
    }

    /** @param array<string, array<string, mixed>> $approaches */
    private function esaStatistics(SymfonyStyle $io, array $approaches): void
    {
        $diffs = [];
        $outside = [];
        $otherDate = [];
        foreach ($approaches as $key => $object) {
            $esa = $object['comparison']['esa_neocc'];
            if (!isset($esa['distance_diff_km'])) {
                continue;
            }
            $diffs[] = abs($esa['distance_diff_km']);
            if (!$esa['within_jpl_uncertainty']) {
                $outside[] = [$key, $esa['distance_diff_km'], $esa['jpl_uncertainty_km'], $esa['distance_diff_pct']];
            }
            if ($esa['date_diff_days'] !== 0) {
                $otherDate[] = [$key, $esa['date_diff_days']];
            }
        }
        if ($diffs === []) {
            $io->text('Aucune approche commune JPL/ESA.');

            return;
        }
        sort($diffs);
        $count = count($diffs);
        $median = $count % 2 ? $diffs[intdiv($count, 2)] : ($diffs[$count / 2 - 1] + $diffs[$count / 2]) / 2;
        $io->text(sprintf(
            'Écart de distance |ESA − JPL| sur %d approche(s) communes : médiane %s km, max %s km ; %d hors de la marge d\'incertitude JPL (%.1f %%).',
            $count,
            number_format($median, 0, ',', ' '),
            number_format(end($diffs), 0, ',', ' '),
            count($outside),
            count($outside) / $count * 100,
        ));
        if ($outside !== []) {
            $io->table(['objet|date', 'écart km', 'marge JPL ± km', 'écart %'], $outside);
        }
        if ($otherDate !== []) {
            $io->table(['objet|date', 'écart de date (j)'], $otherDate);
        }
    }
}
