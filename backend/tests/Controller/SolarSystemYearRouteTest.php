<?php

namespace App\Tests\Controller;

use App\Controller\SolarSystemController;
use App\Service\HorizonsClient;
use App\Service\PlanetOrientationClient;
use App\Service\SolarSystemClient;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Psr\Log\NullLogger;
use Symfony\Component\Cache\Adapter\ArrayAdapter;
use Symfony\Component\HttpClient\MockHttpClient;
use Symfony\Component\HttpClient\Response\MockResponse;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;

/**
 * The `year=` mode of the three solar-system routes (lot 3, 2026-11-05) over a mocked
 * Horizons that answers a vector table with one row per step between the START_TIME and
 * STOP_TIME it was asked, each row's X being its own Unix timestamp. So the tests read the
 * bounds of a slice off the data itself instead of restating the arithmetic that built it.
 * "Now" is the real clock: years are derived from it, never hard-coded.
 */
final class SolarSystemYearRouteTest extends TestCase
{
    private ArrayAdapter $pool;
    /** @var list<string> */
    private array $requested = [];
    private bool $horizonsDown = false;
    private bool $horizonsEmpty = false;

    protected function setUp(): void
    {
        $this->pool = new ArrayAdapter();
        $this->requested = [];
        $this->horizonsDown = false;
        $this->horizonsEmpty = false;
    }

    private static function year(): int
    {
        return (int) gmdate('Y');
    }

    private static function query(string $url, string $name): string
    {
        parse_str((string) parse_url($url, PHP_URL_QUERY), $q);

        return trim((string) $q[$name], "'");
    }

    private function horizons(): HorizonsClient
    {
        return new HorizonsClient(new MockHttpClient(function (string $method, string $url) {
            $this->requested[] = $url;
            if ($this->horizonsDown) {
                return new MockResponse('', ['http_code' => 503]);
            }
            if ($this->horizonsEmpty) {
                return new MockResponse(json_encode(['result' => 'No ephemeris.']));
            }
            $utc = new \DateTimeZone('UTC');
            $start = (new \DateTimeImmutable(self::query($url, 'START_TIME'), $utc))->getTimestamp();

            if ('OBSERVER' === self::query($url, 'EPHEM_TYPE')) {
                $row = gmdate('Y-M-d H:i', $start).', , , 123.7, 20.8, 36.1, 1.0, 1.6, 0.1, 317.6, 52.8,';

                return new MockResponse(json_encode(['result' => "\$\$SOE\n$row\n\$\$EOE"]));
            }

            $stop = (new \DateTimeImmutable(self::query($url, 'STOP_TIME'), $utc))->getTimestamp();
            $step = self::query($url, 'STEP_SIZE');
            $stepSeconds = str_ends_with($step, 'm') ? (int) $step * 60 : (int) $step * 86400;
            $rows = [];
            for ($t = $start; $t <= $stop; $t += $stepSeconds) {
                $rows[] = sprintf('0.0, A.D. x, %d, 0, 0,', $t);
            }

            return new MockResponse(json_encode(['result' => "\$\$SOE\n".implode("\n", $rows)."\n\$\$EOE"]));
        }), 'https://horizons.test');
    }

    /** @param array<string, string> $query */
    private function call(string $route, array $query): JsonResponse
    {
        $controller = new SolarSystemController(new NullLogger());
        $horizons = $this->horizons();
        $request = new Request($query);

        return match ($route) {
            'positions' => $controller->solarSystemPositions($request, new SolarSystemClient($horizons), $this->pool),
            'orbit' => $controller->solarSystemOrbit($request, new SolarSystemClient($horizons), $this->pool),
            default => $controller->solarSystemOrientation($request, new PlanetOrientationClient($horizons), $this->pool),
        };
    }

    /** @return array<string, mixed> */
    private function json(JsonResponse $response): array
    {
        return json_decode((string) $response->getContent(), true);
    }

