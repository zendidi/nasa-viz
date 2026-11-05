<?php

namespace App\Controller;

use App\Service\HorizonsClient;
use App\Service\SmallBodyPositionsClient;
use App\Service\SmallBodySearchClient;
use App\Service\SmallBodyTrajectoryClient;
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
     * Replaced by trajectory + precision (lot 2, 2026-11-05), kept for compatibility.
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

    /** One SPK-ID from the query, or the 400 to send back. Same rule as positions. */
    private function spkidParameter(Request $request): string|JsonResponse
    {
        $spkid = trim((string) $request->query->get('spkid', ''));
        if ('' === $spkid || str_contains($spkid, ',')) {
            return new JsonResponse(['error' => 'spkid must be exactly one SPK-ID: ask for each tracked asteroid in its own call'], 400);
        }
        if (!preg_match('/^\d{7,8}$/', $spkid)) {
            return new JsonResponse(['error' => sprintf('invalid SPK-ID "%s": 7 or 8 digits expected', $spkid)], 400);
        }

        return $spkid;
    }

    /**
     * Daily geocentric table of one tracked asteroid over six fixed calendar
     * years (Y-1 to Y+5, Y the current UTC year), with the NEO's close
     * approaches. Any asteroid; a tracked object may also be a NEO. Not the
     * "NEO of the week" of /api/neo. Keyless: no NASA quota.
     */
    #[Route('/api/small-body/trajectory', name: 'api_small_body_trajectory', methods: ['GET'])]
    public function smallBodyTrajectory(
        Request $request,
        SmallBodySearchClient $search,
        SmallBodyTrajectoryClient $trajectory,
        #[Autowire(service: 'cache.app')] CacheItemPoolInterface $pool,
    ): JsonResponse {
        $spkid = $this->spkidParameter($request);
        if ($spkid instanceof JsonResponse) {
            return $spkid;
        }
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $range = SmallBodyTrajectoryClient::trajectoryRange($now);
        $anchor = SmallBodyTrajectoryClient::anchorYear($now);

        try {
            $object = $this->cachedObject(
                $spkid,
                $search,
                $pool,
                static fn (?string $orbitId) => SmallBodyTrajectoryClient::cacheKey('trajectory', $spkid, $anchor, $orbitId),
                static fn (array $body) => $trajectory->getTrajectory($body, $range),
                static fn (array $object) => null !== $object['close_approaches'],
            );
        } catch (ExceptionInterface $e) {
            return $this->upstreamError('small-body/trajectory', 'JPL', $e);
        }

        return new JsonResponse([
            'frame' => 'ICRF geocentric',
            'units' => 'km',
            'time_scale' => HorizonsClient::TIME_SCALE,
            'range' => ['start' => $range['start']->getTimestamp(), 'end' => $range['end']->getTimestamp()],
            'objects' => [$spkid => $object],
        ]);
    }

    /**
     * Hourly table of one NEO for one calendar year, plus 5-minute segments
     * around its very close passes of that year. The client swaps it in for
     * the daily table as the clock enters that year.
     */
    #[Route('/api/small-body/precision', name: 'api_small_body_precision', methods: ['GET'])]
    public function smallBodyPrecision(
        Request $request,
        SmallBodySearchClient $search,
        SmallBodyTrajectoryClient $trajectory,
        #[Autowire(service: 'cache.app')] CacheItemPoolInterface $pool,
    ): JsonResponse {
        $spkid = $this->spkidParameter($request);
        if ($spkid instanceof JsonResponse) {
            return $spkid;
        }
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $anchor = SmallBodyTrajectoryClient::anchorYear($now);
        $rawYear = trim((string) $request->query->get('year', ''));
        if (!ctype_digit($rawYear) || !SmallBodyTrajectoryClient::isYearInRange((int) $rawYear, $now)) {
            return new JsonResponse(['error' => sprintf('year must be a calendar year from %d to %d', $anchor - SmallBodyTrajectoryClient::YEARS_BEFORE, $anchor + SmallBodyTrajectoryClient::YEARS_AFTER)], 400);
        }
        $year = (int) $rawYear;

        try {
            $object = $this->cachedObject(
                $spkid,
                $search,
                $pool,
                static fn (?string $orbitId) => SmallBodyTrajectoryClient::cacheKey('precision', $spkid, $year, $orbitId),
                static fn (array $body) => $trajectory->getPrecision($body, $year),
                static fn (array $object) => null !== $object['segments'],
            );
        } catch (ExceptionInterface $e) {
            return $this->upstreamError('small-body/precision', 'JPL', $e);
        }

        return new JsonResponse([
            'frame' => 'ICRF geocentric',
            'units' => 'km',
            'time_scale' => HorizonsClient::TIME_SCALE,
            'year' => $year,
            'objects' => [$spkid => $object],
        ]);
    }

    /**
     * The Sun's daily geocentric table over the trajectory range: lets the web
     * go heliocentric and place the Earth at an object's instant. The path is a
     * distinct literal from /trajectory, so neither swallows the other.
     */
    #[Route('/api/small-body/trajectory/sun', name: 'api_small_body_trajectory_sun', methods: ['GET'])]
    public function smallBodyTrajectorySun(
        SmallBodyTrajectoryClient $trajectory,
        #[Autowire(service: 'cache.app')] CacheItemPoolInterface $pool,
    ): JsonResponse {
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $range = SmallBodyTrajectoryClient::trajectoryRange($now);

        $item = $pool->getItem(SmallBodyTrajectoryClient::sunCacheKey(SmallBodyTrajectoryClient::anchorYear($now)));
        if ($item->isHit()) {
            $table = $item->get();
        } else {
            try {
                $table = $trajectory->getSun($range);
            } catch (ExceptionInterface $e) {
                return $this->upstreamError('small-body/trajectory/sun', 'JPL Horizons', $e);
            }
            $pool->save($item->set($table)->expiresAfter(SmallBodyTrajectoryClient::TTL_SECONDS));
        }

        return new JsonResponse([
            'frame' => 'ICRF geocentric',
            'units' => 'km',
            'time_scale' => HorizonsClient::TIME_SCALE,
            'range' => ['start' => $range['start']->getTimestamp(), 'end' => $range['end']->getTimestamp()],
            'table' => $table,
        ]);
    }

    /**
     * Resolve (SBDB, cached 1 day), then read or fill the object's own cache entry.
     * The key needs the `orbit_id`, which only the resolution gives. Null when SBDB
     * doesn't know the id or Horizons has no table (an hour). An object for which
     * `$complete` says false (CAD failed) is served but not cached.
     *
     * @param \Closure(?string): string $key
     * @param \Closure(array{spkid: string, des: ?string, fullname: ?string, neo: bool, orbit_id: ?string}): ?array<string, mixed> $fetch
     * @param \Closure(array<string, mixed>): bool $complete
     *
     * @return array<string, mixed>|null
     *
     * @throws ExceptionInterface when SBDB or Horizons is unreachable
     */
    private function cachedObject(string $spkid, SmallBodySearchClient $search, CacheItemPoolInterface $pool, \Closure $key, \Closure $fetch, \Closure $complete): ?array
    {
        // SBDB takes the SPK-ID as a search string; a comet is refused there, and is no object here.
        $match = $this->cachedSmallBodySearch($spkid, $search, $pool)['match'] ?? null;
        if (null === $match) {
            return null; // the search cache already holds the "unknown" for an hour
        }
        $orbitId = $match['orbit_id'] ?? null;
        $item = $pool->getItem($key($orbitId));
        if ($item->isHit()) {
            return $item->get();
        }

        $object = $fetch(['spkid' => $spkid, 'des' => $match['des'], 'fullname' => $match['fullname'], 'neo' => true === $match['neo'], 'orbit_id' => $orbitId]);
        if (null === $object || $complete($object)) {
            $pool->save($item->set($object)->expiresAfter(SmallBodyTrajectoryClient::ttlSeconds($orbitId, null === $object)));
        }

        return $object;
    }
}
