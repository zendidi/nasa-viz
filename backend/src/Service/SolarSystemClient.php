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
     * How many intervals one drawn orbit is cut into — so 361 samples. Note
     * this is passed to Horizons as a **unitless** STEP_SIZE, which means "this
     * many intervals between the two dates", not a duration: that is what puts
     * Neptune's 165-year orbit in a single request (see gotchas.md).
     *
     * Raised from 180 on 2026-09-29, and it cost nothing: the Horizons price is
     * per *request*, not per point, so twice the samples is the same one call and
     * about 12 ko more.
     *
     * What it buys is the chord error, which falls as 1/N². Measured over 200
     * instants as the worst miss between a planet and its own drawn line:
     *
     * | planet  | 180 intervals | 360 intervals |
     * |---------|---------------|---------------|
     * | Mars    |      32 127 km|       7 781 km|
     * | Jupiter |     113 844 km|      28 443 km|
     * | Neptune |     529 228 km|     170 850 km|
     * | Mercury |      53 230 km|      55 722 km|
     *
     * Exactly the predicted factor of 4 — except for Mercury, which does not
     * improve at all, and that is worth knowing rather than hiding. Its miss is
     * not the chord: it is its own **geocentric daily position table**. Near
     * inferior conjunction Mercury is 0,55 au away and sweeps some 4° a day
     * across the sky, where a daily step costs R·θ²/8 ≈ 50 000 km. Sharpening
     * the orbit cannot touch that; only a finer step for its *positions* would,
     * which is a different lever and a different request (see the backlog).
     *
     * A first measurement at a single instant said Mercury *worsened* from
     * 19 066 to 24 469 km. That was noise — the chord miss is zero at a sample
     * and largest mid-segment, so one reading measures where "now" happens to
     * fall. Hence the 200 instants.
     */
    public const ORBIT_INTERVALS = 360;

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
        // The Sun, served by the same route and the same cache as a planet
        // because its table has exactly the same shape: geocentric, daily, a
        // year long, renewed monthly. It is not a planet, so `planetIds()`
        // leaves it out — it has no moons and no orbit worth drawing.
        //
        // It is here at all because the web client used to compute the Sun from
        // a low-precision series working in the equinox *of date*, where the
        // scene's axes are J2000: 951 057 km (0,363°) apart in 2026, the
        // precession accumulated since J2000, and growing. That error sat under
        // the terminator, the Moon, the NEOs and the whole heliocentric view.
        'sun' => ['10', 'Sun', 696340.0, 365.256],
    ];

    public function __construct(private readonly HorizonsClient $horizons)
    {
    }

    /** @return list<string> every body this service serves a position for, the Sun included */
    public static function ids(): array
    {
        return array_keys(self::BODIES);
    }

    /**
     * @return list<string> the planets only, outward from the Sun
     *
     * Wherever the answer would be nonsense for the Sun: which bodies have moons,
     * and which have an orbit to draw.
     */
    public static function planetIds(): array
    {
        return array_values(array_filter(array_keys(self::BODIES), static fn (string $id) => 'sun' !== $id));
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

    /** The Horizons addressing id, for the routes that ask it something other than a vector table. */
    public static function horizonsId(string $id): string
    {
        return self::BODIES[$id][0];
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
     * **Heliocentric (`CENTER='500@10'`), and that is a change of 2026-09-29.**
     * It used to be geocentric, so that a client could subtract *its own* Sun
     * and have the line pass through its own planet even though that Sun was
     * wrong. The web client's Sun came from a low-precision series working in
     * the equinox of date, 951 057 km (0,363°) from DE441 in 2026 — a DE441
     * ellipse would have missed Mercury by 966 557 km, so subtracting the same
     * wrong Sun was the lesser evil (docs/agent/decisions.md, 2026-09-18).
     *
     * That trade is gone: the client now places the Sun from `?body=sun` above,
     * which is DE441 too. Both ends of the subtraction being the same series,
     * the subtraction itself is pointless — and it was never possible here
     * anyway, since these samples span a whole sidereal period (165 years for
     * Neptune) while a Sun table covers one year.
     *
     * So the curve is now DE441's true ellipse, and it passes through the planet
     * by construction rather than by cancellation. Mercury gains the 1,41 % of
     * orbital radius the old approximation cost it.
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
            HorizonsClient::centreOf('10'),
        )[$id];

        if (null === $table) {
            return null;
        }

        return ['start' => $start->getTimestamp(), 'stop' => $stop->getTimestamp(), 'positions' => $table['positions']];
    }
}
