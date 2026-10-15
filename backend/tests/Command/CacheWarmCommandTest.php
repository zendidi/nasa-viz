<?php

namespace App\Tests\Command;

use App\Command\CacheWarmCommand;
use App\Controller\SpaceDataController;
use App\Service\ApodClient;
use App\Service\CachedFeeds;
use App\Service\EsaNeoccClient;
use App\Service\JplCadClient;
use App\Service\NasaApiClient;
use App\Service\NasaUsageTracker;
use App\Service\NeoComparisonLog;
use App\Service\NeoFeedBuilder;
use App\Service\NeoFeedMerger;
use PHPUnit\Framework\TestCase;
use Psr\Log\NullLogger;
use Symfony\Component\Cache\Adapter\ArrayAdapter;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Tester\CommandTester;
use Symfony\Component\HttpClient\MockHttpClient;
use Symfony\Component\HttpClient\Response\MockResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Contracts\Cache\ItemInterface;

/**
 * Offline by construction: every upstream is a MockHttpClient answering from a
 * fixture, and `$calls` counts what would have reached each host -- so "NEO is
 * not touched" is a number, not a hope. NeoWs is the one that spends the shared
 * DEMO_KEY quota.
 */
final class CacheWarmCommandTest extends TestCase
{
    private const FIXTURES = __DIR__.'/../Fixtures/';

    private string $logPath;
    private ArrayAdapter $cache;
    private CachedFeeds $feeds;
    /** @var array{neows: int, apod: int, other: int} */
    private array $calls;
    private bool $apodDown = false;

    protected function setUp(): void
    {
        $this->logPath = sys_get_temp_dir().'/nasa-viz-test-'.bin2hex(random_bytes(4)).'/neo-comparison.jsonl';
        $this->calls = ['neows' => 0, 'apod' => 0, 'other' => 0];
        $this->apodDown = false;

        $http = new MockHttpClient(function (string $method, string $url) {
            parse_str((string) parse_url($url, PHP_URL_QUERY), $query);
            if (str_contains($url, 'science.test')) {
                ++$this->calls['apod'];

                return $this->apodDown
                    ? new MockResponse('down', ['http_code' => 503])
                    : new MockResponse(file_get_contents(self::FIXTURES.'science_apod_list.json'));
            }
            if (str_contains($url, '/feed')) {
                ++$this->calls['neows'];
            } else {
                ++$this->calls['other'];
            }

            return new MockResponse(file_get_contents(self::FIXTURES.match (true) {
                str_contains($url, 'cad.api') => isset($query['pha']) ? 'cad_pha.json' : 'cad_all.json',
                str_contains($url, 'sentry.api') => 'sentry_list.json',
                str_contains($url, '/feed') => 'neows_feed.json',
                str_contains($url, 'esa.test') => $query['file'].'.txt',
                default => throw new \LogicException("unexpected URL $url"),
            }));
        });

        $this->cache = new ArrayAdapter();
        $builder = new NeoFeedBuilder(
            new JplCadClient($http, 'https://jpl.test'),
            new NasaApiClient($http, new NasaUsageTracker($this->cache), 'https://nasa.test', 'DEMO_KEY'),
            new EsaNeoccClient($http, 'https://esa.test'),
            new NeoFeedMerger(),
            new NeoComparisonLog($this->logPath, $this->cache),
            $this->cache,
            new NullLogger(),
        );
        $this->feeds = new CachedFeeds($this->cache, $builder, new ApodClient($http, 'https://science.test'));
    }

    protected function tearDown(): void
    {
        @unlink($this->logPath);
        @rmdir(dirname($this->logPath));
    }

    /** @param array<string, mixed> $input */
    private function warm(array $input = []): CommandTester
    {
        $tester = new CommandTester(new CacheWarmCommand($this->feeds));
        $tester->execute($input);

        return $tester;
    }

