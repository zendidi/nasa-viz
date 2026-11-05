<?php

namespace App\Tests\Service;

use App\Service\HorizonsClient;
use App\Service\JplCadClient;
use App\Service\SmallBodyTrajectoryClient;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Symfony\Component\HttpClient\Exception\TransportException;
use Symfony\Component\HttpClient\MockHttpClient;
use Symfony\Component\HttpClient\Response\MockResponse;

final class SmallBodyTrajectoryClientTest extends TestCase
{
    private const FIXTURES = __DIR__.'/../Fixtures/';
    private const VECTORS = "\$\$SOE\n2461299.5, A.D. 2026-Sep-16 00:00:00.0000, 1.0, 2.0, 3.0,\n\$\$EOE";

    /** @var list<array<string, string>> every Horizons query sent, decoded */
    private array $horizons = [];
    /** @var list<string> */
    private array $cadSpk = [];

    private function client(bool $cadDown = false): SmallBodyTrajectoryClient
    {
        $this->horizons = [];
        $this->cadSpk = [];
        $http = new MockHttpClient(function (string $method, string $url) use ($cadDown) {
            parse_str((string) parse_url($url, PHP_URL_QUERY), $q);
            if (str_starts_with($url, 'https://horizons.test')) {
                $this->horizons[] = $q;

                return new MockResponse(json_encode(['result' => self::VECTORS]));
            }
            $this->cadSpk[] = $q['spk'];

            return $cadDown ? new MockResponse('boom', ['http_code' => 500]) : new MockResponse((string) file_get_contents(self::FIXTURES.'cad_object_two_close.json'));
        });

        return new SmallBodyTrajectoryClient(
            new HorizonsClient($http, 'https://horizons.test'),
            new JplCadClient($http, 'https://cad.test'),
        );
    }

    /** @return list<array<string, string>> */
    private function queries(): array
    {
        return $this->horizons;
    }

    /** @return array{spkid: string, des: string, fullname: string, neo: bool, orbit_id: string} */
    private static function body(bool $neo): array
    {
        return ['spkid' => '20099942', 'des' => '99942', 'fullname' => 'Apophis', 'neo' => $neo, 'orbit_id' => '220'];
    }

    private static function utc(string $when): \DateTimeImmutable
    {
        return new \DateTimeImmutable($when, new \DateTimeZone('UTC'));
    }

    /** Rows an inclusive table has between two Horizons timestamps at a step. */
    private static function rows(string $startTime, string $stopTime, int $stepSeconds): int
    {
        return (int) ((strtotime(trim($stopTime, "'").' UTC') - strtotime(trim($startTime, "'").' UTC')) / $stepSeconds) + 1;
    }

    /** @return iterable<string, array{string, string, string}> now => range start, range end */
    public static function ranges(): iterable
    {
        yield 'mid year' => ['2026-06-15 12:00:00', '2025-01-01 00:00:00', '2031-01-01 00:00:00'];
        yield 'leap day' => ['2028-02-29 08:00:00', '2027-01-01 00:00:00', '2033-01-01 00:00:00'];
        yield 'last second of the year' => ['2026-12-31 23:59:59', '2025-01-01 00:00:00', '2031-01-01 00:00:00'];
        yield 'first instant of the next' => ['2027-01-01 00:00:00', '2026-01-01 00:00:00', '2032-01-01 00:00:00'];
        // 23:30 at UTC-5 is already 04:30 on 1 January in UTC: the year is the UTC one.
        yield 'a local clock behind UTC' => ['2026-12-31 23:30:00 -05:00', '2026-01-01 00:00:00', '2032-01-01 00:00:00'];
    }

    #[DataProvider('ranges')]
    public function testRangeIsSixCalendarYearsAnchoredOnTheUtcYear(string $now, string $start, string $end): void
    {
        $range = SmallBodyTrajectoryClient::trajectoryRange(new \DateTimeImmutable($now));

        self::assertSame($start, $range['start']->format('Y-m-d H:i:s'));
        self::assertSame($end, $range['end']->format('Y-m-d H:i:s'));
        self::assertSame('UTC', $range['start']->getTimezone()->getName());
    }

