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

    public function __construct(
        private readonly HttpClientInterface $httpClient,
        #[Autowire(env: 'ISS_POSITION_BASE_URL')]
        private readonly string $baseUrl,
    ) {
    }

    /**
     * @return array{latitude: float, longitude: float, altitude_km: float, velocity_kmh: float, timestamp: int}
     *
     * @throws ExceptionInterface
     */
    public function getPosition(): array
    {
        try {
            $response = $this->httpClient->request('GET', sprintf('%s/satellites/%d', $this->baseUrl, self::ISS_NORAD_ID));
            $data = $response->toArray();
        } catch (ExceptionInterface $e) {
            throw new TransportException('Unable to fetch ISS position: '.$e->getMessage(), previous: $e);
        }

        return [
            'latitude' => (float) $data['latitude'],
            'longitude' => (float) $data['longitude'],
            'altitude_km' => (float) $data['altitude'],
            'velocity_kmh' => (float) $data['velocity'],
            'timestamp' => (int) $data['timestamp'],
        ];
    }
}
