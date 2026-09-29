<?php

namespace App\Tests\Service;

use App\Service\PlanetOrientationClient;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The reconstruction is checked against Horizons itself: build the orientation
 * from the first row of a real ephemeris, then predict where the sub-Earth
 * meridian is at four later dates and compare with what Horizons published.
 *
 * Rows are verbatim from requests made on 2026-09-29 — `EPHEM_TYPE=OBSERVER`,
 * `QUANTITIES='1,14,20,32'`, `ANG_FORMAT='DEG'`, geocentric, 10-day step from
 * 2026-10-01. Four bodies on purpose, because two independent signs have to be
 * pinned and no single body pins both:
 *
 * |         | direction   | rate      | distance | light-time term |
 * |---------|-------------|-----------|----------|-----------------|
 * | Mars    | prograde    | 351 deg/j | 1,7 au   |   3,4 deg       |
 * | Jupiter | prograde    | 871 deg/j | 5,9 au   |  29,8 deg       |
 * | Venus   | retrograde  | 1,5 deg/j | 0,35 au  |   0,004 deg     |
 * | Uranus  | retrograde  | 501 deg/j | 18,9 au  |  54,7 deg       |
 *
 * Uranus is the only one that is retrograde *and* has a large light-time term,
 * and it is the only row that catches applying that term with the signed rate
 * instead of its absolute value. That bug was live and measured 2,34 deg of
 * drift over 40 days; Mars, Jupiter and Venus all passed while it was there.
 *
 * The Moon joined them on 2026-09-29 and pins a third thing the four planets
 * cannot: it rotates **prograde and is still counted east**, the exception the
 * IAU grants the Earth, the Moon and the Sun. Taking it for an ordinary
 * prograde body put the reconstruction 12 deg out, mirrored about zero and
 * offset by a constant 2,39 deg -- twice the 1,195 deg the sub-Earth point
 * stood from the prime meridian in its first row. It is also the only body here
 * whose IAU model is not a straight line (thirteen periodic terms in W, and its
 * pole moves 0,26 deg in R.A. over the forty days where Mars's moves 5e-5), so
 * it carries its own tolerance rather than the planets' 1e-3.
 */
final class PlanetOrientationClientTest extends TestCase
{
    private const AU_KM = 149597870.700;
    private const C_KM_S = 299792.458;

    /**
     * [days after the first row, R.A. (ICRF), Dec (ICRF), ObsSub-LON, delta (au), N.Pole-RA, N.Pole-DC]
     *
     * The third element is the tolerance in degrees over the forty days. It is
     * 1e-3 for every body whose IAU rotation is a straight line, which is all of
     * them but the Moon.
     *
     * @return array<string, array{string, list<array{float, float, float, float, float, float, float}>, float}>
     */
    public static function bodies(): array
    {
        return [
            'mars — prograde, 3,4 deg of light-time' => ['mars', [
                [0.0, 123.78543, 20.85435, 36.185881, 1.66543876121000, 317.65213, 52.86972],
                [10.0, 129.75431, 19.66364, 299.605410, 1.59467182726064, 317.65212, 52.86972],
                [20.0, 135.39613, 18.36824, 203.155953, 1.51956141970801, 317.65212, 52.86973],
                [30.0, 140.68716, 17.01732, 106.885186, 1.44060566503619, 317.65210, 52.86973],
                [40.0, 145.59469, 15.66388, 10.861558, 1.35815589285222, 317.65208, 52.86974],
            ], 0.001],
            'jupiter — prograde, 29,8 deg of light-time' => ['jupiter', [
                [0.0, 141.83407, 15.62451, 356.354357, 5.92083045874485, 268.05765, 64.49667],
                [10.0, 143.53021, 15.10792, 60.622694, 5.79729761747650, 268.05765, 64.49667],
                [20.0, 145.05284, 14.63729, 125.125391, 5.66100281692621, 268.05765, 64.49667],
                [30.0, 146.37646, 14.22562, 189.877118, 5.51471455673891, 268.05765, 64.49666],
                [40.0, 147.47438, 13.88620, 254.893026, 5.36135035672005, 268.05765, 64.49666],
            ], 0.001],
            'venus — retrograde, no light-time to speak of' => ['venus', [
                [0.0, 213.21656, -20.84700, 307.534456, 0.34765985220179, 272.76000, 67.16000],
                [10.0, 211.96347, -20.97551, 321.279834, 0.30054435082128, 272.76000, 67.16000],
                [20.0, 207.56858, -18.81035, 331.413738, 0.27523719595973, 272.76000, 67.16000],
                [30.0, 202.56354, -14.93243, 340.312095, 0.27792396572021, 272.76000, 67.16000],
                [40.0, 200.11846, -11.30590, 351.559135, 0.30768946719722, 272.76000, 67.16000],
            ], 0.001],
            'uranus — retrograde AND 54,7 deg of light-time' => ['uranus', [
                [0.0, 63.24310, 21.00366, 31.082324, 18.8874878715598, 257.31100, -15.17500],
                [10.0, 63.02602, 20.96710, 2.652690, 18.7523714215842, 257.31100, -15.17500],
                [20.0, 62.73511, 20.91769, 334.035944, 18.6375488859390, 257.31100, -15.17500],
                [30.0, 62.38269, 20.85718, 305.255291, 18.5468458847798, 257.31100, -15.17500],
                [40.0, 61.98293, 20.78770, 276.337417, 18.4833519530985, 257.31100, -15.17500],
            ], 0.001],
            // Prograde and counted east all the same, and the only body here
            // whose IAU rotation carries periodic terms. Its ObsSub-LON barely
            // leaves zero because it is tidally locked: what swings it by eight
            // degrees is optical libration, which the reconstruction gets for
            // free from the real Earth direction at each date.
            'moon — prograde but counted EAST, and not a straight line' => ['moon', [
                [0.0, 60.42382, 25.90867, 358.804592, 0.00247030450157, 272.14725, 67.83421],
                [10.0, 198.21963, -12.12656, 4.834277, 0.00259992654474, 272.32252, 67.83484],
                [20.0, 325.55170, -14.21192, 354.819145, 0.00263754157769, 272.22347, 67.85708],
                [30.0, 104.31888, 26.29834, 2.885213, 0.00245481637336, 272.26664, 67.79987],
                [40.0, 231.58926, -23.91492, 3.450226, 0.00267233043600, 272.40672, 67.82992],
            ], 0.01],
        ];
    }

    /**
     * @param list<array{float, float, float, float, float, float, float}> $rows
     */
    #[DataProvider('bodies')]
    public function testReproducesHorizonsOverFortyDays(string $id, array $rows, float $tolerance): void
    {
        $orientation = PlanetOrientationClient::build($id, self::row($rows[0]));

        foreach ($rows as $row) {
            [$days, $ra, $dec] = $row;

            $predicted = PlanetOrientationClient::subEarthLongitude($id, $orientation, self::toEarth($ra, $dec), $days);
            $expected = self::geometricLongitude($id, $row);

            self::assertEqualsWithDelta(
                0.0,
                self::shortestWayRound($predicted - $expected),
                $tolerance,
                sprintf('%s at day %d: predicted %.5f, Horizons %.5f', $id, (int) $days, $predicted, $expected),
            );
        }
    }

    /**
     * The light-time term is applied with `abs(rate)`, and this is the test that
     * says so. Rebuilding with `delta` zeroed is the same as deleting the term:
     * the orientation must then shift by |rate| x light-time, and by that exact
     * amount whichever way the body turns.
     *
     * Checking the *size* of the shift is what separates a real correction from
     * one applied backwards — a sign error leaves the magnitude untouched at the
     * anchor and only shows up as drift later, which is how it survived three
     * bodies.
     *
     * @param list<array{float, float, float, float, float, float, float}> $rows
     */
    #[DataProvider('bodies')]
    public function testLightTimeTermIsAppliedForwardWhicheverWayTheBodyTurns(string $id, array $rows, float $tolerance): void
    {
        $row = self::row($rows[0]);
        $uncorrected = $row;
        $uncorrected['delta_au'] = 0.0;

        $toEarth = self::toEarth($rows[0][1], $rows[0][2]);
        $shift = self::shortestWayRound(
            PlanetOrientationClient::subEarthLongitude($id, PlanetOrientationClient::build($id, $row), $toEarth, 0.0)
            - PlanetOrientationClient::subEarthLongitude($id, PlanetOrientationClient::build($id, $uncorrected), $toEarth, 0.0)
        );

        $lightTimeDays = $rows[0][4] * self::AU_KM / self::C_KM_S / 86400.0;
        $expected = self::shortestWayRound(abs(PlanetOrientationClient::rateOf($id)) * $lightTimeDays);

        self::assertEqualsWithDelta($expected, $shift, 0.001, $id.': the light-time term is the wrong size or the wrong way round');
    }

    /** Served as unit vectors a client rotates about; a drifting norm would shear the body. */
    #[DataProvider('bodies')]
    public function testPoleAndPrimeMeridianAreOrthonormal(string $id, array $rows, float $tolerance): void
    {
        $orientation = PlanetOrientationClient::build($id, self::row($rows[0]));
        $pole = $orientation['pole'];
        $meridian = $orientation['prime_meridian'];

        $norm = static fn (array $v): float => sqrt($v[0] ** 2 + $v[1] ** 2 + $v[2] ** 2);

        self::assertEqualsWithDelta(1.0, $norm($pole), 1e-12, $id.': pole is not a unit vector');
        self::assertEqualsWithDelta(1.0, $norm($meridian), 1e-12, $id.': prime meridian is not a unit vector');
        self::assertEqualsWithDelta(
            0.0,
            $pole[0] * $meridian[0] + $pole[1] * $meridian[1] + $pole[2] * $meridian[2],
            1e-12,
            $id.': prime meridian is not in the equatorial plane',
        );
    }

    /** Venus and Uranus turn backwards, and the whole longitude convention hangs on that sign. */
    public function testOnlyVenusAndUranusAreRetrograde(): void
    {
        $retrograde = array_values(array_filter(
            PlanetOrientationClient::ids(),
            static fn (string $id): bool => PlanetOrientationClient::rateOf($id) < 0,
        ));

        self::assertSame(['venus', 'uranus'], $retrograde);
    }

    /**
     * The Moon is the exception to "longitude runs against the rotation", and
     * this pins which body it is. Worth its own test because the exception is
     * invisible in the rate: the Moon turns prograde like Mars, and only the
     * IAU's traditional treatment of the Earth, the Moon and the Sun puts its
     * longitudes east. A body added here without that check reproduces the
     * 12 deg error the Moon showed on 2026-09-29.
     */
    public function testOnlyTheMoonIsProgradeAndStillCountedEast(): void
    {
        $progradeButEast = array_values(array_filter(
            PlanetOrientationClient::ids(),
            static fn (string $id): bool => PlanetOrientationClient::rateOf($id) > 0
                && PlanetOrientationClient::longitudeSign($id) < 0,
        ));

        self::assertSame(['moon'], $progradeButEast);
    }

    /**
     * What Horizons would have published had it not been for the light's travel
     * time — the quantity `build` anchors on, and the one the scene needs, since
     * it places planets at their geometric positions.
     *
     * @param array{float, float, float, float, float, float, float} $row
     */
    private static function geometricLongitude(string $id, array $row): float
    {
        $lightTimeDays = $row[4] * self::AU_KM / self::C_KM_S / 86400.0;

        return fmod($row[3] + abs(PlanetOrientationClient::rateOf($id)) * $lightTimeDays + 720.0, 360.0);
    }

    /** Signed shortest way round, so 359,9 against 0,1 reads as 0,2 and not 359,8. */
    private static function shortestWayRound(float $degrees): float
    {
        return fmod($degrees + 540.0, 360.0) - 180.0;
    }

    /**
     * @param array{float, float, float, float, float, float, float} $row
     *
     * @return array{ra: float, dec: float, sub_lon: float, sub_lat: float, delta_au: float, pole_ra: float, pole_dec: float}
     */
    private static function row(array $row): array
    {
        return [
            'ra' => $row[1],
            'dec' => $row[2],
            'sub_lon' => $row[3],
            'sub_lat' => 0.0,
            'delta_au' => $row[4],
            'pole_ra' => $row[5],
            'pole_dec' => $row[6],
        ];
    }

    /** @return array{float, float, float} unit vector from the body to the Earth */
    private static function toEarth(float $raDeg, float $decDeg): array
    {
        $ra = deg2rad($raDeg);
        $dec = deg2rad($decDeg);

        return [-cos($dec) * cos($ra), -cos($dec) * sin($ra), -sin($dec)];
    }
}
