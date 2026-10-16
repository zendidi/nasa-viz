<?php

namespace App\Service;

use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;

/**
 * The natural satellites the scene can draw, and the sampling each one needs.
 *
 * Same split as SolarSystemClient: this owns the physics (Horizons id, radius,
 * period, orbital radius) and the sampling arithmetic; the web client owns the
 * wording and the look.
 *
 * Two things make a moon unlike a planet.
 *
 * **It is asked for around its own planet** (`CENTER='500@599'`), not around the
 * Earth. The table is then a moon-relative-to-planet vector, which is what the
 * scene wants and costs it no subtraction — and it stays correct whatever the
 * planet itself is doing.
 *
 * **It moves fast, so its table expires.** A planet gets a year at a daily step,
 * renewed monthly. A moon needs about a 45th of its period or the interpolation
 * is nonsense: measured in docs/planetes-et-lunes.md §3c, Io sampled daily lands
 * 509 065 km off — 120 % of its orbital radius, i.e. on the wrong side of
 * Jupiter. But the Horizons cost is per *request*, not per point (gotchas.md),
 * so a fine step is free in latency and only costs bytes. Hence a fixed sample
 * budget with the window derived from it — capped at a year, see
 * MAX_WINDOW_SECONDS. Fast moons come out at the budget and differ only in how
 * long their table stays valid; slow ones come out at the cap, with far fewer
 * samples.
 */
final class MoonClient
{
    /**
     * Samples per table. The window follows from it and from the step, so this
     * single number fixes both the payload (~64 ko per moon, whichever moon) and
     * the refresh cadence (fast moons often, slow moons almost never).
     */
    public const SAMPLE_BUDGET = 500;

    /**
     * Cache key of the list of planets whose moons someone has actually asked
     * for, and how long an unvisited planet stays on it.
     *
     * It exists because a PSR-6 pool cannot be enumerated: `app:solar-system:warm`
     * has no other way to know what is worth refreshing. Writing it down as
     * requests come in is also what keeps the two halves of the design honest —
     * the cache is filled **lazily** by real visits and refreshed **eagerly** by
     * the command, so nobody waits on Horizons except the very first visitor to
     * a given planet, and moons nobody looks at cost nothing at all.
     *
     * 90 days: a planet no one has centred on for a season drops off the list
     * and stops being refreshed, on its own.
     */
    public const INDEX_KEY = 'moon_index';
    public const INDEX_TTL_SECONDS = 90 * 86400;

    /**
     * Samples per orbit. 45 is the figure §3c settles on: at that rate Io's
     * interpolation error is 1 164 km, 0,275 % of its orbital radius, against
     * 120 % at a daily step.
     *
     * It also means an uncapped table covers SAMPLE_BUDGET / 45 ≈ 11 orbits — so
     * its first 46 samples *are* one full orbit, and the drawn orbit costs no
     * second request. That is why there is no getOrbit() here, unlike
     * SolarSystemClient.
     *
     * The year cap breaks that for the slowest four: Pasiphae, Phoebe, Sycorax
     * and Halimede take 2 to 5 years to go round, so a one-year table holds a
     * fraction of an orbit and no loop can be drawn from it. `coversFullOrbit()`
     * says which. Their positions are still right — only the décor is missing.
     */
    public const SAMPLES_PER_ORBIT = 45;

    /**
     * Hard cap on a window, whatever the budget would allow. Without it the
     * budget alone runs away on the slow irregulars: measured before adding it,
     * Halimede (period 1 879 d) asked for a **57-year** table starting in 1998,
     * and Sycorax a 39-year one starting in 2009. Not wrong arithmetically — 11
     * orbits is 11 orbits — but nobody needs eleven orbits of Halimede, and a
     * table whose window opened before the app existed is a smell.
     *
     * Capping costs those moons nothing and saves a lot: the step is unchanged,
     * so the interpolation is just as good, and the sample count collapses (9
     * samples for Halimede instead of 500). A year also matches the planets'
     * own window, so the two kinds of table age at the same rhythm.
     */
    private const MAX_WINDOW_SECONDS = 365 * 86400;