    public function testApodIsWarmedByDefaultAndNeoIsNotTouched(): void
    {
        $tester = $this->warm();

        self::assertSame(Command::SUCCESS, $tester->getStatusCode());
        self::assertSame(1, $this->calls['apod']);
        self::assertSame(0, $this->calls['neows'], 'NeoWs spends the shared quota: never without --neo');
        self::assertSame(0, $this->calls['other'], 'no NEO source at all without --neo');
        self::assertTrue($this->cache->getItem(CachedFeeds::apodKey())->isHit());
        [$start, $end] = CachedFeeds::defaultNeoRange();
        self::assertFalse($this->cache->getItem(CachedFeeds::neoKey($start, $end))->isHit());
        self::assertStringContainsString('neo skipped', $tester->getDisplay());
    }

    public function testNeoFlagWarmsTheRoutesDefaultRange(): void
    {
        $this->warm(['--neo' => true]);

        [$start, $end] = CachedFeeds::defaultNeoRange();
        self::assertSame(1, $this->calls['neows']);
        self::assertTrue($this->cache->getItem('neo_feed_'.$start.'_'.$end)->isHit());
        self::assertSame($start, (new \DateTimeImmutable('today'))->format('Y-m-d'));
        self::assertSame($end, (new \DateTimeImmutable('tomorrow'))->format('Y-m-d'));
    }

    public function testNeoFlagRecomputesAnEntryThatIsStillFresh(): void
    {
        [$start, $end] = CachedFeeds::defaultNeoRange();
        $this->feeds->neoFeed($start, $end);
        self::assertSame(1, $this->calls['neows']);

        // What the route does: a fresh entry is served, NeoWs untouched.
        $this->feeds->neoFeed($start, $end);
        self::assertSame(1, $this->calls['neows'], 'a plain get must not recompute');

        $this->warm(['--neo' => true]);
        self::assertSame(2, $this->calls['neows'], '--neo renews before expiry, it does not wait for a miss');
    }

    public function testApodIsRecomputedEvenWhenFresh(): void
    {
        $this->feeds->apod();
        $this->feeds->apod();
        self::assertSame(1, $this->calls['apod']);

        $this->warm();
        self::assertSame(2, $this->calls['apod']);
    }

    public function testDryRunFetchesNothing(): void
    {
        $tester = $this->warm(['--neo' => true, '--dry-run' => true]);

        self::assertSame(Command::SUCCESS, $tester->getStatusCode());
        self::assertSame(['neows' => 0, 'apod' => 0, 'other' => 0], $this->calls);
        self::assertStringContainsString('[dry run]', $tester->getDisplay());
    }

    public function testAnUpstreamFailureStillExitsZeroAndKeepsTheOldEntry(): void
    {
        $before = $this->feeds->apod();
        $this->apodDown = true;

        $tester = $this->warm();

        self::assertSame(Command::SUCCESS, $tester->getStatusCode(), 'a cron must not mail about a transient upstream');
        self::assertStringContainsString('1 failed', $tester->getDisplay());
        self::assertSame($before, $this->feeds->apod(), 'a failed refresh must not evict the entry visitors are served');
    }

    public function testTheRoutesReadAndWriteTheKeysAndTtlsTheWarmUses(): void
    {
        $controller = new SpaceDataController($this->cache, new NullLogger());
        $today = (new \DateTimeImmutable('today'))->format('Y-m-d');
        $tomorrow = (new \DateTimeImmutable('tomorrow'))->format('Y-m-d');

        self::assertSame(200, $controller->neo(Request::create('/api/neo'), $this->feeds)->getStatusCode());
        self::assertSame(200, $controller->apod($this->feeds)->getStatusCode());

        // Literal keys on purpose: they are the contract between route and warm.
        $neo = $this->cache->getItem('neo_feed_'.$today.'_'.$tomorrow);
        $apod = $this->cache->getItem('apod_'.$today);
        self::assertTrue($neo->isHit());
        self::assertTrue($apod->isHit());
        self::assertEqualsWithDelta(time() + 3600, $neo->getMetadata()[ItemInterface::METADATA_EXPIRY], 5);
        self::assertEqualsWithDelta(time() + 86400, $apod->getMetadata()[ItemInterface::METADATA_EXPIRY], 5);

        // The warm renews the very entries the routes just wrote.
        $this->warm(['--neo' => true]);
        self::assertSame(2, $this->calls['neows']);
        self::assertSame(2, $this->calls['apod']);
    }
}
