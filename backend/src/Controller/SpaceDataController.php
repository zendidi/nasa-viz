<?php

namespace App\Controller;

use App\Service\IssPositionClient;
use App\Service\NasaApiClient;
use App\Service\NasaUsageTracker;
use Psr\Log\LoggerInterface;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Contracts\Cache\CacheInterface;
use Symfony\Contracts\Cache\ItemInterface;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;

/**
 * Proxy for space data consumed by the web viewer and the Unity VR client.
 * Every response is normalized JSON (see backend/API.md) so upstream (NASA /
 * wheretheiss.at) changes never leak into clients, and every route is cached
 * so both clients together stay well under NASA's free-tier rate limit.
 */
final class SpaceDataController
{
    public function __construct(
        #[Autowire(service: 'cache.app')]
        private readonly CacheInterface $cache,
        private readonly LoggerInterface $logger,
    ) {
    }

    #[Route('/api/iss/position', name: 'api_iss_position', methods: ['GET'])]
    public function issPosition(IssPositionClient $client): JsonResponse
    {
        try {
            $position = $this->cache->get('iss_position', function (ItemInterface $item) use ($client) {
                $item->expiresAfter(5);

                return $client->getPosition();
            });
        } catch (ExceptionInterface $e) {
            return $this->upstreamError('iss/position', $e);
        }

        return new JsonResponse($position);
    }

    #[Route('/api/neo', name: 'api_neo', methods: ['GET'])]
    public function neo(Request $request, NasaApiClient $client): JsonResponse
    {
        $today = new \DateTimeImmutable('today');
        $startDate = $request->query->get('start_date', $today->format('Y-m-d'));
        $endDate = $request->query->get('end_date', $today->modify('+1 day')->format('Y-m-d'));

        $start = \DateTimeImmutable::createFromFormat('Y-m-d', $startDate);
        $end = \DateTimeImmutable::createFromFormat('Y-m-d', $endDate);
        if (!$start || !$end) {
            return new JsonResponse(['error' => 'start_date and end_date must be in YYYY-MM-DD format'], 400);
        }
        if ($end < $start) {
            return new JsonResponse(['error' => 'end_date must not be before start_date'], 400);
        }
        if ($end->diff($start)->days > 7) {
            return new JsonResponse(['error' => 'the NASA NeoWs feed only supports ranges of up to 7 days'], 400);
        }

        $cacheKey = 'neo_'.$startDate.'_'.$endDate;

        try {
            $feed = $this->cache->get($cacheKey, function (ItemInterface $item) use ($client, $startDate, $endDate) {
                $item->expiresAfter(3600);

                return $client->getNeoFeed($startDate, $endDate);
            });
        } catch (ExceptionInterface $e) {
            return $this->upstreamError('neo', $e);
        }

        return new JsonResponse($feed);
    }

    #[Route('/api/apod', name: 'api_apod', methods: ['GET'])]
    public function apod(NasaApiClient $client): JsonResponse
    {
        $today = (new \DateTimeImmutable('today'))->format('Y-m-d');

        try {
            $apod = $this->cache->get('apod_'.$today, function (ItemInterface $item) use ($client) {
                $item->expiresAfter(86400);

                return $client->getApod();
            });
        } catch (ExceptionInterface $e) {
            return $this->upstreamError('apod', $e);
        }

        return new JsonResponse($apod);
    }

    #[Route('/api/usage', name: 'api_usage', methods: ['GET'])]
    public function usage(NasaUsageTracker $tracker): JsonResponse
    {
        return new JsonResponse([
            'date' => $tracker->getToday(),
            'nasa_api_calls_today' => $tracker->getTodayCount(),
        ]);
    }

    private function upstreamError(string $route, ExceptionInterface $e): JsonResponse
    {
        $this->logger->error(sprintf('NASA proxy upstream failure on %s: %s', $route, $e->getMessage()));

        return new JsonResponse(['error' => 'upstream data source unavailable, please retry shortly'], 502);
    }
}
