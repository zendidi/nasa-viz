<?php

namespace App\Service;

use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpClient\Exception\TransportException;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;
use Symfony\Contracts\HttpClient\HttpClientInterface;

/**
 * Wraps wheretheiss.at, returning the ISS position in a stable, normalized shape.
 */
final class IssPositionClient
{
    private const ISS_NORAD_ID = 25544;

    /**
     * One request, one route, cached 5 s: the wall is PHP's 30 s, and the
     * inherited `default_socket_timeout` (60 s) is longer than that -- see
     * ApodClient. A tight budget also keeps the single-threaded dev server
     * free for the other routes when wheretheiss.at hangs.
     */
    private const TIMEOUT_SECONDS = 5;
    private const MAX_DURATION_SECONDS = 10;

    public function __construct(
        private readonly HttpClientInterface $httpClient,
        #[Autowire(env: 'ISS_POSITION_BASE_URL')]
        private readonly string $baseUrl,
    ) {
    }

    /** Samples in the track, one a minute: ten minutes of orbit, ~4 600 km of it. */
    public const TRACK_SAMPLES = 10;
    public const TRACK_STEP_SECONDS = 60;

    /**
     * Where the ISS is now **and over the next ten minutes**, in one request
     * (`/positions?timestamps=`, which wheretheiss.at computes from the TLE).
     *
     * A single reading used to be all there was, and its `timestamp` was never
     * read: the marker stood still where the ISS had been at the last poll, up
     * to a minute — ~460 km — behind, and a cached reading of any age was drawn
     * as live on the next page load (audit 2026-10-21). With a track the client
     * places it at the real "now" by interpolation (a one-minute chord of the
     * orbit is ~4 km from the arc), and knows when it no longer can.
     *
     * The first sample is also returned flat, as the reading this route always
     * served, so the contract only gains a field.
     *
     * @return array{latitude: float, longitude: float, altitude_km: float, velocity_kmh: float, timestamp: int,
     *   track: list<array{int, float, float, float}>}
     *
     * @throws ExceptionInterface
     */
    public function getPosition(?int $now = null): array
    {
        $now ??= time();
        $timestamps = array_map(static fn (int $i) => $now + $i * self::TRACK_STEP_SECONDS, range(0, self::TRACK_SAMPLES - 1));

        try {
            $response = $this->httpClient->request('GET', sprintf('%s/satellites/%d/positions', $this->baseUrl, self::ISS_NORAD_ID), [
                'query' => ['timestamps' => implode(',', $timestamps), 'units' => 'kilometers'],
                'timeout' => self::TIMEOUT_SECONDS,
                'max_duration' => self::MAX_DURATION_SECONDS,
            ]);
            $data = $response->toArray();
        } catch (ExceptionInterface $e) {
            throw new TransportException('Unable to fetch ISS position: '.$e->getMessage(), previous: $e);
        }

        if (!isset($data[0]['latitude'])) {
            throw new TransportException('Unable to fetch ISS position: empty track');
        }

        $first = $data[0];

        return [
            'latitude' => (float) $first['latitude'],
            'longitude' => (float) $first['longitude'],
            'altitude_km' => (float) $first['altitude'],
            'velocity_kmh' => (float) $first['velocity'],
            'timestamp' => (int) $first['timestamp'],
            // [unix seconds, latitude °, east longitude °, altitude km], oldest first.
            'track' => array_map(static fn (array $p) => [(int) $p['timestamp'], (float) $p['latitude'], (float) $p['longitude'], (float) $p['altitude']], $data),
        ];
    }
}
