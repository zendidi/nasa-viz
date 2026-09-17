<?php

namespace App\Service;

/**
 * Merges the NEO close-approach lists of JPL CAD (reference), NASA NeoWs and
 * ESA NEOCC into the /api/neo feed, and compares them object by object.
 *
 * Two different comparisons happen here (docs/neo-jpl-ssodnet.md):
 * - NeoWs republishes JPL's own computation, so NeoWs ↔ JPL is a consistency
 *   check — any gap is a copy/freshness/formatting issue;
 * - ESA computes its own orbits from the same observations, so JPL ↔ ESA
 *   gaps are genuine differences between two independent solutions, judged
 *   against JPL's distance uncertainty.
 *
 * An object absent from a source is only "missing" if that source was
 * expected to list it; otherwise it is "not_covered" (beyond its distance cap
 * or date coverage). Pure — no I/O — so every case is unit-testable.
 */
final class NeoFeedMerger
{
    public const AU_KM = 149597870.7;

    public const SOURCES = ['jpl_cad', 'nasa_neows', 'esa_neocc'];

    /** An approach this close to a range edge may land on the other side of another source's day split. */
    private const DATE_BOUNDARY_SECONDS = 7200;

    /** Distance this close to a source's cap may fall either side of it. */
    private const DISTANCE_BOUNDARY_AU = 0.001;

    /** Relative distance gap above which NeoWs no longer mirrors JPL. */
    private const NEOWS_DISTANCE_TOLERANCE = 0.001;

    private const NEOWS_H_TOLERANCE = 0.05;

    /** ESA rounds distances to the km. */
    private const ESA_ROUNDING_KM = 1.0;

    /**
     * @param list<array<string, mixed>>|null $jpl     JplCadClient::requestApproaches rows, null = source unavailable
     * @param list<array<string, mixed>>|null $neows   NasaApiClient::requestNeoApproaches rows
     * @param array{last_update: ?string, from: ?string, to: ?string, approaches: list<array<string, mixed>>}|null $esa
     * @param list<array<string, mixed>>|null $sentry  JplCadClient::requestSentryList rows
     * @param array{last_update: ?string, objects: list<array<string, mixed>>}|null $esaRisk
     *
     * @return array{objects: list<array<string, mixed>>, sources: array<string, string>, comparison: array<string, mixed>, log_objects: list<array<string, mixed>>}
     */
    public function merge(string $startDate, string $endDate, ?array $jpl, ?array $neows, ?array $esa, ?array $sentry, ?array $esaRisk): array
    {
        $utc = new \DateTimeZone('UTC');
        $rangeStart = new \DateTimeImmutable($startDate, $utc);
        $rangeEnd = (new \DateTimeImmutable($endDate, $utc))->modify('+1 day');

        $status = [
            'jpl_cad' => $jpl === null ? 'unavailable' : 'ok',
            'nasa_neows' => $neows === null ? 'unavailable' : 'ok',
            'esa_neocc' => $esa === null ? 'unavailable' : 'ok',
            'jpl_sentry' => $sentry === null ? 'unavailable' : 'ok',
            'esa_risk_list' => $esaRisk === null ? 'unavailable' : 'ok',
        ];

        $groups = $this->group($startDate, $endDate, $jpl ?? [], $neows ?? [], $esa['approaches'] ?? []);
        $sentryIndex = self::index($sentry ?? []);
        $esaRiskIndex = self::index($esaRisk['objects'] ?? []);

        $entries = [];
        foreach ($groups as $group) {
            $ref = $group['jpl_cad'] ?? $group['nasa_neows'] ?? $group['esa_neocc'];
            $keys = array_values(array_unique(array_merge(...array_map(
                static fn (array $row) => NeoDesignation::matchKeys($row['number'], $row['designation']),
                array_values($group),
            ))));
            $sentryRow = self::lookup($sentryIndex, $keys);
            $esaRiskRow = self::lookup($esaRiskIndex, $keys);

            $comparison = [];
            foreach (self::SOURCES as $source) {
                $comparison[$source] = $this->presence($source, $group, $status, $ref, $rangeStart, $rangeEnd, $esa);
            }
            if (isset($group['jpl_cad'], $group['nasa_neows'])) {
                $comparison['nasa_neows']['mismatches'] = $this->compareNeows($group['jpl_cad'], $group['nasa_neows'], $sentry === null ? null : $sentryRow !== null);
            }
            if (isset($group['jpl_cad'], $group['esa_neocc'])) {
                $comparison['esa_neocc'] += $this->compareEsa($group['jpl_cad'], $group['esa_neocc']);
            }
            $comparison['impact_risk_lists'] = $sentry === null || $esaRisk === null ? null : [
                'jpl_sentry' => $sentryRow !== null,
                'esa_neocc' => $esaRiskRow !== null,
                'agree' => ($sentryRow !== null) === ($esaRiskRow !== null),
            ];

            $designation = $ref['designation'] ?? $ref['number'];
            $entries[] = [
                'sort' => ($ref['approach_at'] ?? $ref['date'].'T12:00Z').sprintf('%020.6f', $ref['dist_au'] ?? 0),
                'object' => $this->publicObject($designation, $group, $ref, $sentryRow, $neows === null, $comparison),
                'log' => [
                    'designation' => $designation,
                    'number' => $ref['number'],
                    'name' => $ref['name'],
                    'jpl_cad' => $group['jpl_cad'] ?? null,
                    'nasa_neows' => $group['nasa_neows'] ?? null,
                    'esa_neocc' => $group['esa_neocc'] ?? null,
                    'jpl_sentry' => $sentryRow,
                    'esa_risk_list' => $esaRiskRow,
                    'comparison' => $comparison,
                ],
            ];
        }
        usort($entries, static fn (array $a, array $b) => $a['sort'] <=> $b['sort']);

        $objects = array_column($entries, 'object');

        return [
            'objects' => $objects,
            'sources' => $status,
            'comparison' => $this->summarize($objects),
            'log_objects' => array_column($entries, 'log'),
        ];
    }

