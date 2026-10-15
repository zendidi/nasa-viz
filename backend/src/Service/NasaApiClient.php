<?php

namespace App\Service;

use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpClient\Exception\TransportException;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;
use Symfony\Contracts\HttpClient\HttpClientInterface;

/**
 * Wraps the public NASA API, returning normalized shapes so clients (web, Unity)
 * never depend on NASA's raw response format.
 *
 * NeoWs only, and so the only thing left in the project that spends the shared
 * `DEMO_KEY` budget. APOD left on 2026-09-30 for ApodClient, which reads
 * science.nasa.gov without a key -- see that class for why NASA's move forced it.
 */
final class NasaApiClient
{
    /**
     * NeoWs is one of five requests /api/neo has in flight at once (see
     * NeoFeedBuilder), so the route's worst case is the largest budget among
     * them, not their sum. Explicit because the inherited `default_socket_timeout`
     * (60 s) is longer than PHP's 30 s execution wall -- see ApodClient for the
     * 2026-09-30 incident that taught it.
     */
    private const TIMEOUT_SECONDS = 8;
    private const MAX_DURATION_SECONDS = 15;

    public function __construct(
        private readonly HttpClientInterface $httpClient,
        private readonly NasaUsageTracker $usageTracker,
        #[Autowire(env: 'NASA_BASE_URL')]
        private readonly string $baseUrl,
        #[Autowire(env: 'NASA_API_KEY')]
        private readonly string $apiKey,
    ) {
    }

    /**
     * NeoWs feed as raw-ish rows, one per object (its close approach inside
     * the range). The request is sent (and counted against the quota) now;
     * the returned closure parses the answer — see JplCadClient for why.
     *
     * @return \Closure(): list<array<string, mixed>>
     */
    public function requestNeoApproaches(string $startDate, string $endDate): \Closure
    {
        $this->usageTracker->recordCall();
        $response = $this->httpClient->request('GET', $this->baseUrl.'/neo/rest/v1/feed', [
            'query' => [
                'start_date' => $startDate,
                'end_date' => $endDate,
                'api_key' => $this->apiKey,
            ],
            'timeout' => self::TIMEOUT_SECONDS,
            'max_duration' => self::MAX_DURATION_SECONDS,
        ]);

        return static function () use ($response): array {
            try {
                $data = $response->toArray();
            } catch (ExceptionInterface $e) {
                throw new TransportException('Unable to fetch NEO feed: '.$e->getMessage(), previous: $e);
            }

            $rows = [];
            foreach ($data['near_earth_objects'] ?? [] as $dateObjects) {
                foreach ($dateObjects as $neo) {
                    $rows[] = self::normalizeNeo($neo);
                }
            }

            return $rows;
        };
    }

    private static function normalizeNeo(array $neo): array
    {
        $approach = $neo['close_approach_data'][0] ?? null;
        // "2026-Sep-17 02:29", same TDB clock as JPL CAD.
        $at = isset($approach['close_approach_date_full'])
            ? \DateTimeImmutable::createFromFormat('!Y-M-d H:i', $approach['close_approach_date_full'], new \DateTimeZone('UTC'))
            : false;

        return [
            'neows_id' => $neo['id'],
            'designation' => NeoDesignation::fromName($neo['name']),
            'number' => NeoDesignation::numberFromName($neo['name']),
            'name' => $neo['name'],
            'date' => $approach['close_approach_date'] ?? null,
            'approach_at' => $at ? $at->format('Y-m-d\TH:i\Z') : null,
            'dist_au' => isset($approach['miss_distance']['astronomical']) ? (float) $approach['miss_distance']['astronomical'] : null,
            'dist_km' => isset($approach['miss_distance']['kilometers']) ? (float) $approach['miss_distance']['kilometers'] : null,
            'v_rel_kms' => isset($approach['relative_velocity']['kilometers_per_second']) ? (float) $approach['relative_velocity']['kilometers_per_second'] : null,
            'orbiting_body' => $approach['orbiting_body'] ?? null,
            'h' => isset($neo['absolute_magnitude_h']) ? (float) $neo['absolute_magnitude_h'] : null,
            'diameter_min_km' => (float) $neo['estimated_diameter']['kilometers']['estimated_diameter_min'],
            'diameter_max_km' => (float) $neo['estimated_diameter']['kilometers']['estimated_diameter_max'],
            'is_pha' => (bool) $neo['is_potentially_hazardous_asteroid'],
            'is_sentry' => (bool) ($neo['is_sentry_object'] ?? false),
        ];
    }
}
