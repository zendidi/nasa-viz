<?php

namespace App\Service;

use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;

/**
 * The planets of the solar system, as geocentric position tables from JPL
 * Horizons (keyless, outside the api.nasa.gov quota).
 *
 * A fixed body set, unlike /api/neo/positions: there are eight planets and a
 * client can only pick from them, so no designation here is ever user input.
 *
 * Three things are deliberately hard-coded rather than read from Horizons:
 *
 * - **The Horizons ids.** '499' is Mars, '599' is Jupiter — the body centre,
 *   not the system barycentre (which would be '4' and '5'). They belong to
 *   Horizons' addressing scheme, not to data that changes.
 * - **The mean radii** (IAU 2015). `OBJ_DATA=YES` would return them, but as
 *   free-form text: a parser for numbers that don't move costs more than the
 *   table below, which cites the same source Horizons does. They travel in
 *   the response so every client (the web viewer, Unity later) sizes a planet
 *   from one table instead of each keeping its own.
 * - **The window.** It starts on the first of the current UTC month, so every
 *   body shares one clock even when their tables were fetched days apart, and
 *   the whole set renews monthly — the refresh cadence docs/planetes-et-lunes.md
 *   prescribes, expressed as a cache key rather than as a TTL.
 *
 * The Earth is absent on purpose: it is this frame's origin, so its table
 * would be 366 zeroes. A client centred on something else already places it
 * from the Sun position it computes locally.
 */
final class SolarSystemClient
{
    /**
     * Daily step over a year. Measured on Mars (docs/planetes-et-lunes.md §3c):
     * interpolating a daily table costs at most 5 645 km, 0,002 % of its
     * distance — invisible except sitting next to the planet at true scale.
     * STEP_SIZE and STEP_SECONDS say the same thing twice, once in Horizons'
     * spelling and once in the contract's; they must stay in step.
     */
    public const STEP_SECONDS = 86400;
    private const STEP_SIZE = '1d';
    private const WINDOW_DAYS = 365;

    /**
     * How many intervals one drawn orbit is cut into — so 181 samples. Note
     * this is passed to Horizons as a **unitless** STEP_SIZE, which means "this
     * many intervals between the two dates", not a duration: that is what puts
     * Neptune's 165-year orbit in a single request (see gotchas.md).
     *
     * 180 intervals is 2° of arc per segment. Replacing that arc by a chord
     * costs R·θ²/8 — 0,015 % of the orbital radius, under a thousandth of a
     * scene unit. It is also already `EARTH_ORBIT_SAMPLES` in the web client.
     */
    public const ORBIT_INTERVALS = 180;

    /**
     * id => [Horizons id, IAU name, mean radius km, sidereal period days].
     * Order = the one responses keep: outward from the Sun.
     */
    private const BODIES = [
        'mercury' => ['199', 'Mercury', 2439.7, 87.969],
        'venus' => ['299', 'Venus', 6051.8, 224.701],
        'mars' => ['499', 'Mars', 3389.5, 686.980],
        'jupiter' => ['599', 'Jupiter', 69911.0, 4332.589],
        'saturn' => ['699', 'Saturn', 58232.0, 10759.22],
        'uranus' => ['799', 'Uranus', 25362.0, 30685.4],
        'neptune' => ['899', 'Neptune', 24622.0, 60189.0],
    ];

    public function __construct(private readonly HorizonsClient $horizons)
    {
    }

    /** @return list<string> every planet this service knows, outward from the Sun */
    public static function ids(): array
    {
        return array_keys(self::BODIES);
    }

    public static function isKnown(string $id): bool
    {
        return isset(self::BODIES[$id]);
    }

    /** @return array{id: string, name: string, radius_km: float} the constants a client needs to draw it */
    public static function describe(string $id): array
    {
        [, $name, $radiusKm] = self::BODIES[$id];

        return ['id' => $id, 'name' => $name, 'radius_km' => $radiusKm];
    }

    public static function periodDays(string $id): float
    {
        return self::BODIES[$id][3];
    }

    /**
     * The window every table shares: the first of the current UTC month. A
     * body fetched today and one fetched three weeks from now still line up
     * sample for sample, which is what lets the tables be cached one body at
     * a time yet be read against a single clock.
     */
    public static function windowStart(\DateTimeImmutable $now): \DateTimeImmutable
    {
        return $now->setTimezone(new \DateTimeZone('UTC'))->modify('first day of this month')->setTime(0, 0);
    }

    /**
     * One table per requested planet, all on the window's clock. A null entry
     * means Horizons didn't answer for that body — a reason to keep it
     * briefly, not to fail the others.
     *
     * @param list<string> $ids
     *
     * @return array<string, list<array{int, int, int}>|null>
     *
     * @throws ExceptionInterface on transport failure (nothing is known about any planet then)
     */
    public function getPositions(array $ids, \DateTimeImmutable $start): array
    {
        $commands = [];
        foreach ($ids as $id) {
            $commands[$id] = self::BODIES[$id][0];
        }

        $tables = $this->horizons->getMajorBodyVectors(
            $commands,
            $start,
            $start->modify(sprintf('+%d days', self::WINDOW_DAYS)),
            self::STEP_SIZE,
        );

        return array_map(static fn (?array $table) => $table['positions'] ?? null, $tables);
    }

    /**
     * One planet's whole orbit, as ORBIT_INTERVALS + 1 samples over one
     * sidereal period — a drawing, not a clock (see the "placer un corps ≠
     * tracer son orbite" table in docs/planetes-et-lunes.md §3c).
     *
     * **Geocentric, like getPositions(), and that is the point.** Asking
     * Horizons for the heliocentric orbit directly would give a cleaner curve
     * in DE441's frame — but the scene builds its heliocentric view as
     * `geocentric − Sun`, and its Sun comes from the low-precision series in
     * `web/src/astronomy.js`, which works in the equinox **of date** where the
     * scene's axes are J2000. Measured 2026-09-22: that is 951 057 km (0,363°)
     * away from DE441, growing to 6 995 236 km (2,668°) by 2191 — exactly the
     * accumulated precession, 50,3″/an. A DE441 ellipse would therefore miss
     * its own planet by ~951 000 km, which is the mistake
     * `docs/agent/decisions.md` (2026-09-18) already forbade once.
     *
     * So the client subtracts the very same Sun it places the planet with, and
     * the line passes through the body by construction. That needs each
     * sample's date, hence `stop` in the response: sample k is at
     * `start + k/ORBIT_INTERVALS × (stop − start)`.
     *
     * @return array{start: int, stop: int, positions: list<array{int, int, int}>}|null
     *
     * @throws ExceptionInterface on transport failure
     */
    public function getOrbit(string $id, \DateTimeImmutable $start): ?array
    {
        // Truncated to the minute *here*, not on the way out: Horizons only
        // reads minutes, so sending one value and reporting another would
        // shift every sample's date by up to a minute against the Sun the
        // client subtracts from it. One value, used and returned.
        $stop = $start->modify(sprintf('+%d seconds', (int) round(self::periodDays($id) * 86400)));
        $stop = $stop->setTime((int) $stop->format('G'), (int) $stop->format('i'));

        $table = $this->horizons->getMajorBodyVectors(
            [$id => self::BODIES[$id][0]],
            $start,
            $stop,
            (string) self::ORBIT_INTERVALS,
        )[$id];

        if (null === $table) {
            return null;
        }

        return ['start' => $start->getTimestamp(), 'stop' => $stop->getTimestamp(), 'positions' => $table['positions']];
    }
}