    /** Diameter range from absolute magnitude, as NeoWs does: albedo 0.25 → min, 0.05 → max. */
    public static function diameterRangeFromH(float $h): array
    {
        $diameter = static fn (float $albedo) => round(1329 / sqrt($albedo) * 10 ** (-$h / 5), 4);

        return ['min' => $diameter(0.25), 'max' => $diameter(0.05)];
    }

    /**
     * One group per physical object, keyed by source. ESA dates carry no time,
     * so its rows up to a day outside the range may still match an object
     * already found (they never create one).
     *
     * @return list<array<string, array<string, mixed>>>
     */
    private function group(string $startDate, string $endDate, array $jpl, array $neows, array $esaApproaches): array
    {
        $groups = [];
        $index = [];
        $attach = static function (string $source, array $row, bool $mayCreate) use (&$groups, &$index): void {
            $keys = NeoDesignation::matchKeys($row['number'], $row['designation']);
            $target = null;
            foreach ($keys as $key) {
                if (isset($index[$key]) && !isset($groups[$index[$key]][$source])) {
                    $target = $index[$key];
                    break;
                }
            }
            if ($target === null) {
                if (!$mayCreate) {
                    return;
                }
                $target = count($groups);
                $groups[] = [];
            }
            $groups[$target][$source] = $row;
            foreach ($keys as $key) {
                $index[$key] ??= $target;
            }
        };

        foreach ($jpl as $row) {
            $attach('jpl_cad', $row, true);
        }
        foreach ($neows as $row) {
            $attach('nasa_neows', $row, true);
        }
        $dayBefore = (new \DateTimeImmutable($startDate))->modify('-1 day')->format('Y-m-d');
        $dayAfter = (new \DateTimeImmutable($endDate))->modify('+1 day')->format('Y-m-d');
        $inRange = static fn (array $row) => $row['date'] >= $startDate && $row['date'] <= $endDate;
        foreach (array_filter($esaApproaches, $inRange) as $row) {
            $attach('esa_neocc', $row, true);
        }
        foreach ($esaApproaches as $row) {
            if (!$inRange($row) && $row['date'] >= $dayBefore && $row['date'] <= $dayAfter) {
                $attach('esa_neocc', $row, false);
            }
        }

        return $groups;
    }

