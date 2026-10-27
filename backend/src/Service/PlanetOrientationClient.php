<?php

namespace App\Service;

use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;

/**
 * How a planet is turned in space: where its north pole points, and where its
 * prime meridian is at a known instant.
 *
 * Serves two ICRF unit vectors per body — the pole and the prime meridian at
 * the window's start — plus the signed rotation rate. A client turns the body
 * at time t by rotating the meridian vector about the pole by `rate * days`;
 * nothing else is needed, and in particular no convention has to be agreed
 * between the two sides beyond "these are ICRF unit vectors".
 *
 * That is deliberate. Serving raw angles (pole RA/Dec and a longitude) would
 * push onto every client the two things genuinely easy to get wrong here — the
 * sign of the longitude, and the light-time correction — and one of them is
 * worth 30 degrees on Jupiter.
 *
 * ## Why Horizons is asked once, for one instant
 *
 * The pole barely moves: Mars's N.Pole-RA went 317.65213 to 317.65208 over 40
 * days, five units in the fifth decimal. The phase, by contrast, moves at up to
 * 870 deg/day, which no sampled table could ever carry — Jupiter turns 2,4
 * times between two daily samples. So the pole is taken as fixed over a month
 * and the phase is *propagated*, which is exact rather than approximate: a
 * rigid body turns at a constant rate about a fixed axis.
 *
 * Checked against Horizons over 40 days on Mars, Venus, Uranus and Jupiter
 * (prograde and retrograde, slow and fast): the reconstruction reproduces
 * `ObsSub-LON` to 1e-5 degree. See docs/planetes-et-lunes.md, lot 5 step 4.
 */
final class PlanetOrientationClient
{
    private const AU_KM = 149597870.700;
    private const C_KM_S = 299792.458;

    /**
     * IAU 2015 sidereal rotation rate, degrees per day, **signed**: positive
     * prograde, negative retrograde (Venus and Uranus). Hard-coded for the same
     * reason the mean radii are (SolarSystemClient): constants of the report,
     * not data that moves, and Horizons publishes them only as free-form text.
     *
     * The sign is not decoration — it is what makes the longitude convention
     * come out right. IAU planetographic longitude is always counted *opposite*
     * to the rotation, so the sub-Earth longitude grows at |rate| whichever way
     * the body turns, while the direction that longitude must be applied in
     * flips with the sign. Confirmed against Horizons on Uranus, whose
     * `ObsSub-LON` visibly decreases over ten days while Venus's increases —
     * both of them retrograde.
     *
     * Source: Archinal et al., "Report of the IAU Working Group on Cartographic
     * Coordinates and Rotational Elements: 2015". Jupiter is System III (the
     * magnetic field's rate, the one its `ObsSub-LON` is reported in), not the
     * cloud-top System I or II.
     */
    private const ROTATION_DEG_PER_DAY = [
        'mercury' => 6.1385108,
        'venus' => -1.4813688,
        'mars' => 350.891982443297,
        'jupiter' => 870.5360000,
        'saturn' => 810.7939024,
        'uranus' => -501.1600928,
        'neptune' => 541.1397757,
        // Pluto, IAU 2015: W = 302,695 + 56,3625225 d, and the sign is POSITIVE even
        // though Pluto turns backwards against its orbit: the IAU pole it is given
        // (RA 132,993, Dec -6,163) is the one Pluto rotates prograde about, so the
        // retrograde-ness lives in the pole, not in the rate. Measured against
        // Horizons: a negative rate misses ObsSub-LON by 47 degrees after 10 days.
        // The pole itself comes from Horizons like every planet's.
        'pluto' => 56.3625225,
        // The Moon, tidally locked: one turn per sidereal month, so its
        // sub-Earth longitude stays near zero and only librates. It is here
        // rather than in the moons route because what it needs is exactly this
        // service — the moons route serves positions, not orientation.
        //
        // The IAU model for the Moon is the only one in this table that is not
        // a straight line: W carries thirteen periodic terms, the largest
        // 3,5610 sin E1 with E1 the node, and the pole's own RA and Dec carry
        // their own. Propagating at a constant rate therefore cannot be exact
        // the way it is for a planet, and the test measures what it costs
        // instead of assuming it is negligible.
        'moon' => 13.17635815,
    ];

    /**
     * Bodies this service orients that `SolarSystemClient` does not carry:
     * Horizons id, name, mean radius.
     *
     * Deliberately not solved by adding the Moon to `SolarSystemClient::BODIES`.
     * That table feeds the positions route, the orbit route, the moons route and
     * the warm command — the Moon would arrive in all four, which means a
     * monthly Horizons position table nobody reads and `planet=moon` accepted by
     * routes where it is nonsense. One duplicated row is the cheaper of the two.
     */
    private const EXTRA_BODIES = [
        'moon' => ['301', 'Moon', 1737.4],
    ];

