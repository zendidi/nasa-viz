<?php

namespace App\Service;

use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Contracts\HttpClient\HttpClientInterface;
use Symfony\Contracts\HttpClient\ResponseInterface;

/**
 * ESA's NEO Coordination Centre (neo.ssa.esa.int) — keyless. ESA computes its
 * own orbits from the same Minor Planet Center observations as JPL, which
 * makes it the independent point of comparison for JPL's figures.
 *
 * Its lists are fixed-width text tables with "|" separators, preceded by a
 * "Last Update:" line and three header lines. Like JplCadClient, request
 * methods send immediately and return a parsing closure.
 */
final class EsaNeoccClient
{
    /** ESA's close-approach lists stop here (largest distance seen on 2026-09-17: 0.049755 au over a year). */
    public const MAX_DIST_AU = 0.05;

    public function __construct(
        private readonly HttpClientInterface $httpClient,
        #[Autowire(env: 'ESA_NEOCC_BASE_URL')]
        private readonly string $baseUrl,
    ) {
    }

    /**
     * Past (~1 month) and upcoming (~1 year) close approaches under 0.05 au.
     * `from`/`to` bound the dates the two lists cover; approach dates carry no
     * time of day.
     *
     * @return \Closure(): array{last_update: ?string, from: ?string, to: ?string, approaches: list<array<string, mixed>>}
     */
    public function requestCloseApproaches(): \Closure
    {
        $recent = $this->download('esa_recent_close_app');
        $upcoming = $this->download('esa_upcoming_close_app');

        return static function () use ($recent, $upcoming): array {
            HttpResponses::settle($recent, $upcoming);
            $recentTable = self::parseTable($recent->getContent());
            $upcomingTable = self::parseTable($upcoming->getContent());

            $approaches = [];
            foreach ([...$recentTable['rows'], ...$upcomingTable['rows']] as $fields) {
                $approach = self::normalizeApproach($fields);
                // Today's approaches can appear in both lists.
                $approaches[implode('|', NeoDesignation::matchKeys($approach['number'], $approach['designation'])).'|'.$approach['date']] = $approach;
            }
            $approaches = array_values($approaches);
            $dates = array_column($approaches, 'date');

            return [
                'last_update' => $upcomingTable['last_update'] ?? $recentTable['last_update'],
                'from' => $dates === [] ? null : min($dates),
                'to' => $dates === [] ? null : max($dates),
                'approaches' => $approaches,
            ];
        };
    }

    /**
     * ESA's impact-risk list — its counterpart to JPL Sentry.
     *
     * @return \Closure(): array{last_update: ?string, objects: list<array<string, mixed>>}
     */
    public function requestRiskList(): \Closure
    {
        $response = $this->download('esa_risk_list');

        return static function () use ($response): array {
            $table = self::parseTable($response->getContent());

            return [
                'last_update' => $table['last_update'],
                'objects' => array_map(static function (array $fields) {
                    if (count($fields) < 11) {
                        throw new \UnexpectedValueException('ESA risk list row with '.count($fields).' columns');
                    }

                    return self::identify($fields[0]) + [
                        'diameter_m' => self::number($fields[1]),
                        'diameter_estimated' => $fields[2] === '*',
                        'max_impact_at' => $fields[3],
                        'impact_probability_max' => self::number($fields[4]),
                        'palermo_max' => self::number($fields[5]),
                        'torino_max' => (int) $fields[6],
                        'v_impact_kms' => self::number($fields[7]),
                        'range' => $fields[8],
                        'impact_probability' => self::number($fields[9]),
                        'palermo_cum' => self::number($fields[10]),
                    ];
                }, $table['rows']),
            ];
        };
    }