    public function testRangeHolds2192DailyRowsFor2025To2031AndOneMoreDayThroughALeapYear(): void
    {
        $days = static fn (array $r) => intdiv($r['end']->getTimestamp() - $r['start']->getTimestamp(), 86400) + 1;

        self::assertSame(2192, $days(SmallBodyTrajectoryClient::trajectoryRange(self::utc('2026-06-15'))));
        // 2027 → 2033 holds 2028 and 2032: two leap days, against one for 2025 → 2031.
        self::assertSame(2193, $days(SmallBodyTrajectoryClient::trajectoryRange(self::utc('2028-06-15'))));
    }

    public function testPrecisionYearsAreTheOnesTheRangeCovers(): void
    {
        $now = self::utc('2026-06-15');

        self::assertFalse(SmallBodyTrajectoryClient::isYearInRange(2024, $now));
        self::assertTrue(SmallBodyTrajectoryClient::isYearInRange(2025, $now));
        self::assertTrue(SmallBodyTrajectoryClient::isYearInRange(2030, $now));
        self::assertFalse(SmallBodyTrajectoryClient::isYearInRange(2031, $now));
    }

    public function testTrajectoryIsOneDailyTableOfTheWholeRange(): void
    {
        $range = SmallBodyTrajectoryClient::trajectoryRange(self::utc('2026-06-15'));
        $object = $this->client()->getTrajectory(self::body(true), $range);

        self::assertCount(1, $this->horizons);
        self::assertSame("'DES=20099942;'", $this->horizons[0]['COMMAND']);
        self::assertSame("'1d'", $this->horizons[0]['STEP_SIZE']);
        self::assertSame("'2025-01-01 00:00:00'", $this->horizons[0]['START_TIME']);
        self::assertSame("'2031-01-01 00:00:00'", $this->horizons[0]['STOP_TIME']);
        self::assertSame(86400, $object['table']['step_seconds']);
        self::assertSame('220', $object['orbit_id']);
        self::assertSame(['20099942'], $this->cadSpk);
        // The fixture's four passes (2026-11, 2026-12, 2027-07, 2028-08) all fall in 2025 → 2031: none is "next".
        self::assertCount(4, $object['close_approaches']);
        self::assertNull($object['next_close_approach_after_range']);
    }

    public function testTrajectoryNextApproachIsTheFirstOneAtOrAfterTheRangeEnd(): void
    {
        // A range ending 2027-01-01: the 2027-07-01 pass (0.0002 au) is the next one, the 2028 pass is not.
        $range = ['start' => self::utc('2021-01-01'), 'end' => self::utc('2027-01-01')];
        $object = $this->client()->getTrajectory(self::body(true), $range);

        self::assertCount(2, $object['close_approaches']);
        self::assertEqualsWithDelta(0.0002 * 149597870.7, $object['next_close_approach_after_range']['dist_km'], 1e-6);
    }

    public function testNonNeoTrajectoryHasNoCadCallAndNoApproaches(): void
    {
        $object = $this->client()->getTrajectory(self::body(false), SmallBodyTrajectoryClient::trajectoryRange(self::utc('2026-06-15')));

        self::assertSame([], $this->cadSpk);
        self::assertSame([], $object['close_approaches']);
        self::assertNull($object['next_close_approach_after_range']);
    }

    public function testCadFailureServesTheTableWithNullApproaches(): void
    {
        $object = $this->client(true)->getTrajectory(self::body(true), SmallBodyTrajectoryClient::trajectoryRange(self::utc('2026-06-15')));

        self::assertNull($object['close_approaches']);
        self::assertNotEmpty($object['table']['positions']);
    }

