<?php

namespace App\Tests\Controller;

use App\Controller\SmallBodyController;
use App\Service\HorizonsClient;
use App\Service\JplCadClient;
use App\Service\SmallBodyPositionsClient;
use App\Service\SmallBodySearchClient;
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
 * The route end to end over mocked upstreams and an in-memory cache pool: the
 * controller has no kernel dependency a test would need.
 */
final class SmallBodyPositionsRouteTest extends TestCase
{
    private const FIXTURES = __DIR__.'/../Fixtures/';
    private const VECTORS = "\$\$SOE\n2461299.5, A.D. 2026-Sep-16 00:00:00.0000, 1.0, 2.0, 3.0,\n\$\$EOE";

    private ArrayAdapter $pool;
    /** @var list<string> */
    private array $requested = [];
    private bool $cadDown = false;
    private bool $horizonsDown = false;

    protected function setUp(): void
    {
        $this->pool = new ArrayAdapter();
        $this->requested = [];
        $this->cadDown = false;
        $this->horizonsDown = false;
    }

    private function call(string $spkid): JsonResponse
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

            // SBDB: the Apophis fixture for its SPK-ID, "not found" for anything else.
            return new MockResponse(file_get_contents(self::FIXTURES.('20099942' === $q['sstr'] ? 'sbdb_search_apophis.json' : 'sbdb_search_notfound.json')));
        });
        $controller = new SmallBodyController(new NullLogger());

        return $controller->smallBodyPositions(
            new Request(['spkid' => $spkid]),
            new SmallBodySearchClient($http, 'https://jpl.test'),
            new SmallBodyPositionsClient(new HorizonsClient($http, 'https://horizons.test'), new JplCadClient($http, 'https://jpl.test')),
            $this->pool,
        );
    }

    /** @return iterable<string, array{string}> */
    public static function invalidSpkids(): iterable
    {
        yield 'empty' => [''];
        yield 'non-digits' => ['abc1234'];
        yield 'six digits' => ['123456'];
        yield 'nine digits' => ['123456789'];
        yield 'one bad among good' => ['20099942,2009994x'];
        yield 'two ids: one asteroid per call' => ['20099942,20000243'];
    }

    #[DataProvider('invalidSpkids')]
    public function testInvalidSpkidsAreRefused(string $spkid): void
    {
        self::assertSame(400, $this->call($spkid)->getStatusCode());
        self::assertSame([], $this->requested);
    }

    public function testTheSameIdTwiceIsStillOneAsteroid(): void
    {
        $response = $this->call('20099942,20099942');

        self::assertSame(200, $response->getStatusCode());
        self::assertCount(1, json_decode((string) $response->getContent(), true)['objects']);
    }

    public function testWindowIsThePlanetsWindowAndUnknownSpkidIsNull(): void
    {
        $body = json_decode((string) $this->call('20099942')->getContent(), true);
        $unknown = json_decode((string) $this->call('99999999')->getContent(), true);

        $windowStart = SolarSystemClient::windowStart(new \DateTimeImmutable('now', new \DateTimeZone('UTC')));
        self::assertSame(SolarSystemClient::positionsStart($windowStart)->getTimestamp(), $body['window']['start']);
        self::assertSame($windowStart->modify('+365 days')->getTimestamp(), $body['window']['end']);
        self::assertSame('UTC', $body['time_scale']);
        self::assertSame('ICRF geocentric', $body['frame']);
        self::assertNull($unknown['objects']['99999999']);
        self::assertSame('99942 Apophis (2004 MN4)', $body['objects']['20099942']['fullname']);
        self::assertTrue($body['objects']['20099942']['neo']);
        self::assertSame($body['window']['start'], $body['objects']['20099942']['table']['start']);
    }

    public function testSecondCallIsServedFromCache(): void
    {
        $this->call('20099942');
        $after = count($this->requested);
        $second = json_decode((string) $this->call('20099942')->getContent(), true);

        self::assertSame($after, count($this->requested));
        self::assertSame([], $second['objects']['20099942']['close_approaches']);
    }

    public function testCadFailureIsServedWithNullApproachesAndNotCached(): void
    {
        $this->cadDown = true;
        $first = json_decode((string) $this->call('20099942')->getContent(), true);
        self::assertNull($first['objects']['20099942']['close_approaches']);

        $this->cadDown = false;
        $second = json_decode((string) $this->call('20099942')->getContent(), true);
        self::assertSame([], $second['objects']['20099942']['close_approaches'], 'retried, not served from cache');
    }

    public function testHorizonsOutageIs502AndNothingIsCached(): void
    {
        $this->horizonsDown = true;
        $down = $this->call('20099942');
        self::assertSame(502, $down->getStatusCode());
        self::assertSame('JPL', json_decode((string) $down->getContent(), true)['source'], 'the panel says who is down');

        $this->horizonsDown = false;
        self::assertSame(200, $this->call('20099942')->getStatusCode());
        self::assertNotNull(json_decode((string) $this->call('20099942')->getContent(), true)['objects']['20099942']);
    }
}
