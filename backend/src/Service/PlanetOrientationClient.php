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
    ];

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
        $row = $this->horizons->getOrientations([$id => SolarSystemClient::horizonsId($id)], $at)[$id];

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
        $longitude = fmod($row['sub_lon'] + abs($rate) * $lightTimeDays, 360.0);

        // The body-to-Earth direction, flattened into the body's equatorial
        // plane: the sub-Earth point lies on that meridian by definition, which
        // is the hinge of the whole reconstruction.
        $toEarth = self::negate(self::direction($row['ra'], $row['dec']));
        $inEquator = self::normalise(self::reject($toEarth, $pole));

        // Walk back along the meridians by the sub-Earth longitude to land on
        // the prime meridian. The sign flips for a retrograde body, because the
        // longitude is then counted the other way round the pole.
        $primeMeridian = self::rotateAbout($inEquator, $pole, ($rate > 0 ? 1 : -1) * $longitude);

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
    public static function subEarthLongitude(array $orientation, array $toEarth, float $daysLater): float
    {
        $pole = $orientation['pole'];
        $rate = $orientation['rotation_deg_per_day'];
        $meridian = self::rotateAbout($orientation['prime_meridian'], $pole, $rate * $daysLater);
        $inEquator = self::normalise(self::reject($toEarth, $pole));

        $angle = rad2deg(atan2(
            self::dot(self::cross($meridian, $inEquator), $pole),
            self::dot($meridian, $inEquator),
        ));

        return fmod(($rate > 0 ? -1 : 1) * $angle + 360.0, 360.0);
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