    /** @return iterable<string, array{int, string, string, int}> year => START, STOP, rows */
    public static function precisionWindows(): iterable
    {
        yield 'normal year' => [2029, '2028-12-31 22:00:00', '2030-01-01 02:00:00', 8765];
        yield 'leap year' => [2028, '2027-12-31 22:00:00', '2029-01-01 02:00:00', 8789];
    }

    #[DataProvider('precisionWindows')]
    public function testPrecisionAsksForTheYearPlusTwoHoursEachSide(int $year, string $start, string $stop, int $rows): void
    {
        $object = $this->client()->getPrecision(self::body(true), $year);

        $hourly = array_values(array_filter($this->horizons, static fn (array $q) => "'1h'" === $q['STEP_SIZE']));
        self::assertCount(1, $hourly);
        self::assertSame("'$start'", $hourly[0]['START_TIME']);
        self::assertSame("'$stop'", $hourly[0]['STOP_TIME']);
        self::assertSame($rows, self::rows($hourly[0]['START_TIME'], $hourly[0]['STOP_TIME'], 3600));
        self::assertSame(3600, $object['table']['step_seconds']);
        self::assertSame($year, $object['year']);
        // `table.start` is the first real instant, i.e. the requested start.
        self::assertSame(strtotime($start.' UTC'), $object['table']['start']);
    }

    public function testNonNeoPrecisionHasNoTableAndCostsNothing(): void
    {
        $object = $this->client()->getPrecision(self::body(false), 2029);

        self::assertSame([], $this->horizons);
        self::assertSame([], $this->cadSpk);
        self::assertFalse($object['neo']);
        self::assertNull($object['table']);
        self::assertSame([], $object['segments']);
        self::assertSame(2029, $object['year']);
        self::assertSame('220', $object['orbit_id']);
    }

    /** @return iterable<string, array{int, int}> year => segments (CAD fixture: 0.00049 au in 2026, 0.0002 au in 2027, 0.001 au in 2028) */
    public static function segmentsByYear(): iterable
    {
        yield '2026 holds the 0.00049 au pass' => [2026, 1];
        yield '2027 holds the 0.0002 au pass' => [2027, 1];
        yield '2028 only a pass too far for a segment' => [2028, 0];
        yield '2029 nothing at all' => [2029, 0];
    }

    #[DataProvider('segmentsByYear')]
    public function testSegmentsAreThoseOfTheApproachesFallingInThatCalendarYear(int $year, int $expected): void
    {
        $object = $this->client()->getPrecision(self::body(true), $year);

        self::assertCount($expected, $object['segments']);
        $fine = array_filter($this->horizons, static fn (array $q) => "'5m'" === $q['STEP_SIZE']);
        self::assertCount($expected, $fine);
        foreach ($object['segments'] as $segment) {
            self::assertSame(300, $segment['step_seconds']);
        }
    }

    public function testASegmentMaySpillIntoTheNeighbouringYear(): void
    {
        // A pass at 2027-01-01 00:10 UTC belongs to 2027, and its -12 h start is in 2026.
        $jd = 2440587.5 + (strtotime('2027-01-01 00:10:00 UTC') + 69.184) / 86400;
        $rows = [['X', '1', sprintf('%.9f', $jd), 'x', '0.0001', '0', '0', '5', '5', '< 00:01', '20']];
        $cad = (string) json_encode(['count' => 1, 'fields' => ['des', 'orbit_id', 'jd', 'cd', 'dist', 'dist_min', 'dist_max', 'v_rel', 'v_inf', 't_sigma_f', 'h'], 'data' => $rows]);
        $http = new MockHttpClient(function (string $method, string $url) use ($cad) {
            parse_str((string) parse_url($url, PHP_URL_QUERY), $q);
            if (str_starts_with($url, 'https://horizons.test')) {
                $this->horizons[] = $q;

                return new MockResponse(json_encode(['result' => self::VECTORS]));
            }

            return new MockResponse($cad);
        });
        $client = new SmallBodyTrajectoryClient(new HorizonsClient($http, 'https://horizons.test'), new JplCadClient($http, 'https://cad.test'));

        self::assertCount(0, $client->getPrecision(self::body(true), 2026)['segments']);
        self::assertCount(1, $client->getPrecision(self::body(true), 2027)['segments']);
        $fine = array_values(array_filter($this->queries(), static fn (array $q) => "'5m'" === $q['STEP_SIZE']));
        self::assertLessThan(strtotime('2027-01-01 UTC'), strtotime(trim($fine[0]['START_TIME'], "'").' UTC'));
    }