    /**
     * Bodies whose IAU longitudes are counted **east** even though they rotate
     * prograde — the traditional exception the IAU grants the Earth, the Moon
     * and the Sun, and the one place the rule below breaks down. Pluto is in it
     * too, but by measurement and not by tradition: Horizons' ObsSub-LON for it
     * decreases at |rate|, which is what an east-counted prograde body does.
     *
     * The rule everywhere else is that planetographic longitude runs *opposite*
     * to the rotation: west on a prograde body, east on a retrograde one. So the
     * sign of the rate was enough to place the prime meridian, and for the nine
     * planets it still is. The Moon rotates prograde and is nevertheless counted
     * east — which is why its gazetteer runs 0–360° E and Mare Crisium sits at
     * 59° E.
     *
     * **Measured, not deduced.** Taking the Moon for an ordinary prograde body
     * reproduced Horizons' `ObsSub-LON` with a residual that was *mirrored about
     * zero* and offset by a constant 2,39° — twice the 1,195° the sub-Earth
     * point stood from the prime meridian in the first row, which is exactly
     * what placing that meridian on the wrong side of it costs. See the test.
     */
    private const EAST_POSITIVE_LONGITUDE = [
        'moon' => true,
        'pluto' => true,
    ];

    /**
     * +1 when the reported sub-observer longitude is counted *against* the
     * rotation (the planetographic default), −1 when it is counted east.
     *
     * This is the sign to turn by, going from the sub-observer meridian back to
     * the prime meridian about the pole — east being the direction of a positive
     * rotation about the pole.
     */
    public static function longitudeSign(string $id): int
    {
        $east = isset(self::EAST_POSITIVE_LONGITUDE[$id]) || self::ROTATION_DEG_PER_DAY[$id] < 0;

        return $east ? -1 : 1;
    }

    public function __construct(private readonly HorizonsClient $horizons)
    {
    }

    public static function isKnown(string $id): bool
    {
        return isset(self::ROTATION_DEG_PER_DAY[$id]);
    }

    /** @return list<string> */
    public static function ids(): array
    {
        return array_keys(self::ROTATION_DEG_PER_DAY);
    }

    public static function rateOf(string $id): float
    {
        return self::ROTATION_DEG_PER_DAY[$id];
    }

    /** The Horizons addressing id, wherever this service's body list gets it from. */
    public static function horizonsIdOf(string $id): string
    {
        return SolarSystemClient::isKnown($id) ? SolarSystemClient::horizonsId($id) : self::EXTRA_BODIES[$id][0];
    }

    /** @return array{id: string, name: string, radius_km: float} the constants a client needs to draw it */
    public static function describe(string $id): array
    {
        if (SolarSystemClient::isKnown($id)) {
            return SolarSystemClient::describe($id);
        }
        [, $name, $radiusKm] = self::EXTRA_BODIES[$id];

        return ['id' => $id, 'name' => $name, 'radius_km' => $radiusKm];
    }

    /**
     * One body's orientation at `$at`.
     *
     * @return array{pole: array{float, float, float}, prime_meridian: array{float, float, float}, rotation_deg_per_day: float}|null
     *   null when Horizons didn't answer for it
     *
     * @throws ExceptionInterface on transport failure
     */
    public function getOrientation(string $id, \DateTimeImmutable $at): ?array
    {
        $row = $this->horizons->getOrientations([$id => self::horizonsIdOf($id)], $at)[$id];

        return null === $row ? null : self::build($id, $row);
    }

    /**
     * Turns one Horizons row into the two vectors. Pure, and split from the
     * fetch so the arithmetic — the part worth getting wrong — is testable
     * without a network.
     *
     * @param array{ra: float, dec: float, sub_lon: float, sub_lat: float, delta_au: float, pole_ra: float, pole_dec: float} $row
     *
     * @return array{pole: array{float, float, float}, prime_meridian: array{float, float, float}, rotation_deg_per_day: float}
     */
    public static function build(string $id, array $row): array
    {
        $rate = self::ROTATION_DEG_PER_DAY[$id];
        $pole = self::direction($row['pole_ra'], $row['pole_dec']);

        // Horizons reports ObsSub-LON for the instant the light *left* the body,
        // while the scene places planets at their geometric positions (Horizons
        // VECTORS is uncorrected). Mixing the two draws Jupiter's surface where
        // it stood 49 minutes ago: 29,8 degrees of rotation. So the phase is
        // advanced by whatever the body turned while the light travelled.
        //
        // `abs()`, and it is not a detail: the sub-Earth *longitude* always
        // grows at |rate| whichever way the body turns, because the longitude is
        // counted against the rotation. Using the signed rate here sends the
        // correction backwards on a retrograde body, for twice its size in
        // error. Only Uranus shows it — retrograde, fast, and 19 au out, so its
        // light-time term is 54,7 degrees: the reconstruction drifted 2,34 deg
        // over 40 days with the signed rate and 0,00003 deg with this one.
        // Venus hides the bug (retrograde but 0,004 deg of term), Jupiter hides
        // it (29,8 deg of term but prograde).
        $lightTimeDays = $row['delta_au'] * self::AU_KM / self::C_KM_S / 86400.0;
        //
        // The direction of that advance is the direction the reported longitude
        // itself drifts: +|rate| for every body whose longitude grows with time
        // (so `abs()` was exact for the seven planets), but -|rate| for Pluto,
        // whose ObsSub-LON *decreases* — Horizons counts it east although it
        // turns prograde about its IAU pole. `longitudeSign * rate` is both
        // at once: 11,4 degrees of light-time on Pluto are worth 22,8 degrees of
        // error if applied the wrong way (measured against the IAU W, 2026-10-16).
        $longitude = fmod($row['sub_lon'] + self::longitudeSign($id) * $rate * $lightTimeDays + 360.0, 360.0);

        // The body-to-Earth direction, flattened into the body's equatorial
        // plane: the sub-Earth point lies on that meridian by definition, which
        // is the hinge of the whole reconstruction.
        $toEarth = self::negate(self::direction($row['ra'], $row['dec']));
        $inEquator = self::normalise(self::reject($toEarth, $pole));

        // Walk back along the meridians by the sub-Earth longitude to land on
        // the prime meridian. Which way round depends on how that longitude is
        // counted — against the rotation for the nine planets, east for the
        // Moon (`longitudeSign`).
        $primeMeridian = self::rotateAbout($inEquator, $pole, self::longitudeSign($id) * $longitude);

        return [
            'pole' => $pole,
            'prime_meridian' => $primeMeridian,
            'rotation_deg_per_day' => $rate,
        ];
    }

