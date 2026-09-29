<?php

namespace App\Controller;

use App\Service\HorizonsClient;
use App\Service\IssPositionClient;
use App\Service\MoonClient;
use App\Service\NasaApiClient;
use App\Service\NasaUsageTracker;
use App\Service\NeoFeedBuilder;
use App\Service\PlanetOrientationClient;
use App\Service\SmallBodyDetailsClient;
use App\Service\SolarSystemClient;
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

    /**
     * One planet, as a geocentric table covering a year from the first of the
     * current UTC month — the shared clock every planet's table is on, so a
     * client fetching them one at a time still reads them against one clock.
     *
     * One body per call, and for a measured reason (2026-09-22, see
     * docs/agent/gotchas.md): a Horizons ephemeris request costs 5 to 16 s
     * whatever its size, and this machine's NativeHttpClient barely
     * parallelises — two planets at once already overran PHP's 30 s limit
     * (Saturn + Uranus: 31,6 s → HTTP 500). Asking one at a time also keeps
     * the single-threaded dev server answering the ISS and the NEO feed in
     * between, and lets the scene fill in planet by planet. The response
     * still carries a `bodies` list so serving several stays possible without
     * a contract change.
     */
    #[Route('/api/solar-system/positions', name: 'api_solar_system_positions', methods: ['GET'])]
    public function solarSystemPositions(
        Request $request,
        SolarSystemClient $client,
        #[Autowire(service: 'cache.app')] CacheItemPoolInterface $pool,
    ): JsonResponse {
        $id = trim((string) $request->query->get('body', ''));
        if (!SolarSystemClient::isKnown($id)) {
            return new JsonResponse(['error' => sprintf('body must be one of %s', implode(', ', SolarSystemClient::ids()))], 400);
        }

        $start = SolarSystemClient::windowStart(new \DateTimeImmutable('now', new \DateTimeZone('UTC')));
        $item = $pool->getItem('solar_system_'.$id.'_'.$start->format('Y-m-d'));

        if ($item->isHit()) {
            $positions = $item->get();
        } else {
            try {
                $positions = $client->getPositions([$id], $start)[$id];
            } catch (ExceptionInterface $e) {
                return $this->upstreamError('solar-system/positions', $e);
            }
            // The key already carries the window, so the set renews on the 1st
            // whatever this says; the TTL only has to outlive the month. A
            // planet Horizons didn't answer for is retried within the hour.
            $pool->save($item->set($positions)->expiresAfter(null === $positions ? 3600 : 40 * 86400));
        }

        return new JsonResponse([
            'frame' => 'ICRF geocentric',
            'units' => 'km',
            'start' => $start->getTimestamp(),
            'step_seconds' => SolarSystemClient::STEP_SECONDS,
            'bodies' => [SolarSystemClient::describe($id) + ['positions' => $positions]],
        ]);
    }

    /**
     * Every moon of one planet, in one call — and that is the whole difference
     * with the two planet routes above.
     *
     * A planet is served one body per call because each call may have to reach
     * Horizons, and two bodies at once already overran PHP's 30 s limit
     * (gotchas.md). A moon is served nine at a time because this route **fetches
     * at most one missing moon per call** and serves everything else from cache.
     * So the worst case is still exactly one Horizons request inside the 30 s,
     * while the steady state — the only state a visitor ever sees once
     * `app:solar-system:warm` has run — is a single call returning all nine.
     *
     * The client loops while `missing` is non-zero. Cold that is one call per
     * moon, exactly like the planets; warm it is one call, full stop.
     *
     * Positions are relative to the **planet**, not the Earth (CENTER='500@599'),
     * so the client places a moon by adding its planet's own position and needs
     * no frame conversion.
     */
    #[Route('/api/solar-system/moons', name: 'api_solar_system_moons', methods: ['GET'])]
    public function solarSystemMoons(
        Request $request,
        MoonClient $client,
        #[Autowire(service: 'cache.app')] CacheItemPoolInterface $pool,
    ): JsonResponse {
        $planet = trim((string) $request->query->get('planet', ''));
        if (!in_array($planet, SolarSystemClient::planetIds(), true)) {
            return new JsonResponse(['error' => sprintf('planet must be one of %s', implode(', ', SolarSystemClient::planetIds()))], 400);
        }

        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $moons = [];
        $missing = 0;
        $fetched = false;

        foreach (MoonClient::forPlanet($planet) as $id) {
            $start = MoonClient::windowStart($id, $now);
            $item = $pool->getItem('moon_'.$id.'_'.$start->getTimestamp());

            if ($item->isHit()) {
                $table = $item->get();
            } elseif ($fetched) {
                // One Horizons request per call, no more: the next call takes
                // the next one. Counted as missing so the client comes back.
                ++$missing;
                continue;
            } else {
                $fetched = true;
                try {
                    $table = $client->getPositions($id, $start);
                } catch (ExceptionInterface $e) {
                    return $this->upstreamError('solar-system/moons', $e);
                }
                // The key carries the window, so a table renews when its bucket
                // rolls over whatever this says; the TTL only has to outlive it.
                // A moon Horizons didn't answer for is retried within the hour.
                $pool->save($item->set($table)->expiresAfter(null === $table ? 3600 : MoonClient::windowSeconds($id) + 86400));
            }

            if (null === $table) {
                ++$missing;
                continue;
            }

            $moons[] = MoonClient::describe($id) + [
                'start' => $table['start'],
                'step_seconds' => $table['step_seconds'],
                'covers_full_orbit' => MoonClient::coversFullOrbit($id),
                'orbit_samples' => MoonClient::coversFullOrbit($id) ? MoonClient::orbitSampleCount($id) : null,
                'positions' => $table['positions'],
            ];
        }

        // Record that someone actually looked at this planet's moons, so
        // `app:solar-system:warm` knows what to keep fresh. A PSR-6 pool cannot
        // be enumerated, so "what is in the cache" has to be written down as it
        // happens — and this is the lazy half of the design: nothing is ever
        // refreshed until a visitor has asked for it once.
        $index = $pool->getItem(MoonClient::INDEX_KEY);
        $seen = $index->isHit() ? $index->get() : [];
        $seen[$planet] = time();
        $pool->save($index->set($seen)->expiresAfter(MoonClient::INDEX_TTL_SECONDS));

        return new JsonResponse([
            'frame' => 'ICRF, centred on the planet',
            'units' => 'km',
            'planet' => $planet,
            // Non-zero means "call me again": either a moon is still unfetched,
            // or Horizons had nothing for it this time.
            'missing' => $missing,
            'moons' => $moons,
        ]);
    }

    /**
     * How one planet is turned in space, as two ICRF unit vectors and a rate.
     *
     * Same window anchor, same cache shape and the same one-body-per-call rule
     * as the two routes above — but for a different reason. There, one body per
     * call is about time: a Horizons request costs 5 to 16 s and two at once
     * overran PHP's limit. Here a body costs **one request a month** and the
     * answer is seven numbers, so the rule is kept only for consistency with the
     * client's existing per-planet loop.
     *
     * `prime_meridian` is where the body's zero of longitude pointed at `epoch`.
     * To turn the body at time t, rotate that vector about `pole` by
     * `rotation_deg_per_day * (t - epoch, in days)`. The rate is **signed**:
     * negative for Venus and Uranus, which turn backwards.
     *
     * Two vectors rather than the angles Horizons publishes, and that is this
     * contract's one real opinion: the sign of the longitude and the light-time
     * correction are the two things easy to get wrong here, the second is worth
     * 30 degrees on Jupiter and 55 on Uranus, and neither should have to be
     * rediscovered by every client. PlanetOrientationClient says how both are
     * handled, and its test checks the result against Horizons itself.
     */
    #[Route('/api/solar-system/orientation', name: 'api_solar_system_orientation', methods: ['GET'])]
    public function solarSystemOrientation(
        Request $request,
        PlanetOrientationClient $client,
        #[Autowire(service: 'cache.app')] CacheItemPoolInterface $pool,
    ): JsonResponse {
        $id = trim((string) $request->query->get('body', ''));
        // Planets only. The Sun has no prime meridian worth drawing with — it is
        // not a rigid body, its surface rotates differentially — and the Moon
        // belongs to the moons route.
        if (!PlanetOrientationClient::isKnown($id)) {
            return new JsonResponse(['error' => sprintf('body must be one of %s', implode(', ', PlanetOrientationClient::ids()))], 400);
        }

        $epoch = SolarSystemClient::windowStart(new \DateTimeImmutable('now', new \DateTimeZone('UTC')));
        $item = $pool->getItem('solar_system_orientation_'.$id.'_'.$epoch->format('Y-m-d'));

        if ($item->isHit()) {
            $orientation = $item->get();
        } else {
            try {
                $orientation = $client->getOrientation($id, $epoch);
            } catch (ExceptionInterface $e) {
                return $this->upstreamError('solar-system/orientation', $e);
            }
            // Same shape as the positions route: the key carries the window, so
            // the TTL only has to outlive the month; a body Horizons didn't
            // answer for is retried within the hour.
            $pool->save($item->set($orientation)->expiresAfter(null === $orientation ? 3600 : 40 * 86400));
        }

        return new JsonResponse([
            'frame' => 'ICRF',
            'epoch' => $epoch->getTimestamp(),
            'bodies' => [SolarSystemClient::describe($id) + ($orientation ?? [
                'pole' => null,
                'prime_meridian' => null,
                'rotation_deg_per_day' => null,
            ])],
        ]);
    }

    /**
     * One planet's whole orbit, as a polyline. Same window anchor and the same
     * one-body-per-call rule as the positions route above; see
     * SolarSystemClient::getOrbit() for why the samples are geocentric rather
     * than heliocentric.
     *
     * The anchor matters more here than it looks: the curve covers exactly one
     * sidereal period from `start`, and "now" has to fall inside it for the
     * planet to sit on the line. A monthly anchor guarantees that — "now" is
     * at most 31 days past the start, and the shortest period is Mercury's 88
     * days.
     */
    #[Route('/api/solar-system/orbit', name: 'api_solar_system_orbit', methods: ['GET'])]
    public function solarSystemOrbit(
        Request $request,
        SolarSystemClient $client,
        #[Autowire(service: 'cache.app')] CacheItemPoolInterface $pool,
    ): JsonResponse {
        $id = trim((string) $request->query->get('body', ''));
        // Planets only: the Sun is served by the positions route but has no
        // orbit of its own to draw here.
        if (!in_array($id, SolarSystemClient::planetIds(), true)) {
            return new JsonResponse(['error' => sprintf('body must be one of %s', implode(', ', SolarSystemClient::planetIds()))], 400);
        }

        $start = SolarSystemClient::windowStart(new \DateTimeImmutable('now', new \DateTimeZone('UTC')));
        $item = $pool->getItem('solar_system_orbit_'.$id.'_'.$start->format('Y-m-d'));

        if ($item->isHit()) {
            $orbit = $item->get();
        } else {
            try {
                $orbit = $client->getOrbit($id, $start);
            } catch (ExceptionInterface $e) {
                return $this->upstreamError('solar-system/orbit', $e);
            }
            $pool->save($item->set($orbit)->expiresAfter(null === $orbit ? 3600 : 40 * 86400));
        }

        return new JsonResponse([
            // Must match `SolarSystemClient::getOrbit()`'s CENTER, and the web
            // client compares this exact string before trusting a cached table
            // (`ORBIT_FRAME` in scene/planets.js). The two drifted apart once,
            // on 2026-09-29: the samples went heliocentric while this still said
            // geocentric, and a client that had cached tables from the *old*
            // server cache in between drew every planet ringed by its own
            // retrograde loops. Change the centre, change this, in one go.
            'frame' => 'ICRF heliocentric',
            'units' => 'km',
            'body' => SolarSystemClient::describe($id) + ['period_days' => SolarSystemClient::periodDays($id)],
            'start' => $orbit['start'] ?? $start->getTimestamp(),
            'stop' => $orbit['stop'] ?? null,
            'positions' => $orbit['positions'] ?? null,
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