    private function presence(string $source, array $group, array $status, array $ref, \DateTimeImmutable $rangeStart, \DateTimeImmutable $rangeEnd, ?array $esa): array
    {
        if ($status[$source] === 'unavailable') {
            return ['status' => 'unavailable'];
        }
        if (isset($group[$source])) {
            return ['status' => 'found'];
        }

        $au = $ref['dist_au'];
        $cap = $source === 'esa_neocc' ? EsaNeoccClient::MAX_DIST_AU : JplCadClient::DIST_MAX_AU;
        $withinDates = $source !== 'esa_neocc'
            || ($esa['from'] !== null && $ref['date'] >= $esa['from'] && $ref['date'] <= $esa['to']);
        $withinDistance = $au === null || $au <= $cap;

        if (!$withinDates) {
            return ['status' => 'not_covered'];
        }
        if (!$withinDistance) {
            return ['status' => 'not_covered'];
        }
        // Inside the cap by a hair: the other source's own solution may put it just outside.
        if ($au !== null && $cap - $au <= self::DISTANCE_BOUNDARY_AU) {
            return ['status' => 'missing', 'reason' => 'distance_boundary'];
        }
        if (($ref['approach_at'] ?? null) !== null) {
            $at = (new \DateTimeImmutable($ref['approach_at']))->getTimestamp();
            if (min(abs($at - $rangeStart->getTimestamp()), abs($rangeEnd->getTimestamp() - $at)) <= self::DATE_BOUNDARY_SECONDS) {
                return ['status' => 'missing', 'reason' => 'date_boundary'];
            }
        }

        return ['status' => 'missing', 'reason' => 'unknown'];
    }

    /** @return list<array{field: string, jpl_cad: mixed, nasa_neows: mixed}> */
    private function compareNeows(array $jpl, array $neows, ?bool $inSentry): array
    {
        $mismatches = [];
        $add = static function (string $field, mixed $jplValue, mixed $neowsValue) use (&$mismatches): void {
            $mismatches[] = ['field' => $field, 'jpl_cad' => $jplValue, 'nasa_neows' => $neowsValue];
        };

        if ($neows['dist_au'] !== null && abs($neows['dist_au'] - $jpl['dist_au']) > $jpl['dist_au'] * self::NEOWS_DISTANCE_TOLERANCE) {
            $add('dist_au', $jpl['dist_au'], $neows['dist_au']);
        }
        if ($neows['approach_at'] !== null && $neows['approach_at'] !== $jpl['approach_at']) {
            $add('approach_at', $jpl['approach_at'], $neows['approach_at']);
        } elseif ($neows['date'] !== $jpl['date']) {
            $add('date', $jpl['date'], $neows['date']);
        }
        if ($neows['h'] !== null && $jpl['h'] !== null && abs($neows['h'] - $jpl['h']) > self::NEOWS_H_TOLERANCE) {
            $add('h', $jpl['h'], $neows['h']);
        }
        if ($neows['is_pha'] !== $jpl['is_pha']) {
            $add('is_pha', $jpl['is_pha'], $neows['is_pha']);
        }
        if ($inSentry !== null && $neows['is_sentry'] !== $inSentry) {
            $add('is_sentry', $inSentry, $neows['is_sentry']);
        }

        return $mismatches;
    }

    /**
     * ESA's figures against JPL's, always recorded in full; flagged only when
     * they can't both be right (distance outside JPL's uncertainty, other day).
     */
    private function compareEsa(array $jpl, array $esa): array
    {
        $jplKm = $jpl['dist_au'] * self::AU_KM;
        $minKm = $jpl['dist_min_au'] * self::AU_KM - self::ESA_ROUNDING_KM;
        $maxKm = $jpl['dist_max_au'] * self::AU_KM + self::ESA_ROUNDING_KM;
        $esaKm = $esa['dist_km'] ?? $esa['dist_au'] * self::AU_KM;
        $dateDiffDays = (int) (new \DateTimeImmutable($jpl['date']))->diff(new \DateTimeImmutable($esa['date']))->format('%r%a');
        $within = $esaKm >= $minKm && $esaKm <= $maxKm;

        $mismatches = [];
        if (!$within) {
            $mismatches[] = ['field' => 'dist_km', 'jpl_cad' => round($jplKm), 'esa_neocc' => $esaKm];
        }
        if ($dateDiffDays !== 0) {
            $mismatches[] = ['field' => 'date', 'jpl_cad' => $jpl['date'], 'esa_neocc' => $esa['date']];
        }

        return [
            'distance_km' => $esaKm,
            'distance_diff_km' => round($esaKm - $jplKm, 1),
            'distance_diff_pct' => round(($esaKm - $jplKm) / $jplKm * 100, 4),
            'jpl_uncertainty_km' => round(($jpl['dist_max_au'] - $jpl['dist_min_au']) * self::AU_KM / 2),
            'within_jpl_uncertainty' => $within,
            'date_diff_days' => $dateDiffDays,
            'h_diff' => $esa['h'] === null || $jpl['h'] === null ? null : round($esa['h'] - $jpl['h'], 2),
            'v_rel_diff_kms' => $esa['v_rel_kms'] === null ? null : round($esa['v_rel_kms'] - $jpl['v_rel_kms'], 2),
            'mismatches' => $mismatches,
        ];
    }

