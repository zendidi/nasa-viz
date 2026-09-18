<?php

namespace App\Service;

use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Contracts\HttpClient\HttpClientInterface;
use Symfony\Contracts\HttpClient\ResponseInterface;

/**
 * JPL's Close Approach Data API (cad.api) and Sentry impact-monitoring list
 * (sentry.api) — keyless, outside the api.nasa.gov quota. JPL computes the
 * orbits NASA NeoWs republishes, so CAD is the reference list of the NEO feed.
 *
 * Methods send their requests immediately and return a closure that parses
 * the answers, so callers can start every source before waiting on any of
 * them (Symfony HttpClient runs pending requests concurrently).
 */
final class JplCadClient
{
    /**
     * Distance cap of the CAD query, matched to how far NASA NeoWs' feed goes
     * so a missing object means something (see docs/neo-jpl-ssodnet.md).
     */
    public const DIST_MAX_AU = 0.5;

    public function __construct(
        private readonly HttpClientInterface $httpClient,
        #[Autowire(env: 'JPL_SSD_API_BASE_URL')]
        private readonly string $baseUrl,
    ) {
    }

    /**
     * Asteroid close approaches from $start 00:00 to $end 23:59:59 (TDB).
     *
     * @return \Closure(): list<array<string, mixed>>
     */
    public function requestApproaches(\DateTimeImmutable $start, \DateTimeImmutable $end): \Closure
    {
        $query = [
            'date-min' => $start->format('Y-m-d').'T00:00:00',
            'date-max' => $end->format('Y-m-d').'T23:59:59',
            'dist-max' => (string) self::DIST_MAX_AU,
            'kind' => 'a',
            'fullname' => 'true',
            'diameter' => 'true',
        ];
        $all = $this->httpClient->request('GET', $this->baseUrl.'/cad.api', ['query' => $query]);
        // CAD has no PHA column, only a filter — a second, filtered call gives the flag.
        $pha = $this->httpClient->request('GET', $this->baseUrl.'/cad.api', ['query' => ['pha' => 'true'] + $query]);

        return static function () use ($all, $pha): array {
            HttpResponses::settle($all, $pha);
            $phaDesignations = array_flip(array_column(self::rows($pha), 'des'));

            return array_map(
                static fn (array $row) => self::normalizeApproach($row, isset($phaDesignations[$row['des']])),
                self::rows($all),
            );
        };
    }

    /**
     * Every object on JPL's Sentry impact-risk list (one call, ~2 000 rows).
     *
     * @return \Closure(): list<array<string, mixed>>
     */
    public function requestSentryList(): \Closure
    {
        $response = $this->httpClient->request('GET', $this->baseUrl.'/sentry.api');

        return static function () use ($response): array {
            $data = $response->toArray();
            if (!isset($data['data']) || !is_array($data['data'])) {
                throw new \UnexpectedValueException('Sentry list without "data"');
            }

            return array_map(static fn (array $row) => [
                'designation' => NeoDesignation::fromName($row['fullname']),
                'number' => NeoDesignation::numberFromName($row['fullname']),
                'name' => trim($row['fullname']),
                'impact_probability' => (float) $row['ip'],
                'palermo_cum' => (float) $row['ps_cum'],
                'palermo_max' => (float) $row['ps_max'],
                'torino_max' => (int) $row['ts_max'],
                'n_impacts' => (int) $row['n_imp'],
                'range' => $row['range'],
                'diameter_km' => isset($row['diameter']) ? (float) $row['diameter'] : null,
                'h' => isset($row['h']) ? (float) $row['h'] : null,
            ], $data['data']);
        };
    }

    /**
     * CAD answers {fields: [...], data: [[...], ...]} — rows are read by field
     * name, not position, so an added column can't shift values.
     *
     * A query matching nothing answers {signature, count: 0} instead, with no
     * "fields" and no "data" at all. That's an empty list, not a broken answer:
     * the PHA-filtered call hits it on any day without a single potentially
     * hazardous approach (2026-09-18, for one), and treating it as a failure
     * used to drop the whole JPL CAD source — the feed's reference — leaving
     * the merge to fall back on NeoWs.
     *
     * @return list<array<string, ?string>>
     */
    private static function rows(ResponseInterface $response): array
    {
        $data = $response->toArray();
        if (!isset($data['fields'])) {
            if (0 === (int) ($data['count'] ?? 0)) {
                return [];
            }

            throw new \UnexpectedValueException('CAD answer without "fields": '.substr(json_encode($data), 0, 200));
        }

        return array_map(static fn (array $row) => array_combine($data['fields'], $row), $data['data'] ?? []);
    }

    /** @param array<string, ?string> $row */
    private static function normalizeApproach(array $row, bool $isPha): array
    {
        $fullname = $row['fullname'] ?? $row['des'];
        // "2026-Sep-17 02:29", TDB (≈ UTC + 69 s, ignored).
        $at = \DateTimeImmutable::createFromFormat('!Y-M-d H:i', $row['cd'], new \DateTimeZone('UTC'));
        if (!$at) {
            throw new \UnexpectedValueException(sprintf('unexpected CAD date "%s"', $row['cd']));
        }

        return [
            'designation' => NeoDesignation::fromName($fullname),
            'number' => NeoDesignation::numberFromName($fullname),
            'name' => trim($fullname),
            'orbit_id' => $row['orbit_id'],
            'date' => $at->format('Y-m-d'),
            'approach_at' => $at->format('Y-m-d\TH:i\Z'),
            'dist_au' => (float) $row['dist'],
            'dist_min_au' => (float) $row['dist_min'],
            'dist_max_au' => (float) $row['dist_max'],
            'v_rel_kms' => (float) $row['v_rel'],
            'v_inf_kms' => isset($row['v_inf']) ? (float) $row['v_inf'] : null,
            'time_uncertainty' => $row['t_sigma_f'],
            'h' => isset($row['h']) ? (float) $row['h'] : null,
            'diameter_km' => isset($row['diameter']) ? (float) $row['diameter'] : null,
            'diameter_sigma_km' => isset($row['diameter_sigma']) ? (float) $row['diameter_sigma'] : null,
            'is_pha' => $isPha,
        ];
    }
}
