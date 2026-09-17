<?php

namespace App\Controller;

use App\Service\HorizonsClient;
use App\Service\IssPositionClient;
use App\Service\NasaApiClient;
use App\Service\NasaUsageTracker;
use App\Service\NeoFeedBuilder;
use App\Service\SmallBodyDetailsClient;
use Psr\Cache\CacheItemPoolInterface;
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
 * Every response is normalized JSON (see backend/API.md) so upstream (NASA,
 * JPL, ESA, IMCCE, wheretheiss.at) changes never leak into clients, and every route is cached
 * so both clients together stay well under NASA's free-tier rate limit.
 */
final class SpaceDataController
{
    /** Designations per call — the web client batches, so each request stays short on the single-threaded dev server. */
    private const MAX_DESIGNATIONS_PER_CALL = 10;

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
    public function neo(Request $request, NeoFeedBuilder $builder): JsonResponse
    {
        $today = new \DateTimeImmutable('today');
        $startDate = (string) $request->query->get('start_date', $today->format('Y-m-d'));
        $endDate = (string) $request->query->get('end_date', $today->modify('+1 day')->format('Y-m-d'));

        $start = \DateTimeImmutable::createFromFormat('!Y-m-d', $startDate);
        $end = \DateTimeImmutable::createFromFormat('!Y-m-d', $endDate);
        // The format check also rejects overflowing dates ("2026-02-31") that would reach upstream APIs.
        if (!$start || !$end || $start->format('Y-m-d') !== $startDate || $end->format('Y-m-d') !== $endDate) {
            return new JsonResponse(['error' => 'start_date and end_date must be in YYYY-MM-DD format'], 400);
        }
        if ($end < $start) {
            return new JsonResponse(['error' => 'end_date must not be before start_date'], 400);
        }
        if ($end->diff($start)->days > 7) {
            return new JsonResponse(['error' => 'the date range is limited to 7 days'], 400);
        }

        // Key changed with the multi-source feed shape, so no old NeoWs-only entry is served.
        $cacheKey = 'neo_feed_'.$startDate.'_'.$endDate;

        try {
            $feed = $this->cache->get($cacheKey, function (ItemInterface $item) use ($builder, $startDate, $endDate) {
                $feed = $builder->build($startDate, $endDate);
                // A degraded feed (a source down, e.g. NeoWs quota spent) is retried sooner.
                $item->expiresAfter(in_array('unavailable', $feed['sources'], true) ? 600 : 3600);

                return $feed;
            });
        } catch (ExceptionInterface $e) {
            return $this->upstreamError('neo', $e);
        }

        return new JsonResponse($feed);
    }

    #[Route('/api/neo/positions', name: 'api_neo_positions', methods: ['GET'])]
    public function neoPositions(
        Request $request,
        HorizonsClient $client,
        #[Autowire(service: 'cache.app')] CacheItemPoolInterface $pool,
    ): JsonResponse {
        $start = \DateTimeImmutable::createFromFormat('!Y-m-d', (string) $request->query->get('start_date'), new \DateTimeZone('UTC'));
        $end = \DateTimeImmutable::createFromFormat('!Y-m-d', (string) $request->query->get('end_date'), new \DateTimeZone('UTC'));
        if (!$start || !$end) {
            return new JsonResponse(['error' => 'start_date and end_date are required, in YYYY-MM-DD format'], 400);
        }
        if ($end < $start || $end->diff($start)->days > 7) {
            return new JsonResponse(['error' => 'end_date must be within 7 days after start_date'], 400);
        }

        $designations = $this->parseDesignations($request);
        if ($designations instanceof JsonResponse) {
            return $designations;
        }

        // Table covers the whole feed range, end day included.
        $stop = $end->modify('+1 day');

        $objects = [];
        $items = [];
        $missing = [];
        foreach ($designations as $designation) {
            $item = $pool->getItem('horizons_'.md5($designation.'|'.$start->format('Y-m-d').'|'.$stop->format('Y-m-d')));
            if ($item->isHit()) {
                $objects[$designation] = $item->get();
            } else {
                $items[$designation] = $item;
                $missing[] = $designation;
            }
        }

        if ($missing !== []) {
            try {
                $fetched = $client->getVectors($missing, $start, $stop);
            } catch (ExceptionInterface $e) {
                return $this->upstreamError('neo/positions', $e);
            }
            foreach ($fetched as $designation => $vectors) {
                // An orbit solution barely moves within a day; an unresolved
                // designation is retried sooner in case JPL catches up.
                $items[$designation]->set($vectors)->expiresAfter($vectors === null ? 3600 : 86400);
                $pool->saveDeferred($items[$designation]);
                $objects[$designation] = $vectors;
            }
            $pool->commit();
        }

        return new JsonResponse([
            'frame' => 'ICRF geocentric',
            'units' => 'km',
            'step_seconds' => HorizonsClient::STEP_SECONDS,
            'objects' => $objects,
        ]);
    }

    #[Route('/api/neo/details', name: 'api_neo_details', methods: ['GET'])]
    public function neoDetails(
        Request $request,
        SmallBodyDetailsClient $client,
        #[Autowire(service: 'cache.app')] CacheItemPoolInterface $pool,
    ): JsonResponse {
        $designations = $this->parseDesignations($request);
        if ($designations instanceof JsonResponse) {
            return $designations;
        }

        $objects = [];
        $items = [];
        foreach ($designations as $designation) {
            $item = $pool->getItem('neo_details_'.md5($designation));
            if ($item->isHit()) {
                $objects[$designation] = $item->get();
            } else {
                $items[$designation] = $item;
            }
        }

        if ($items !== []) {
            try {
                $fetched = $client->getDetails(array_keys($items));
            } catch (ExceptionInterface $e) {
                return $this->upstreamError('neo/details', $e);
            }
            foreach ($fetched as $designation => $details) {
                $objects[$designation] = $details;
                // A sheet built while a source was down is served, not kept.
                if ($details !== null && in_array('unavailable', $details['sources'], true)) {
                    continue;
                }
                // Catalogues change weekly at most; an unknown object may be added sooner.
                $items[$designation]->set($details)->expiresAfter($details === null ? 86400 : 7 * 86400);
                $pool->saveDeferred($items[$designation]);
            }
            $pool->commit();
        }

        return new JsonResponse(['objects' => $objects]);
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

    /**
     * `designations=a,b,c` — 1 to MAX_DESIGNATIONS_PER_CALL catalogue
     * designations or numbers.
     *
     * @return list<string>|JsonResponse
     */
    private function parseDesignations(Request $request): array|JsonResponse
    {
        $designations = array_values(array_unique(array_filter(array_map('trim', explode(',', (string) $request->query->get('designations', ''))))));
        if ($designations === [] || count($designations) > self::MAX_DESIGNATIONS_PER_CALL) {
            return new JsonResponse(['error' => sprintf('designations must list 1 to %d comma-separated designations', self::MAX_DESIGNATIONS_PER_CALL)], 400);
        }
        foreach ($designations as $designation) {
            if (!preg_match('/^[A-Za-z0-9 \/-]{1,40}$/', $designation)) {
                return new JsonResponse(['error' => sprintf('invalid designation "%s"', $designation)], 400);
            }
        }

        return $designations;
    }

    private function upstreamError(string $route, ExceptionInterface $e): JsonResponse
    {
        $this->logger->error(sprintf('NASA proxy upstream failure on %s: %s', $route, $e->getMessage()));

        return new JsonResponse(['error' => 'upstream data source unavailable, please retry shortly'], 502);
    }
}
