<?php

namespace App\Controller;

use App\Service\HorizonsClient;
use App\Service\MoonClient;
use App\Service\PlanetOrientationClient;
use App\Service\SolarSystemClient;
use Psr\Cache\CacheItemPoolInterface;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;

/** The planets (and the Sun as a table): positions, orbits, orientation, moons. */
final class SolarSystemController extends ProxyController
{
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

        $year = self::yearParameter($request);
        if ($year instanceof JsonResponse) {
            return $year;
        }
        if (null !== $year) {
            return $this->positionsSlice($id, $year, $client, $pool);
        }

        $start = SolarSystemClient::windowStart(new \DateTimeImmutable('now', new \DateTimeZone('UTC')));
        // `_h<n>`: a table from before HISTORY_MONTHS started at the window, not before it.
        $key = 'solar_system_'.$id.'_'.$start->format('Y-m-d').'_'.SolarSystemClient::stepSeconds($id).'_'.HorizonsClient::TIME_SCALE.'_h'.SolarSystemClient::HISTORY_MONTHS;

        try {
            $positions = self::monthly($pool, $key, fn () => $client->getPositions([$id], $start)[$id]);
        } catch (ExceptionInterface $e) {
            return $this->upstreamError('solar-system/positions', 'JPL Horizons', $e);
        }