    private static function ts(int $year): int
    {
        return (new \DateTimeImmutable(sprintf('%04d-01-01', $year), new \DateTimeZone('UTC')))->getTimestamp();
    }

    /** @return iterable<string, array{string, int}> */
    public static function slicedBodies(): iterable
    {
        yield 'daily (mars)' => ['mars', 86400];
        yield 'daily (sun)' => ['sun', 86400];
        yield 'six hours (moon)' => ['moon', 21600];
        yield 'six hours (mercury)' => ['mercury', 21600];
    }

    #[DataProvider('slicedBodies')]
    public function testASliceRunsFromTwoStepsBeforeItsYearToTwoStepsAfterIt(string $id, int $step): void
    {
        $year = self::year();
        $body = $this->json($this->call('positions', ['body' => $id, 'year' => (string) $year]));
        $positions = $body['bodies'][0]['positions'];

        self::assertSame($year, $body['year']);
        self::assertSame($step, $body['step_seconds']);
        self::assertSame(self::ts($year), $body['slice_start']);
        self::assertSame(self::ts($year + 1), $body['slice_end']);
        self::assertSame($body['slice_start'] - 2 * $step, $body['start']);
        // What came back is what was announced: first row at `start`, last at slice_end + 2 steps,
        // and no row missing in between.
        self::assertSame($body['start'], $positions[0][0]);
        self::assertSame($body['slice_end'] + 2 * $step, $positions[array_key_last($positions)][0]);
        self::assertCount(($body['slice_end'] + 2 * $step - $body['start']) / $step + 1, $positions);
        self::assertSame($body['slice_start'], $positions[2][0]);
    }

    public function testALeapYearSliceHasItsExtraDay(): void
    {
        // 2028 is out of range today, so the window is asked of the client directly.
        $leap = SolarSystemClient::sliceWindow('mars', 2028);
        $normal = SolarSystemClient::sliceWindow('mars', 2027);
        self::assertSame(366 * 86400, $leap['slice_end'] - $leap['slice_start']);
        self::assertSame(365 * 86400, $normal['slice_end'] - $normal['slice_start']);
        // 366 days of 4 rows, plus 2 overlap rows each side, plus the closing row.
        $moon = SolarSystemClient::sliceWindow('moon', 2028);
        self::assertSame(366 * 4 + 4 + 1, intdiv($moon['stop'] - $moon['start'], 21600) + 1);
    }

    public function testYearsAroundTheCurrentOneAreAcceptedAndRefusedAtTheEdges(): void
    {
        $y = self::year();
        foreach ([$y - 1, $y, $y + 4] as $ok) {
            self::assertSame(200, $this->call('positions', ['body' => 'mars', 'year' => (string) $ok])->getStatusCode(), (string) $ok);
        }
        foreach ([$y - 2, $y + 5] as $bad) {
            $response = $this->call('positions', ['body' => 'mars', 'year' => (string) $bad]);
            self::assertSame(400, $response->getStatusCode());
            self::assertSame(['error' => sprintf('year must be between %d and %d', $y - 1, $y + 4)], $this->json($response));
        }
        foreach (['', 'abc', '2027.5', '-1', '20 27'] as $bad) {
            self::assertSame(400, $this->call('positions', ['body' => 'mars', 'year' => $bad])->getStatusCode(), $bad);
        }
    }

    public function testEveryRouteRefusesABadYearBeforeAskingHorizons(): void
    {
        self::assertSame(400, $this->call('orbit', ['body' => 'mars', 'year' => '1999'])->getStatusCode());
        self::assertSame(400, $this->call('orientation', ['body' => 'mars', 'year' => 'x'])->getStatusCode());
        self::assertSame([], $this->requested);
    }

