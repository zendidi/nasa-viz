<?php

namespace App\Controller;

use App\Service\CachedFeeds;
use App\Service\IssPositionClient;
use App\Service\NasaUsageTracker;
use Psr\Log\LoggerInterface;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Contracts\Cache\CacheInterface;
use Symfony\Contracts\Cache\ItemInterface;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;

/**
 * The routes that belong to no body family: the ISS, the picture of the day,
 * and the NASA quota counter. The others are in NeoController,
 * SolarSystemController and SmallBodyController (see ProxyController).
 */
final class SpaceDataController extends ProxyController
{
    public function __construct(
        #[Autowire(service: 'cache.app')]
        private readonly CacheInterface $cache,
        LoggerInterface $logger,
    ) {
        parent::__construct($logger);
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
            return $this->upstreamError('iss/position', 'wheretheiss.at', $e);
        }

        return new JsonResponse($position);
    }

    #[Route('/api/apod', name: 'api_apod', methods: ['GET'])]
    public function apod(CachedFeeds $feeds): JsonResponse
    {
        try {
            $apod = $feeds->apod();
        } catch (ExceptionInterface $e) {
            return $this->upstreamError('apod', 'NASA (science.nasa.gov)', $e);
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
}
