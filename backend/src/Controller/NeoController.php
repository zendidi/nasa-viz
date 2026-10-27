<?php

namespace App\Controller;

use App\Service\CachedFeeds;
use App\Service\HorizonsClient;
use App\Service\NeoOrbitComparisonLog;
use App\Service\SmallBodyDetailsClient;
use Psr\Cache\CacheItemPoolInterface;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;

/** The week's NEOs: the merged feed, their Horizons positions, and each object's sheet. */
final class NeoController extends ProxyController
{
    /** Designations per call — the web client batches, so each request stays short on the single-threaded dev server. */
    private const MAX_DESIGNATIONS_PER_CALL = 10;

    /** Sources a /api/neo/details sheet actually depends on — see isCacheable(). */
    private const NEO_DETAILS_LOAD_BEARING_SOURCES = ['sbdb', 'ssocard', 'sentry'];

    #[Route('/api/neo', name: 'api_neo', methods: ['GET'])]
    public function neo(Request $request, CachedFeeds $feeds): JsonResponse
    {
        [$defaultStart, $defaultEnd] = CachedFeeds::defaultNeoRange();
        $startDate = (string) $request->query->get('start_date', $defaultStart);
        $endDate = (string) $request->query->get('end_date', $defaultEnd);

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

        // Key, TTL and computation live in CachedFeeds, shared with app:cache:warm.
        try {
            $feed = $feeds->neoFeed($startDate, $endDate);
        } catch (ExceptionInterface $e) {
            return $this->upstreamError('neo', 'NASA NeoWs / JPL CAD', $e);
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
            $item = $pool->getItem('horizons_'.md5($designation.'|'.$start->format('Y-m-d').'|'.$stop->format('Y-m-d')).'_'.HorizonsClient::TIME_SCALE);
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
                return $this->upstreamError('neo/positions', 'JPL Horizons', $e);
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
            'time_scale' => HorizonsClient::TIME_SCALE,
            'units' => 'km',
            'step_seconds' => HorizonsClient::STEP_SECONDS,
            'objects' => $objects,
        ]);
    }

    #[Route('/api/neo/details', name: 'api_neo_details', methods: ['GET'])]
    public function neoDetails(
        Request $request,
        SmallBodyDetailsClient $client,
        NeoOrbitComparisonLog $orbitLog,
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
                return $this->upstreamError('neo/details', 'JPL SBDB / IMCCE', $e);
            }
            foreach ($fetched as $designation => $details) {
                $objects[$designation] = $details;
                if ($details !== null && $details['orbit_comparison'] !== null) {
                    // Only while the sheet was actually fetched, not when served
                    // from cache — the orbits didn't change in between, so
                    // re-journaling them would just restate the same line (the
                    // fingerprint in NeoOrbitComparisonLog::record() would skip it
                    // anyway, but there is no reason to even try on every cache hit).
                    $orbitLog->record($designation, [
                        'sources' => $details['sources'],
                        'orbits' => $details['orbits'],
                        'comparison' => $details['orbit_comparison'],
                    ]);
                }
                if ($details !== null && !self::isCacheable($details)) {
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

    /**
     * A sheet built while SBDB, ssoCard or Sentry was down shouldn't be kept
     * — those three are what the sheet is made of. ESA is deliberately NOT
     * one of these: it is a bonus comparison point the sheet doesn't depend
     * on, and caching around an ESA outage would otherwise refetch the whole
     * sheet (JPL included) on every single call for as long as ESA stays
     * down. Pure and public so this one decision is unit-testable without a
     * cache pool, an HTTP client, or a route.
     *
     * @param array<string, mixed> $details a non-null entry from SmallBodyDetailsClient::getDetails()
     */
    public static function isCacheable(array $details): bool
    {
        $loadBearingStatuses = array_intersect_key($details['sources'], array_flip(self::NEO_DETAILS_LOAD_BEARING_SOURCES));

        return !in_array('unavailable', $loadBearingStatuses, true);
    }
}