    public function testCadFailureGivesNullSegmentsButStillTheTable(): void
    {
        $object = $this->client(true)->getPrecision(self::body(true), 2029);

        self::assertNull($object['segments']);
        self::assertNotEmpty($object['table']['positions']);
    }

    public function testCacheKeyChangesWithTheOrbitSolutionTheYearAndWhatIsAsked(): void
    {
        $a = SmallBodyTrajectoryClient::cacheKey('trajectory', '20099942', 2026, '220');
        $b = SmallBodyTrajectoryClient::cacheKey('trajectory', '20099942', 2026, '221');

        self::assertNotSame($a, $b, 'a new orbit solution must not be served the old table');
        self::assertStringContainsString('220', $a);
        self::assertStringContainsString(HorizonsClient::TIME_SCALE, $a);
        self::assertNotSame($a, SmallBodyTrajectoryClient::cacheKey('trajectory', '20099942', 2027, '220'));
        self::assertNotSame($a, SmallBodyTrajectoryClient::cacheKey('precision', '20099942', 2026, '220'));
        self::assertNotSame($a, SmallBodyTrajectoryClient::cacheKey('trajectory', '20099942', 2026, null));
        self::assertNotSame(SmallBodyTrajectoryClient::sunCacheKey(2026), SmallBodyTrajectoryClient::sunCacheKey(2027));
    }

    public function testTtlIsThirtyDaysADayWithoutOrbitIdAndAnHourForNull(): void
    {
        self::assertSame(30 * 86400, SmallBodyTrajectoryClient::ttlSeconds('220', false));
        self::assertSame(86400, SmallBodyTrajectoryClient::ttlSeconds(null, false));
        self::assertSame(3600, SmallBodyTrajectoryClient::ttlSeconds('220', true));
        self::assertSame(3600, SmallBodyTrajectoryClient::ttlSeconds(null, true));
    }

    public function testSunIsTheDailyGeocentricTableOfBody10OnTheSameRange(): void
    {
        $range = SmallBodyTrajectoryClient::trajectoryRange(self::utc('2026-06-15'));
        $table = $this->client()->getSun($range);

        self::assertCount(1, $this->horizons);
        self::assertSame("'10'", $this->horizons[0]['COMMAND']);
        self::assertSame("'500@399'", $this->horizons[0]['CENTER']);
        self::assertSame("'UT'", $this->horizons[0]['TIME_TYPE']);
        self::assertSame("'1d'", $this->horizons[0]['STEP_SIZE']);
        self::assertSame("'2025-01-01 00:00:00'", $this->horizons[0]['START_TIME']);
        self::assertSame("'2031-01-01 00:00:00'", $this->horizons[0]['STOP_TIME']);
        self::assertSame(86400, $table['step_seconds']);
    }

    public function testSunWithoutATableIsAnUpstreamFailure(): void
    {
        $http = new MockHttpClient(static fn () => new MockResponse(json_encode(['result' => 'No matches found.'])));
        $client = new SmallBodyTrajectoryClient(new HorizonsClient($http, 'https://horizons.test'), new JplCadClient($http, 'https://cad.test'));

        $this->expectException(TransportException::class);
        $client->getSun(SmallBodyTrajectoryClient::trajectoryRange(self::utc('2026-06-15')));
    }
}