    /**
     * One object's own Keplerian elements — ESA's half of the orbit
     * comparison exposed at `/api/neo/details` (`orbits.esa`). Prefers
     * `.ke1` (elements propagated to the common epoch MJD 61200 = JD
     * 2461200.5) over `.ke0` (elements at ESA's own fit epoch, whatever that
     * happens to be), falling back to `.ke0` only when `.ke1` has nothing.
     * `orbits.esa.solution` says which one actually answered.
     *
     * This matters more than it sounds: MJD 61200 is, measured 2026-10-12,
     * the SAME epoch SBDB and ssoCard already sit at for Apophis
     * (`epoch_jd` 2461200.5 on both). Comparing `.ke0` against them instead
     * compares elements 8 years apart and calls the result a "disagreement"
     * — Apophis's own `a_au` spread that way is 2e-4 (relative ~2e-4), but at
     * the shared epoch (`.ke1` vs. SBDB) it drops to ~1e-9. An epoch gap
     * drifts EVERY element, not just the obviously time-dependent
     * mean_anomaly_deg — that's exactly why `.ke1` is tried first rather than
     * `.ke0` with a same_epoch flag bolted on after the fact.
     *
     * The two requests are NOT sent together "just in case": `.ke1` is tried,
     * and `.ke0` is only asked for — one more round trip — when `.ke1` came
     * back with nothing, so a typical object pays for one request, not two.
     * Both files share the exact same two traps, measured 2026-10-12 against
     * the real service (parseOrbit() is deliberately the one piece of logic
     * for both rather than duplicated per extension):
     * - a space in the designation returns ANOTHER object's elements under a
     *   name line that doesn't match what was asked (`file=2024%20YR4.ke0` →
     *   name line "2024", a=2.325 au — not 2024 YR4's own a=2.516 au, only
     *   obtained via `file=2024YR4.ke0`). So every space is stripped before
     *   the request, and the name line is checked against the (also
     *   space-stripped) designation afterwards — the only way to catch this;
     * - an unknown object returns HTTP 200 with a completely EMPTY body
     *   (`2018PL23.ke0`/`.ke1` both measured as 0 bytes), never a 404.
     *
     * @return \Closure(): ?array{epoch_jd: float, a_au: float, e: float, i_deg: float, node_deg: float, peri_deg: float, mean_anomaly_deg: float, period_days: ?float, q_au: ?float, ad_au: ?float, moid_earth_au: ?float, orbit_type: ?string, is_pha: ?bool, solution: string}
     */
    public function requestOrbit(string $designation): \Closure
    {
        $key = str_replace(' ', '', $designation);
        $ke1 = $this->download($key.'.ke1');

        return function () use ($ke1, $key, $designation): ?array {
            $orbit = self::parseOrbit($ke1->getContent(false), $designation);
            if ($orbit !== null) {
                return $orbit + ['solution' => 'ke1'];
            }

            // Fired only now — not alongside the .ke1 request above — because
            // firing it unconditionally would double ESA's request count for
            // every object just to cover the few without a .ke1.
            $ke0 = $this->download($key.'.ke0');
            $orbit = self::parseOrbit($ke0->getContent(false), $designation);

            return $orbit === null ? null : $orbit + ['solution' => 'ke0'];
        };
    }

    private function download(string $file): ResponseInterface
    {
        return $this->httpClient->request('GET', $this->baseUrl.'/download', ['query' => ['file' => $file]]);
    }

    /**
     * OEF2.0 Keplerian-elements file (format ".ke0"). Returns null for an
     * unknown object, a rejected reference frame, or a designation that
     * doesn't match the file's own name line — never throws, so a parsing
     * oddity degrades to "no ESA orbit" rather than failing the whole sheet.
     *
     * @return ?array{epoch_jd: float, a_au: float, e: float, i_deg: float, node_deg: float, peri_deg: float, mean_anomaly_deg: float, period_days: ?float, q_au: ?float, ad_au: ?float, moid_earth_au: ?float, orbit_type: ?string, is_pha: ?bool}
     */
    public static function parseOrbit(string $text, string $designation): ?array
    {
        if (trim($text) === '') {
            return null; // unknown object: HTTP 200, zero-byte body
        }
        $lines = preg_split('/\R/', $text);

        $format = null;
        $refsys = null;
        $headerEnd = null;
        foreach ($lines as $i => $line) {
            if (preg_match("/^format\s*=\s*'([^']+)'/", $line, $matches)) {
                $format = $matches[1];
            } elseif (preg_match('/^refsys\s*=\s*(.+?)\s*!/', $line, $matches)) {
                $refsys = trim($matches[1]);
            } elseif (trim($line) === 'END_OF_HEADER') {
                $headerEnd = $i;
                break;
            }
        }
        // The reference frame must come from the file, not be assumed by the
        // caller — a client that decreed its own frame produced rosette orbits
        // for forty days before anyone noticed (web/src/scene/planets.js,
        // ORBIT_FRAME). Requiring the exact header values is that lesson applied
        // here: anything else, including a format this parser was never taught, is "no orbit".
        if ($headerEnd === null || $format !== 'OEF2.0' || $refsys !== 'ECLM J2000') {
            return null;
        }

        $nameLine = null;
        foreach (array_slice($lines, $headerEnd + 1) as $line) {
            if (trim($line) !== '') {
                $nameLine = trim($line);
                break;
            }
        }
        $expected = strtoupper(str_replace(' ', '', $designation));
        if ($nameLine === null || strtoupper(str_replace(' ', '', $nameLine)) !== $expected) {
            // Catches the space trap documented on requestOrbit(): wrong object,
            // right-looking elements, so a mismatch here is treated exactly like
            // "unknown" rather than risking the wrong orbit under the right label.
            return null;
        }

        $kep = null;
        $mjd = null;
        $extra = [];
        foreach ($lines as $line) {
            $trimmed = trim($line);
            if (preg_match('/^KEP\s+(.+)$/', $trimmed, $matches)) {
                $kep = preg_split('/\s+/', trim($matches[1]));
            } elseif (preg_match('/^MJD\s+([\d.]+)\s+TDT/', $trimmed, $matches)) {
                $mjd = (float) $matches[1];
            } elseif (str_starts_with($trimmed, '!')) {
                $tokens = preg_split('/\s+/', trim(substr($trimmed, 1)));
                match ($tokens[0] ?? '') {
                    'PERIHELION' => $extra['q_au'] = isset($tokens[1]) ? (float) $tokens[1] : null,
                    'APHELION' => $extra['ad_au'] = isset($tokens[1]) ? (float) $tokens[1] : null,
                    'MOID' => $extra['moid_earth_au'] = isset($tokens[1]) ? (float) $tokens[1] : null,
                    'PERIOD' => $extra['period_days'] = isset($tokens[1]) ? (float) $tokens[1] : null,
                    'PHA' => $extra['is_pha'] = ($tokens[1] ?? null) === 'T',
                    'ORB_TYPE' => $extra['orbit_type'] = $tokens[1] ?? null,
                    default => null,
                };
            }
        }
        if ($kep === null || count($kep) < 6 || $mjd === null || !is_numeric($kep[0]) || !is_numeric($kep[1]) || !is_numeric($kep[2]) || !is_numeric($kep[3]) || !is_numeric($kep[4]) || !is_numeric($kep[5])) {
            return null;
        }

        return [
            // MJD → JD is a fixed offset (JD = MJD + 2400000.5), not an epoch system of its own.
            'epoch_jd' => $mjd + 2400000.5,
            'a_au' => (float) $kep[0],
            'e' => (float) $kep[1],
            'i_deg' => (float) $kep[2],
            'node_deg' => (float) $kep[3],
            'peri_deg' => (float) $kep[4],
            'mean_anomaly_deg' => (float) $kep[5],
            'period_days' => $extra['period_days'] ?? null,
            'q_au' => $extra['q_au'] ?? null,
            'ad_au' => $extra['ad_au'] ?? null,
            'moid_earth_au' => $extra['moid_earth_au'] ?? null,
            'orbit_type' => $extra['orbit_type'] ?? null,
            'is_pha' => $extra['is_pha'] ?? null,
        ];
    }