    public function testASliceIsFetchedOnceAndKeysSeparateYearsAndSteps(): void
    {
        $y = self::year();
        $this->call('positions', ['body' => 'mars', 'year' => (string) $y]);
        $this->call('positions', ['body' => 'mars', 'year' => (string) $y]);
        self::assertCount(1, $this->requested);

        $this->call('positions', ['body' => 'mars', 'year' => (string) ($y + 1)]);
        self::assertCount(2, $this->requested);

        self::assertNotSame(SolarSystemClient::slicePositionsKey('mars', $y), SolarSystemClient::slicePositionsKey('mars', $y + 1));
        self::assertNotSame(SolarSystemClient::slicePositionsKey('mars', $y), SolarSystemClient::slicePositionsKey('moon', $y));
        self::assertNotSame(SolarSystemClient::sliceOrbitKey('mars', $y), SolarSystemClient::sliceOrbitKey('mars', $y + 1));
        self::assertNotSame(SolarSystemClient::sliceOrientationKey('mars', $y), SolarSystemClient::sliceOrientationKey('mars', $y + 1));
        // The contract's spellings: the warm command and the other side rely on them.
        self::assertSame('solar_system_mars_y2027_86400_UTC_o2', SolarSystemClient::slicePositionsKey('mars', 2027));
        self::assertSame('solar_system_orbit_mars_y2027_UTC_360', SolarSystemClient::sliceOrbitKey('mars', 2027));
        self::assertSame('solar_system_orientation_mars_y2027', SolarSystemClient::sliceOrientationKey('mars', 2027));
    }

    public function testANullSliceIsCachedAndATransportFailureIsNot(): void
    {
        $y = (string) self::year();
        $this->horizonsEmpty = true;
        $body = $this->json($this->call('positions', ['body' => 'mars', 'year' => $y]));
        self::assertNull($body['bodies'][0]['positions']);
        $this->call('positions', ['body' => 'mars', 'year' => $y]);
        self::assertCount(1, $this->requested, 'the null is cached');

        $this->setUp();
        $this->horizonsDown = true;
        self::assertSame(502, $this->call('positions', ['body' => 'mars', 'year' => $y])->getStatusCode());
        $this->horizonsDown = false;
        self::assertNotNull($this->json($this->call('positions', ['body' => 'mars', 'year' => $y]))['bodies'][0]['positions']);
    }

    public function testNoCacheControlHeaderIsAdded(): void
    {
        $response = $this->call('positions', ['body' => 'mars', 'year' => (string) self::year()]);
        self::assertStringNotContainsString('immutable', (string) $response->headers->get('Cache-Control'));
    }

    public function testTheOrbitStartsOnTheFirstOfJanuaryOfTheYearAndCarriesIt(): void
    {
        $y = self::year() + 1;
        $body = $this->json($this->call('orbit', ['body' => 'mars', 'year' => (string) $y]));

        self::assertSame($y, $body['year']);
        self::assertSame(self::ts($y), $body['start']);
        self::assertStringContainsString('START_TIME=%27'.$y.'-01-01%2000%3A00%3A00%27', $this->requested[0]);
        self::assertSame('ICRF heliocentric', $body['frame']);
    }

    public function testTheOrientationEpochIsTheFirstOfJanuaryOfTheYearAndCarriesIt(): void
    {
        $y = self::year() + 2;
        foreach (['mars', 'moon'] as $id) {
            $body = $this->json($this->call('orientation', ['body' => $id, 'year' => (string) $y]));
            self::assertSame($y, $body['year']);
            self::assertSame(self::ts($y), $body['epoch']);
            self::assertNotNull($body['bodies'][0]['pole']);
        }
        self::assertStringContainsString('START_TIME=%27'.$y.'-01-01%2000%3A00%3A00%27', $this->requested[0]);
    }

    public function testWithoutYearTheMonthlyWindowAnswersAsBefore(): void
    {
        $body = $this->json($this->call('positions', ['body' => 'mars']));
        self::assertArrayNotHasKey('year', $body);
        self::assertArrayNotHasKey('slice_start', $body);
        self::assertArrayHasKey('start', $body);
        self::assertArrayNotHasKey('year', $this->json($this->call('orbit', ['body' => 'mars'])));
        self::assertArrayNotHasKey('year', $this->json($this->call('orientation', ['body' => 'mars'])));
    }
}
