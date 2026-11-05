<?php

namespace App\Tests\Controller;

use App\Controller\SmallBodyController;
use App\Service\HorizonsClient;
use App\Service\JplCadClient;
use App\Service\SmallBodySearchClient;
use App\Service\SmallBodyTrajectoryClient;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Psr\Log\NullLogger;
use Symfony\Component\Cache\Adapter\ArrayAdapter;
use Symfony\Component\HttpClient\MockHttpClient;
use Symfony\Component\HttpClient\Response\MockResponse;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;

/**
 * The three lot-2 routes end to end over mocked upstreams and an in-memory pool.
 * "Now" is the real clock, as in SmallBodyPositionsRouteTest: the years asked for
 * are derived from it, never hard-coded.
 */
final class SmallBodyTrajectoryRouteTest extends TestCase
{
    private const FIXTURES = __DIR__.'/../Fixtures/';
    private const VECTORS = "\$\$SOE\n2461299.5, A.D. 2026-Sep-16 00:00:00.0000, 1.0, 2.0, 3.0,\n\$\$EOE";
    private const MAIN_BELT = '{"object":{"spkid":"20000001","des":"1","fullname":"1 Ceres","kind":"an","neo":false},"orbit":{"orbit_id":"42"}}';

    private ArrayAdapter $pool;
    /** @var list<string> */
    private array $requested = [];
    private bool $cadDown = false;
    private bool $horizonsDown = false;
    private string $orbitId = '220';

    protected function setUp(): void
    {
        $this->pool = new ArrayAdapter();
        $this->requested = [];
        $this->cadDown = false;
        $this->horizonsDown = false;
        $this->orbitId = '220';
    }

    private static function year(): int
    {
        return (int) gmdate('Y');
    }

    /** @param array<string, string> $query */
    private function call(string $route, array $query = []): JsonResponse
    {
        $http = new MockHttpClient(function (string $method, string $url) {
            $this->requested[] = $url;
            parse_str((string) parse_url($url, PHP_URL_QUERY), $q);
            if (str_contains($url, 'horizons.test')) {
                return $this->horizonsDown ? new MockResponse('', ['http_code' => 503]) : new MockResponse(json_encode(['result' => self::VECTORS]));
            }
            if (str_contains($url, 'cad.api')) {
                return $this->cadDown ? new MockResponse('', ['http_code' => 500]) : new MockResponse(json_encode(['count' => 0]));
            }
            if ('20000001' === $q['sstr']) {
                return new MockResponse(self::MAIN_BELT);
            }
            if ('20099942' === $q['sstr']) {
                return new MockResponse(str_replace('"orbit_id":"220"', '"orbit_id":"'.$this->orbitId.'"', (string) file_get_contents(self::FIXTURES.'sbdb_search_apophis.json')));
            }

            return new MockResponse((string) file_get_contents(self::FIXTURES.'sbdb_search_notfound.json'));
        });
        $controller = new SmallBodyController(new NullLogger());
        $search = new SmallBodySearchClient($http, 'https://jpl.test');
        $trajectory = new SmallBodyTrajectoryClient(new HorizonsClient($http, 'https://horizons.test'), new JplCadClient($http, 'https://jpl.test'));
        $request = new Request($query);

        return match ($route) {
            'trajectory' => $controller->smallBodyTrajectory($request, $search, $trajectory, $this->pool),
            'precision' => $controller->smallBodyPrecision($request, $search, $trajectory, $this->pool),
            default => $controller->smallBodyTrajectorySun($trajectory, $this->pool),
        };
    }

    /** @return array<string, mixed> */
    private function json(JsonResponse $response): array
    {
        return json_decode((string) $response->getContent(), true);
    }

    private function horizonsCalls(): int
    {
        return count(array_filter($this->requested, static fn (string $u) => str_contains($u, 'horizons.test')));
    }

    /** @return iterable<string, array{string}> */
    public static function invalidSpkids(): iterable
    {
        yield 'empty' => [''];
        yield 'non-digits' => ['abc1234'];
        yield 'six digits' => ['123456'];
        yield 'nine digits' => ['123456789'];
        yield 'two ids' => ['20099942,20000243'];
    }

    #[DataProvider('invalidSpkids')]
    public function testInvalidSpkidIs400OnBothObjectRoutesAndNothingIsAsked(string $spkid): void
    {
        self::assertSame(400, $this->call('trajectory', ['spkid' => $spkid])->getStatusCode());
        self::assertSame(400, $this->call('precision', ['spkid' => $spkid, 'year' => (string) self::year()])->getStatusCode());
        self::assertSame([], $this->requested);
    }

    /** @return iterable<string, array{int}> offset from the current year */
    public static function badYearOffsets(): iterable
    {
        yield 'two years back' => [-2];
        yield 'five years ahead' => [5];
        yield 'far' => [100];
    }

    #[DataProvider('badYearOffsets')]
    public function testYearOutsideTheRangeIs400(int $offset): void
    {
        $response = $this->call('precision', ['spkid' => '20099942', 'year' => (string) (self::year() + $offset)]);

        self::assertSame(400, $response->getStatusCode());
        self::assertArrayHasKey('error', $this->json($response));
        self::assertSame([], $this->requested);
    }

    public function testYearMustBeADigitsOnlyIntegerAndIsRequired(): void
    {
        foreach (['', 'abc', '2029.5', '-2029', '20 29'] as $year) {
            self::assertSame(400, $this->call('precision', ['spkid' => '20099942', 'year' => $year])->getStatusCode(), "year=\"$year\"");
        }
        self::assertSame(400, $this->call('precision', ['spkid' => '20099942'])->getStatusCode());
    }