    /**
     * @return array{last_update: ?string, rows: list<list<string>>}
     */
    public static function parseTable(string $text): array
    {
        $lines = preg_split('/\R/', $text);
        if (!preg_match('/^Last Update:\s*(.+?)\s*$/', $lines[0] ?? '', $matches)) {
            throw new \UnexpectedValueException('ESA table without "Last Update" line: '.substr($text, 0, 120));
        }
        $lastUpdate = \DateTimeImmutable::createFromFormat('Y-m-d H:i T', $matches[1]);

        // The last header line is a format template ("AAAAAAAAAAAA …").
        $bodyStart = null;
        foreach ($lines as $i => $line) {
            if (str_starts_with($line, 'AAAA')) {
                $bodyStart = $i + 1;
                break;
            }
        }
        if ($bodyStart === null) {
            throw new \UnexpectedValueException('ESA table without header template line');
        }

        $rows = [];
        foreach (array_slice($lines, $bodyStart) as $line) {
            if (trim($line) === '') {
                continue;
            }
            $rows[] = array_map('trim', explode('|', rtrim(rtrim($line), '|')));
        }

        return ['last_update' => $lastUpdate ? $lastUpdate->format('Y-m-d\TH:i\Z') : null, 'rows' => $rows];
    }

    /** @param list<string> $fields */
    private static function normalizeApproach(array $fields): array
    {
        if (count($fields) < 11) {
            throw new \UnexpectedValueException('ESA close-approach row with '.count($fields).' columns');
        }

        return self::identify($fields[0]) + [
            'date' => $fields[1],
            'dist_km' => self::number($fields[2]),
            'dist_au' => self::number($fields[3]),
            'dist_ld' => self::number($fields[4]),
            'diameter_m' => self::number($fields[5]),
            'diameter_estimated' => $fields[6] === '*',
            'h' => self::number($fields[7]),
            'max_brightness_mag' => self::number($fields[8]),
            'v_rel_kms' => self::number($fields[9]),
            'cai_index' => self::number($fields[10]),
        ];
    }

    /**
     * "2026RB39" (unnumbered), "524522 Zoozve" or "893859 2016VO1" (numbered).
     *
     * @return array{designation: ?string, number: ?string, name: string}
     */
    private static function identify(string $object): array
    {
        $tokens = preg_split('/\s+/', trim($object));
        if (count($tokens) === 1 && ctype_digit($tokens[0])) {
            return ['designation' => null, 'number' => $tokens[0], 'name' => $tokens[0]];
        }
        if (ctype_digit($tokens[0])) {
            $rest = implode(' ', array_slice($tokens, 1));
            $isDesignation = (bool) preg_match('/^\d{4}[A-Z]{2}\d*$/', $rest);

            return [
                'designation' => $isDesignation ? NeoDesignation::expandCompact($rest) : null,
                'number' => $tokens[0],
                'name' => $isDesignation ? sprintf('%s (%s)', $tokens[0], NeoDesignation::expandCompact($rest)) : $tokens[0].' '.$rest,
            ];
        }
        $designation = NeoDesignation::expandCompact(implode(' ', $tokens));

        return ['designation' => $designation, 'number' => null, 'name' => '('.$designation.')'];
    }

    private static function number(string $field): ?float
    {
        return is_numeric($field) ? (float) $field : null;
    }
}
