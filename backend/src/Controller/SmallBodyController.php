<?php

namespace App\Controller;

use App\Service\HorizonsClient;
use App\Service\SmallBodyPositionsClient;
use App\Service\SmallBodySearchClient;
use App\Service\SolarSystemClient;
use Psr\Cache\CacheItemPoolInterface;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;

/** Any asteroid, NEO or not (the "Suivi" tab): resolve a designation, serve its precise table. */
final class SmallBodyController extends ProxyController
{
    /**
     * Asteroids per call on /api/small-body/positions: one. Each costs a Horizons
     * table of up to 11 000 rows, and Horizons doesn't compute a batch in parallel:
     * five cold NEOs in one call took 26.8 s against PHP's 30 s wall (measured
     * 2026-10-27). The web client asks for its (up to 5) tracked objects one call
     * each, so every request stays near 7-10 s cold.
     */
    private const MAX_SPKIDS_PER_CALL = 1;

    /**
     * Name / designation → asteroid, any non-comet small body (not only NEOs,
     * hence not under /api/neo). JPL SBDB, keyless: spends no NASA quota.
     */
    #[Route('/api/small-body/search', name: 'api_small_body_search', methods: ['GET'])]
    public function smallBodySearch(
        Request $request,
        SmallBodySearchClient $client,
        #[Autowire(service: 'cache.app')] CacheItemPoolInterface $pool,
    ): JsonResponse {
        $query = SmallBodySearchClient::normalizeQuery((string) $request->query->get('q', ''));
        if ($query === null) {
            return new JsonResponse(['error' => 'q must be 1 to 40 characters: letters, digits, spaces and \' / ( ) . -'], 400);
        }

        try {
            $result = $this->cachedSmallBodySearch($query, $client, $pool);
        } catch (ExceptionInterface $e) {
            // Not cached: an outage must not turn into an hour of "not found".
            return $this->upstreamError('small-body/search', 'JPL SBDB', $e);
        }

        return new JsonResponse($result);
    }

    /**
     * @return array<string, mixed>
     *
     * @throws ExceptionInterface when SBDB is unreachable
     */
    private function cachedSmallBodySearch(string $query, SmallBodySearchClient $client, CacheItemPoolInterface $pool): array
    {
        $item = $pool->getItem(SmallBodySearchClient::cacheKey($query));
        if ($item->isHit()) {
            return $item->get();
        }
        $result = $client->search($query);
        // An object gets renumbered (SPK-ID 5xxxxxxx → 2xxxxxxx), so even a match is short-lived;
        // an unknown name may be a fresh discovery, so it is the shortest.
        $found = $result['match'] !== null || isset($result['candidates']) || isset($result['rejected']);
        $pool->save($item->set($result)->expiresAfter($found ? 86400 : 3600));

        return $result;
    }

    /**
     * Precise table for one tracked asteroid, on the planets' window
     * (so the web clock bounds line up). Outside /api/neo on purpose: any
     * asteroid, and no NASA quota — Horizons, SBDB and CAD are all keyless.
     * Cached per object; see API.md for what is deliberately not cached.
     */
    #[Route('/api/small-body/positions', name: 'api_small_body_positions', methods: ['GET'])]
    public function smallBodyPositions(
        Request $request,
        SmallBodySearchClient $search,
        SmallBodyPositionsClient $positions,
        #[Autowire(service: 'cache.app')] CacheItemPoolInterface $pool,
    ): JsonResponse {
        $spkids = array_values(array_unique(array_filter(array_map('trim', explode(',', (string) $request->query->get('spkid', ''))), static fn (string $id) => $id !== '')));
        if ($spkids === [] || count($spkids) > self::MAX_SPKIDS_PER_CALL) {
            return new JsonResponse(['error' => 'spkid must be exactly one SPK-ID: ask for each tracked asteroid in its own call'], 400);
        }
        foreach ($spkids as $spkid) {
            if (!preg_match('/^\d{7,8}$/', $spkid)) {
                return new JsonResponse(['error' => sprintf('invalid SPK-ID "%s": 7 or 8 digits expected', $spkid)], 400);
            }
        }

        $windowStart = SolarSystemClient::windowStart(new \DateTimeImmutable('now', new \DateTimeZone('UTC')));
        $start = SolarSystemClient::positionsStart($windowStart);
        $end = SolarSystemClient::windowEnd($windowStart);

        $objects = [];
        $items = [];
        $toFetch = [];
        try {
            foreach ($spkids as $spkid) {
                $item = $pool->getItem('small_body_positions_'.$spkid.'_'.$windowStart->format('Y-m-d').'_'.HorizonsClient::TIME_SCALE.'_h'.SolarSystemClient::HISTORY_MONTHS);
                if ($item->isHit()) {
                    $objects[$spkid] = $item->get();
                    continue;
                }
                $items[$spkid] = $item;
                $objects[$spkid] = null;
                // SBDB takes the SPK-ID as a search string; a comet is refused there, and is no object here.
                $match = $this->cachedSmallBodySearch($spkid, $search, $pool)['match'] ?? null;
                if (null === $match) {
                    $pool->save($item->set(null)->expiresAfter(3600));
                    continue;
                }
                $toFetch[] = ['spkid' => $spkid, 'des' => $match['des'], 'fullname' => $match['fullname'], 'neo' => true === $match['neo']];
            }
            $fetched = $toFetch === [] ? [] : $positions->getPositions($toFetch, $start, $end);
        } catch (ExceptionInterface $e) {
            return $this->upstreamError('small-body/positions', 'JPL', $e);
        }

        foreach ($fetched as $spkid => $object) {
            $objects[$spkid] = $object;
            // CAD failed for this one: served, but retried on the next call.
            if (null !== $object && null === $object['close_approaches']) {
                continue;
            }
            $pool->saveDeferred($items[$spkid]->set($object)->expiresAfter(null === $object ? 3600 : 86400));
        }
        $pool->commit();

        return new JsonResponse([
            'frame' => 'ICRF geocentric',
            'units' => 'km',
            'time_scale' => HorizonsClient::TIME_SCALE,
            'window' => ['start' => $start->getTimestamp(), 'end' => $end->getTimestamp()],
            'objects' => $objects,
        ]);
    }
}