        return new JsonResponse([
            'frame' => 'ICRF geocentric',
            'time_scale' => HorizonsClient::TIME_SCALE,
            'units' => 'km',
            'start' => SolarSystemClient::positionsStart($start)->getTimestamp(),
            'step_seconds' => SolarSystemClient::stepSeconds($id),
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
            $item = $pool->getItem('moon_'.$id.'_'.$start->getTimestamp().'_'.MoonClient::stepSeconds($id).'_'.HorizonsClient::TIME_SCALE);

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
                    return $this->upstreamError('solar-system/moons', 'JPL Horizons', $e);
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
            'time_scale' => HorizonsClient::TIME_SCALE,
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

        $year = self::yearParameter($request);
        if ($year instanceof JsonResponse) {
            return $year;
        }
        // `year=`: epoch on 1 January of that year, one entry per body × year (lot 3, 2026-11-05).
        // The Moon's pole drifts up to 1,98° from a fixed epoch but 0,54° at most inside a year
        // restarted every 1 January; the planets' jump at the seam is ≤ 0,005°.
        $epoch = null === $year
            ? SolarSystemClient::windowStart(new \DateTimeImmutable('now', new \DateTimeZone('UTC')))
            : SolarSystemClient::yearStart($year);

        // Same shape as the positions route: the key carries the window, so
        // the TTL only has to outlive the month; a body Horizons didn't
        // answer for is retried within the hour.
        try {
            $fetch = fn () => $client->getOrientation($id, $epoch);
            $orientation = null === $year
                ? self::monthly($pool, 'solar_system_orientation_'.$id.'_'.$epoch->format('Y-m-d'), $fetch)
                : self::immutable($pool, SolarSystemClient::sliceOrientationKey($id, $year), $fetch);
        } catch (ExceptionInterface $e) {
            return $this->upstreamError('solar-system/orientation', 'JPL Horizons', $e);
        }

        return new JsonResponse(($year ? ['year' => $year] : []) + [
            'frame' => 'ICRF',
            'epoch' => $epoch->getTimestamp(),
            'bodies' => [PlanetOrientationClient::describe($id) + ($orientation ?? [
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

        $year = self::yearParameter($request);
        if ($year instanceof JsonResponse) {
            return $year;
        }
        // `year=`: one period from 1 January of that year. Drawn from the epoch of the year
        // shown, a planet leaves its line by 993 km at most inside it (Mercury; Jupiter 311),
        // where from an older epoch it strays by 352 687 km (Jupiter) to ~1,2 Mkm (Uranus)
        // outside the period — measured 2026-11-05.
        $start = null === $year
            ? SolarSystemClient::windowStart(new \DateTimeImmutable('now', new \DateTimeZone('UTC')))
            : SolarSystemClient::yearStart($year);

        try {
            $fetch = fn () => $client->getOrbit($id, $start);
            $orbit = null === $year
                ? self::monthly($pool, 'solar_system_orbit_'.$id.'_'.$start->format('Y-m-d').'_'.HorizonsClient::TIME_SCALE, $fetch)
                : self::immutable($pool, SolarSystemClient::sliceOrbitKey($id, $year), $fetch);
        } catch (ExceptionInterface $e) {
            return $this->upstreamError('solar-system/orbit', 'JPL Horizons', $e);
        }

        return new JsonResponse(($year ? ['year' => $year] : []) + [
            // Must match `SolarSystemClient::getOrbit()`'s CENTER, and the web
            // client compares this exact string before trusting a cached table
            // (`ORBIT_FRAME` in scene/planets.js). The two drifted apart once,
            // on 2026-09-29: the samples went heliocentric while this still said
            // geocentric, and a client that had cached tables from the *old*
            // server cache in between drew every planet ringed by its own
            // retrograde loops. Change the centre, change this, in one go.
            'frame' => 'ICRF heliocentric',
            'time_scale' => HorizonsClient::TIME_SCALE,
            'units' => 'km',
            'body' => SolarSystemClient::describe($id) + ['period_days' => SolarSystemClient::periodDays($id)],
            'start' => $orbit['start'] ?? $start->getTimestamp(),
            'stop' => $orbit['stop'] ?? null,
            'positions' => $orbit['positions'] ?? null,
        ]);
    }

    /**
     * `year=` of the three routes: null when absent (the monthly window answers), the year when
     * valid, a 400 when not an integer or outside [Y-1, Y+4].
     */
    private static function yearParameter(Request $request): int|JsonResponse|null
    {
        if (!$request->query->has('year')) {
            return null;
        }
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $raw = trim((string) $request->query->get('year', ''));
        if (!ctype_digit($raw) || !SolarSystemClient::isYearInRange((int) $raw, $now)) {
            [$min, $max] = SolarSystemClient::yearRange($now);

            return new JsonResponse(['error' => sprintf('year must be between %d and %d', $min, $max)], 400);
        }

        return (int) $raw;
    }

    /** One body's position slice for a civil year (lot 3, 2026-11-05): table + overlap, immutable. */
    private function positionsSlice(string $id, int $year, SolarSystemClient $client, CacheItemPoolInterface $pool): JsonResponse
    {
        try {
            $positions = self::immutable($pool, SolarSystemClient::slicePositionsKey($id, $year), fn () => $client->getSlicePositions($id, $year));
        } catch (ExceptionInterface $e) {
            return $this->upstreamError('solar-system/positions', 'JPL Horizons', $e);
        }
        $window = SolarSystemClient::sliceWindow($id, $year);

        return new JsonResponse([
            'frame' => 'ICRF geocentric',
            'time_scale' => HorizonsClient::TIME_SCALE,
            'units' => 'km',
            'year' => $year,
            'slice_start' => $window['slice_start'],
            'slice_end' => $window['slice_end'],
            'start' => $window['start'],
            'step_seconds' => $window['step_seconds'],
            'bodies' => [SolarSystemClient::describe($id) + ['positions' => $positions]],
        ]);
    }

    /**
     * The cache shape of the `year=` slices: a value never changes, so it is kept for
     * SLICE_TTL_SECONDS; a null (Horizons had nothing) for an hour. A transport failure throws
     * before anything is saved. No Cache-Control header anywhere: an immutable HTTP cache would
     * stop a client from healing itself after refusing a slice (lesson of 2026-09-29).
     *
     * @template T
     *
     * @param callable(): T $fetch
     *
     * @return T
     *
     * @throws ExceptionInterface
     */
    private static function immutable(CacheItemPoolInterface $pool, string $key, callable $fetch): mixed
    {
        $item = $pool->getItem($key);
        if ($item->isHit()) {
            return $item->get();
        }
        $value = $fetch();
        $pool->save($item->set($value)->expiresAfter(null === $value ? SolarSystemClient::NULL_TTL_SECONDS : SolarSystemClient::SLICE_TTL_SECONDS));

        return $value;
    }

    /**
     * The cache shape of the positions, orientation and orbit routes: read
     * `$key`, or fetch and store under it.
     *
     * The key already carries the window, so the set renews on the 1st
     * whatever this says; the TTL only has to outlive the month. A
     * planet Horizons didn't answer for is retried within the hour.
     *
     * @template T
     *
     * @param callable(): T $fetch
     *
     * @return T
     *
     * @throws ExceptionInterface when Horizons is unreachable — nothing is cached then
     */
    private static function monthly(CacheItemPoolInterface $pool, string $key, callable $fetch): mixed
    {
        $item = $pool->getItem($key);
        if ($item->isHit()) {
            return $item->get();
        }
        $value = $fetch();
        $pool->save($item->set($value)->expiresAfter(null === $value ? 3600 : 40 * 86400));

        return $value;
    }
}