    /**
     * id => [Horizons id, planet id, name, mean radius km, sidereal period days,
     * mean orbital radius km]. Every Horizons id was checked one by one against
     * `horizons_lookup.api` on 2026-09-29.
     *
     * The rule, set by the user: at most 9 moons per planet — all of them when
     * there are 9 or fewer, otherwise the 9 largest. Mercury and Venus have
     * none; the Earth's Moon is absent on purpose, `web/src/astronomy.js`
     * already computes it locally and it costs no request at all.
     *
     * Retrograde irregulars (Pasiphae, Phoebe, Sycorax, Nereid, Halimede) are in
     * because the rule puts them in. They are 30 to 100 km across at millions of
     * km, so they will be pixel-floor dots — but their steeply inclined,
     * backwards orbits are true and worth seeing.
     */
    private const MOONS = [
        // Mars - both of them.
        'phobos' => ['401', 'mars', 'Phobos', 11.1, 0.31891, 9376],
        'deimos' => ['402', 'mars', 'Deimos', 6.2, 1.26244, 23458],
        // Jupiter - 9 largest of ~95.
        'ganymede' => ['503', 'jupiter', 'Ganymede', 2634.1, 7.15455, 1070400],
        'callisto' => ['504', 'jupiter', 'Callisto', 2410.3, 16.6890, 1882700],
        'io' => ['501', 'jupiter', 'Io', 1821.6, 1.769138, 421700],
        'europa' => ['502', 'jupiter', 'Europa', 1560.8, 3.551181, 671100],
        'himalia' => ['506', 'jupiter', 'Himalia', 85.0, 250.5662, 11461000],
        'amalthea' => ['505', 'jupiter', 'Amalthea', 83.5, 0.498179, 181400],
        'thebe' => ['514', 'jupiter', 'Thebe', 49.3, 0.674536, 221900],
        'elara' => ['507', 'jupiter', 'Elara', 43.0, 259.6528, 11741000],
        'pasiphae' => ['508', 'jupiter', 'Pasiphae', 30.0, 743.6, 23624000],
        // Saturn - 9 largest of ~274.
        'titan' => ['606', 'saturn', 'Titan', 2574.7, 15.945, 1221870],
        'rhea' => ['605', 'saturn', 'Rhea', 763.8, 4.518212, 527070],
        'iapetus' => ['608', 'saturn', 'Iapetus', 734.5, 79.3215, 3560800],
        'dione' => ['604', 'saturn', 'Dione', 561.4, 2.736915, 377420],
        'tethys' => ['603', 'saturn', 'Tethys', 531.1, 1.887802, 294670],
        'enceladus' => ['602', 'saturn', 'Enceladus', 252.1, 1.370218, 238040],
        'mimas' => ['601', 'saturn', 'Mimas', 198.2, 0.9424218, 185540],
        'hyperion' => ['607', 'saturn', 'Hyperion', 135.0, 21.2766, 1500880],
        'phoebe' => ['609', 'saturn', 'Phoebe', 106.5, 550.31, 12947900],
        // Uranus - 9 largest of ~28.
        'titania' => ['703', 'uranus', 'Titania', 788.9, 8.706234, 436300],
        'oberon' => ['704', 'uranus', 'Oberon', 761.4, 13.463234, 583500],
        'umbriel' => ['702', 'uranus', 'Umbriel', 584.7, 4.144177, 266000],
        'ariel' => ['701', 'uranus', 'Ariel', 578.9, 2.520379, 190900],
        'miranda' => ['705', 'uranus', 'Miranda', 235.8, 1.413479, 129900],
        'puck' => ['715', 'uranus', 'Puck', 81.0, 0.761833, 86010],
        'sycorax' => ['717', 'uranus', 'Sycorax', 75.0, 1288.3, 12179000],
        'portia' => ['712', 'uranus', 'Portia', 67.5, 0.513196, 66100],
        'juliet' => ['711', 'uranus', 'Juliet', 46.8, 0.493066, 64360],
        // Neptune - 9 largest of ~16.
        'triton' => ['801', 'neptune', 'Triton', 1352.6, 5.876854, 354759],
        'proteus' => ['808', 'neptune', 'Proteus', 210.0, 1.122315, 117646],
        'nereid' => ['802', 'neptune', 'Nereid', 170.0, 360.13619, 5513800],
        'larissa' => ['807', 'neptune', 'Larissa', 97.0, 0.554654, 73548],
        'galatea' => ['806', 'neptune', 'Galatea', 87.5, 0.428745, 61953],
        'despina' => ['805', 'neptune', 'Despina', 75.0, 0.334656, 52526],
        'thalassa' => ['804', 'neptune', 'Thalassa', 40.7, 0.311485, 50075],
        'naiad' => ['803', 'neptune', 'Naiad', 33.0, 0.294396, 48227],
        'halimede' => ['809', 'neptune', 'Halimede', 31.0, 1879.08, 16611000],
        // Pluto - Charon only; Nix, Hydra, Kerberos, Styx are 5 to 20 km.
        'charon' => ['901', 'pluto', 'Charon', 606.0, 6.387, 19591],
    ];

