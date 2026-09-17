<?php

namespace App\Service;

use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpClient\Exception\TransportException;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;
use Symfony\Contracts\HttpClient\HttpClientInterface;

/**
 * Wraps the public NASA API (NeoWs + APOD), returning normalized shapes so
 * clients (web, Unity) never depend on NASA's raw response format.
 */
final class NasaApiClient
{
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
     * @return array{start_date: string, end_date: string, count: int, objects: list<array>}
     *
     * @throws ExceptionInterface
     */
    public function getNeoFeed(string $startDate, string $endDate): array
    {
        try {
            $this->usageTracker->recordCall();
            $response = $this->httpClient->request('GET', $this->baseUrl.'/neo/rest/v1/feed', [
                'query' => [
                    'start_date' => $startDate,
                    'end_date' => $endDate,
                    'api_key' => $this->apiKey,
                ],
            ]);
            $data = $response->toArray();
        } catch (ExceptionInterface $e) {
            throw new TransportException('Unable to fetch NEO feed: '.$e->getMessage(), previous: $e);
        }

        $objects = [];
        foreach ($data['near_earth_objects'] ?? [] as $dateObjects) {
            foreach ($dateObjects as $neo) {
                $approach = $neo['close_approach_data'][0] ?? null;
                $objects[] = [
                    'id' => $neo['id'],
                    'name' => $neo['name'],
                    'designation' => self::designationFromName($neo['name']),
                    'estimated_diameter_km' => [
                        'min' => (float) $neo['estimated_diameter']['kilometers']['estimated_diameter_min'],
                        'max' => (float) $neo['estimated_diameter']['kilometers']['estimated_diameter_max'],
                    ],
                    'is_potentially_hazardous' => (bool) $neo['is_potentially_hazardous_asteroid'],
                    'close_approach' => $approach === null ? null : [
                        'date' => $approach['close_approach_date'],
                        'miss_distance_km' => (float) $approach['miss_distance']['kilometers'],
                        'relative_velocity_kmh' => (float) $approach['relative_velocity']['kilometers_per_hour'],
                    ],
                ];
            }
        }

        return [
            'start_date' => $startDate,
            'end_date' => $endDate,
            'count' => count($objects),
            'objects' => $objects,
        ];
    }

    /**
     * NeoWs names read "(2014 SU1)", "495615 (2015 PQ291)" or
     * "99942 Apophis (2004 MN4)" — the provisional designation in the last
     * parentheses is what other catalogues (JPL Horizons, IMCCE) accept, while
     * the NeoWs `id` is NeoWs-specific.
     */
    public static function designationFromName(string $name): string
    {
        if (preg_match('/\(([^()]+)\)\s*$/', $name, $matches)) {
            return trim($matches[1]);
        }

        return trim($name);
    }

    /**
     * @return array{title: string, date: string, explanation: string, media_type: string, url: string, hd_url: ?string}
     *
     * @throws ExceptionInterface
     */
    public function getApod(): array
    {
        try {
            $this->usageTracker->recordCall();
            $response = $this->httpClient->request('GET', $this->baseUrl.'/planetary/apod', [
                'query' => ['api_key' => $this->apiKey],
            ]);
            $data = $response->toArray();
        } catch (ExceptionInterface $e) {
            throw new TransportException('Unable to fetch APOD: '.$e->getMessage(), previous: $e);
        }

        return [
            'title' => $data['title'],
            'date' => $data['date'],
            'explanation' => $data['explanation'],
            'media_type' => $data['media_type'],
            'url' => $data['url'],
            'hd_url' => $data['hdurl'] ?? null,
        ];
    }
}