    /**
     * Where the sub-Earth longitude would be at `$daysLater`, given a built
     * orientation and the body-to-Earth direction then. Only the tests and the
     * comparison log use it — it is the inverse of `build`, and the only way to
     * state the reconstruction's error in the units Horizons publishes.
     *
     * @param array{pole: array{float, float, float}, prime_meridian: array{float, float, float}, rotation_deg_per_day: float} $orientation
     * @param array{float, float, float} $toEarth unit vector, body to Earth
     */
    public static function subEarthLongitude(string $id, array $orientation, array $toEarth, float $daysLater): float
    {
        $pole = $orientation['pole'];
        $rate = $orientation['rotation_deg_per_day'];
        $meridian = self::rotateAbout($orientation['prime_meridian'], $pole, $rate * $daysLater);
        $inEquator = self::normalise(self::reject($toEarth, $pole));

        $angle = rad2deg(atan2(
            self::dot(self::cross($meridian, $inEquator), $pole),
            self::dot($meridian, $inEquator),
        ));

        return fmod(-self::longitudeSign($id) * $angle + 360.0, 360.0);
    }

    /** @return array{float, float, float} unit vector from right ascension and declination, both degrees */
    private static function direction(float $raDeg, float $decDeg): array
    {
        $ra = deg2rad($raDeg);
        $dec = deg2rad($decDeg);

        return [cos($dec) * cos($ra), cos($dec) * sin($ra), sin($dec)];
    }

    /**
     * Rodrigues rotation of `$v` about the unit axis `$axis` by `$deg`,
     * right-handed.
     *
     * @param array{float, float, float} $v
     * @param array{float, float, float} $axis
     *
     * @return array{float, float, float}
     */
    private static function rotateAbout(array $v, array $axis, float $deg): array
    {
        $a = deg2rad($deg);
        $c = cos($a);
        $s = sin($a);
        $cross = self::cross($axis, $v);
        $dot = self::dot($axis, $v);

        $out = [];
        for ($i = 0; $i < 3; ++$i) {
            $out[$i] = $v[$i] * $c + $cross[$i] * $s + $axis[$i] * $dot * (1 - $c);
        }

        return self::normalise($out);
    }

    /**
     * The part of `$v` perpendicular to the unit vector `$axis`.
     *
     * @param array{float, float, float} $v
     * @param array{float, float, float} $axis
     *
     * @return array{float, float, float}
     */
    private static function reject(array $v, array $axis): array
    {
        $d = self::dot($axis, $v);

        return [$v[0] - $d * $axis[0], $v[1] - $d * $axis[1], $v[2] - $d * $axis[2]];
    }

    /**
     * @param array{float, float, float} $v
     *
     * @return array{float, float, float}
     */
    private static function normalise(array $v): array
    {
        $n = sqrt(self::dot($v, $v));

        return 0.0 === $n ? $v : [$v[0] / $n, $v[1] / $n, $v[2] / $n];
    }

    /**
     * @param array{float, float, float} $v
     *
     * @return array{float, float, float}
     */
    private static function negate(array $v): array
    {
        return [-$v[0], -$v[1], -$v[2]];
    }

    /**
     * @param array{float, float, float} $a
     * @param array{float, float, float} $b
     */
    private static function dot(array $a, array $b): float
    {
        return $a[0] * $b[0] + $a[1] * $b[1] + $a[2] * $b[2];
    }

    /**
     * @param array{float, float, float} $a
     * @param array{float, float, float} $b
     *
     * @return array{float, float, float}
     */
    private static function cross(array $a, array $b): array
    {
        return [
            $a[1] * $b[2] - $a[2] * $b[1],
            $a[2] * $b[0] - $a[0] * $b[2],
            $a[0] * $b[1] - $a[1] * $b[0],
        ];
    }
}