    /** Horizons id of each planet a moon can belong to — its CENTER. */
    private const PLANET_HORIZONS_ID = [
        'mars' => '499',
        'jupiter' => '599',
        'saturn' => '699',
        'uranus' => '799',
        'neptune' => '899',
        'pluto' => '999',
    ];

    public function __construct(private readonly HorizonsClient $horizons)
    {
    }

    /** @return list<string> the moons of one planet, largest first; empty for Mercury, Venus, Earth */
    public static function forPlanet(string $planetId): array
    {
        $ids = [];
        foreach (self::MOONS as $id => [, $planet]) {
            if ($planet === $planetId) {
                $ids[] = $id;
            }
        }

        return $ids;
    }

    public static function isKnown(string $id): bool
    {
        return isset(self::MOONS[$id]);
    }

    /** @return array{id: string, planet: string, name: string, radius_km: float, orbit_km: int} */
    public static function describe(string $id): array
    {
        [, $planet, $name, $radiusKm, , $orbitKm] = self::MOONS[$id];

        return ['id' => $id, 'planet' => $planet, 'name' => $name, 'radius_km' => $radiusKm, 'orbit_km' => $orbitKm];
    }

    /**
     * Seconds between samples: a 45th of the period, rounded to whole minutes
     * because Horizons' STEP_SIZE reads minutes and nothing finer. Floored at one
     * minute — Naiad, the fastest here at 7,07 h, still asks for 9.
     */
    public static function stepSeconds(string $id): int
    {
        $minutes = max(1, (int) round(self::MOONS[$id][4] * 86400 / self::SAMPLES_PER_ORBIT / 60));

        return $minutes * 60;
    }

    /**
     * How long one table spans: the sample budget, or a year, whichever is
     * shorter. Fast moons are budget-bound (Phobos 3,5 d), slow ones are
     * year-bound (Halimede, Sycorax, Phoebe, Nereid, and Jupiter's outer three).
     */
    public static function windowSeconds(string $id): int
    {
        return min(self::stepSeconds($id) * (self::SAMPLE_BUDGET - 1), self::MAX_WINDOW_SECONDS);
    }

    /** Samples a table actually carries — at most SAMPLE_BUDGET, fewer once capped. */
    public static function sampleCount(string $id): int
    {
        return intdiv(self::windowSeconds($id), self::stepSeconds($id)) + 1;
    }

    /**
     * Whether one table spans a whole orbit, i.e. whether a closed loop can be
     * drawn from it. True for 35 of the 39; false for Pasiphae, Phoebe, Sycorax
     * and Halimede, whose periods (2 to 5 years) outrun the one-year cap.
     */
    public static function coversFullOrbit(string $id): bool
    {
        return self::windowSeconds($id) >= self::MOONS[$id][4] * 86400;
    }

    /** Samples spanning exactly one orbit, for the drawn loop. Meaningless unless coversFullOrbit(). */
    public static function orbitSampleCount(string $id): int
    {
        return min(self::sampleCount($id), self::SAMPLES_PER_ORBIT + 1);
    }

    /**
     * Start of the window covering `$now`, bucketed so every visitor shares one
     * table (the same trick as SolarSystemClient's first-of-the-month, but per
     * moon since the windows differ).
     *
     * The bucket is **half** the window, and that is the whole point: `$now`
     * then always sits in the first half, so a table handed out is guaranteed at
     * least half a window of remaining validity. Bucketing on the full window
     * would hand someone a table expiring in a minute.
     */
    public static function windowStart(string $id, \DateTimeImmutable $now): \DateTimeImmutable
    {
        $bucket = max(60, intdiv(self::windowSeconds($id), 2));
        $start = intdiv($now->getTimestamp(), $bucket) * $bucket;

        return (new \DateTimeImmutable('@'.$start))->setTimezone(new \DateTimeZone('UTC'));
    }

    /**
     * One moon's table, relative to its own planet.
     *
     * @return array{start: int, step_seconds: int, positions: list<array{int, int, int}>}|null
     *
     * @throws ExceptionInterface on transport failure
     */
    public function getPositions(string $id, \DateTimeImmutable $start): ?array
    {
        [$horizonsId, $planet] = self::MOONS[$id];
        $step = self::stepSeconds($id);

        $table = $this->horizons->getMajorBodyVectors(
            [$id => $horizonsId],
            $start,
            $start->modify(sprintf('+%d seconds', self::windowSeconds($id))),
            sprintf('%dm', intdiv($step, 60)),
            HorizonsClient::centreOf(self::PLANET_HORIZONS_ID[$planet]),
        )[$id];

        if (null === $table) {
            return null;
        }

        return ['start' => $start->getTimestamp(), 'step_seconds' => $step, 'positions' => $table['positions']];
    }
}