    private function publicObject(string $designation, array $group, array $ref, ?array $sentryRow, bool $neowsUnavailable, array $comparison): array
    {
        $jpl = $group['jpl_cad'] ?? null;
        $neows = $group['nasa_neows'] ?? null;
        $esa = $group['esa_neocc'] ?? null;

        $h = $jpl['h'] ?? $neows['h'] ?? $esa['h'] ?? null;
        $measured = false;
        if (isset($jpl['diameter_km'])) {
            $diameter = ['min' => $jpl['diameter_km'], 'max' => $jpl['diameter_km']];
            $measured = true;
        } elseif ($neows !== null) {
            $diameter = ['min' => $neows['diameter_min_km'], 'max' => $neows['diameter_max_km']];
        } elseif ($h !== null) {
            $diameter = self::diameterRangeFromH($h);
        } else {
            $diameter = ['min' => $esa['diameter_m'] / 1000, 'max' => $esa['diameter_m'] / 1000];
        }

        $distanceKm = $jpl !== null ? $jpl['dist_au'] * self::AU_KM : ($ref['dist_km'] ?? null);

        return [
            'id' => $designation,
            'name' => $ref['name'],
            'designation' => $designation,
            'estimated_diameter_km' => $diameter,
            'diameter_measured' => $measured,
            'is_potentially_hazardous' => $jpl['is_pha'] ?? $neows['is_pha'] ?? false,
            // Without the Sentry list, NeoWs' own flag is the best we have.
            'is_sentry_object' => $sentryRow !== null || ($neowsUnavailable ? false : ($neows['is_sentry'] ?? false)),
            'absolute_magnitude_h' => $h,
            'close_approach' => $ref['date'] === null ? null : [
                'date' => $ref['date'],
                'datetime' => $ref['approach_at'] ?? null,
                'miss_distance_km' => $distanceKm === null ? null : round($distanceKm, 2),
                'relative_velocity_kmh' => $ref['v_rel_kms'] === null ? null : round($ref['v_rel_kms'] * 3600, 2),
            ],
            'sources' => array_values(array_filter(self::SOURCES, static fn (string $source) => isset($group[$source]))),
            'comparison' => $comparison,
        ];
    }

    /** @param list<array<string, mixed>> $objects */
    private function summarize(array $objects): array
    {
        $summary = ['total' => count($objects)];
        foreach (self::SOURCES as $source) {
            $summary[$source] = ['found' => 0, 'missing' => 0, 'not_covered' => 0, 'unavailable' => 0];
        }
        $summary['nasa_neows']['mismatched'] = 0;
        $summary['esa_neocc']['outside_jpl_uncertainty'] = 0;
        $summary['esa_neocc']['different_date'] = 0;
        $summary['impact_risk_lists_disagree'] = 0;

        foreach ($objects as $object) {
            $comparison = $object['comparison'];
            foreach (self::SOURCES as $source) {
                ++$summary[$source][$comparison[$source]['status']];
            }
            if (($comparison['nasa_neows']['mismatches'] ?? []) !== []) {
                ++$summary['nasa_neows']['mismatched'];
            }
            if (($comparison['esa_neocc']['within_jpl_uncertainty'] ?? true) === false) {
                ++$summary['esa_neocc']['outside_jpl_uncertainty'];
            }
            if (($comparison['esa_neocc']['date_diff_days'] ?? 0) !== 0) {
                ++$summary['esa_neocc']['different_date'];
            }
            if (($comparison['impact_risk_lists']['agree'] ?? true) === false) {
                ++$summary['impact_risk_lists_disagree'];
            }
        }

        return $summary;
    }

    /**
     * @param list<array<string, mixed>> $rows
     *
     * @return array<string, array<string, mixed>>
     */
    private static function index(array $rows): array
    {
        $index = [];
        foreach ($rows as $row) {
            foreach (NeoDesignation::matchKeys($row['number'], $row['designation']) as $key) {
                $index[$key] ??= $row;
            }
        }

        return $index;
    }

    /** @param list<string> $keys */
    private static function lookup(array $index, array $keys): ?array
    {
        foreach ($keys as $key) {
            if (isset($index[$key])) {
                return $index[$key];
            }
        }

        return null;
    }
}