    public function testYearBoundsAreIncluded(): void
    {
        foreach ([self::year() - 1, self::year() + 4] as $year) {
            self::assertSame(200, $this->call('precision', ['spkid' => '20000001', 'year' => (string) $year])->getStatusCode());
        }
    }

    public function testTrajectoryServesTheRangeOfSixCalendarYears(): void
    {
        $body = $this->json($this->call('trajectory', ['spkid' => '20099942']));

        $y = self::year();
        self::assertSame(gmmktime(0, 0, 0, 1, 1, $y - 1), $body['range']['start']);
        self::assertSame(gmmktime(0, 0, 0, 1, 1, $y + 5), $body['range']['end']);
        self::assertSame('UTC', $body['time_scale']);
        self::assertSame('ICRF geocentric', $body['frame']);
        $object = $body['objects']['20099942'];
        self::assertSame('220', $object['orbit_id']);
        self::assertTrue($object['neo']);
        self::assertSame(86400, $object['table']['step_seconds']);
        self::assertSame($body['range']['start'], $object['table']['start']);
        self::assertSame([], $object['close_approaches']);
        self::assertNull($object['next_close_approach_after_range']);
    }

    public function testUnknownSpkidIsANullObject(): void
    {
        $body = $this->json($this->call('trajectory', ['spkid' => '99999999']));

        self::assertNull($body['objects']['99999999']);
        self::assertSame(0, $this->horizonsCalls());
    }

    public function testNonNeoPrecisionIsAnObjectWithoutTableAndNoHorizonsCall(): void
    {
        $body = $this->json($this->call('precision', ['spkid' => '20000001', 'year' => (string) self::year()]));

        $object = $body['objects']['20000001'];
        self::assertFalse($object['neo']);
        self::assertNull($object['table']);
        self::assertSame([], $object['segments']);
        self::assertSame(self::year(), $object['year']);
        self::assertSame('42', $object['orbit_id']);
        self::assertSame(self::year(), $body['year']);
        self::assertSame(0, $this->horizonsCalls());
    }

    public function testSecondCallIsServedFromCache(): void
    {
        $year = (string) self::year();
        $this->call('trajectory', ['spkid' => '20099942']);
        $this->call('trajectory', ['spkid' => '20099942']);
        self::assertSame(1, $this->horizonsCalls());

        $this->call('precision', ['spkid' => '20099942', 'year' => $year]);
        $this->call('precision', ['spkid' => '20099942', 'year' => $year]);
        self::assertSame(2, $this->horizonsCalls(), 'precision is its own entry, fetched once');
    }

    public function testANewOrbitSolutionIsAMissAndTheSameOneIsAHit(): void
    {
        $this->call('trajectory', ['spkid' => '20099942']);
        self::assertSame(1, $this->horizonsCalls());

        // The search entry expires after a day; the table is keyed on what it said.
        $this->pool->deleteItem(SmallBodySearchClient::cacheKey('20099942'));
        $this->call('trajectory', ['spkid' => '20099942']);
        self::assertSame(1, $this->horizonsCalls(), 'same orbit_id: still a hit');

        $this->pool->deleteItem(SmallBodySearchClient::cacheKey('20099942'));
        $this->orbitId = '221';
        $object = $this->json($this->call('trajectory', ['spkid' => '20099942']))['objects']['20099942'];
        self::assertSame(2, $this->horizonsCalls(), 'other orbit_id: refetched');
        self::assertSame('221', $object['orbit_id']);
    }

    public function testCadFailureIsServedWithNullApproachesAndNotCached(): void
    {
        $this->cadDown = true;
        $first = $this->json($this->call('trajectory', ['spkid' => '20099942']))['objects']['20099942'];
        self::assertNull($first['close_approaches']);

        $this->cadDown = false;
        $second = $this->json($this->call('trajectory', ['spkid' => '20099942']))['objects']['20099942'];
        self::assertSame([], $second['close_approaches'], 'retried, not served from cache');
    }

    public function testCadFailureOnPrecisionGivesNullSegmentsAndIsNotCached(): void
    {
        $year = (string) self::year();
        $this->cadDown = true;
        $first = $this->json($this->call('precision', ['spkid' => '20099942', 'year' => $year]))['objects']['20099942'];
        self::assertNull($first['segments']);
        self::assertNotNull($first['table']);

        $this->cadDown = false;
        $second = $this->json($this->call('precision', ['spkid' => '20099942', 'year' => $year]))['objects']['20099942'];
        self::assertSame([], $second['segments']);
    }

    public function testHorizonsOutageIs502AndNothingIsCached(): void
    {
        $this->horizonsDown = true;
        $down = $this->call('trajectory', ['spkid' => '20099942']);
        self::assertSame(502, $down->getStatusCode());
        self::assertArrayHasKey('source', $this->json($down));

        $this->horizonsDown = false;
        self::assertNotNull($this->json($this->call('trajectory', ['spkid' => '20099942']))['objects']['20099942']);
    }

    public function testSunIsTheSameRangeAndCached(): void
    {
        $body = $this->json($this->call('sun'));
        $y = self::year();

        self::assertSame(gmmktime(0, 0, 0, 1, 1, $y - 1), $body['range']['start']);
        self::assertSame(gmmktime(0, 0, 0, 1, 1, $y + 5), $body['range']['end']);
        self::assertSame('UTC', $body['time_scale']);
        self::assertSame(86400, $body['table']['step_seconds']);
        self::assertSame($body['range']['start'], $body['table']['start']);

        $this->call('sun');
        self::assertSame(1, $this->horizonsCalls());
    }

    public function testSunOutageIs502WithItsSource(): void
    {
        $this->horizonsDown = true;
        $down = $this->call('sun');

        self::assertSame(502, $down->getStatusCode());
        self::assertSame('JPL Horizons', $this->json($down)['source']);
    }
}
