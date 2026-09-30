<?php

namespace App\Tests\Service;

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
use Symfony\Component\HttpClient\MockHttpClient;
use Symfony\Component\HttpClient\Response\MockResponse;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;

final class NeoFeedBuilderTest extends TestCase
{
    private const FIXTURES = __DIR__.'/../Fixtures/';

    private string $logPath;

    protected function setUp(): void
    {
        $this->logPath = sys_get_temp_dir().'/nasa-viz-test-'.bin2hex(random_bytes(4)).'/neo-comparison.jsonl';
    }

    protected function tearDown(): void
    {
        @unlink($this->logPath);
        @rmdir(dirname($this->logPath));
    }

    /** @param \Closure(string $url): ?MockResponse $override */
    private function builder(?\Closure $override = null): array
    {
        $http = new MockHttpClient(function (string $method, string $url) use ($override) {
            if ($override && ($response = $override($url))) {
                return $response;
            }
            parse_str((string) parse_url($url, PHP_URL_QUERY), $query);
            $fixture = match (true) {
                str_contains($url, 'cad.api') => isset($query['pha']) ? 'cad_pha.json' : 'cad_all.json',
                str_contains($url, 'sentry.api') => 'sentry_list.json',
                str_contains($url, '/feed') => 'neows_feed.json',
                str_contains($url, 'esa.test') => $query['file'].'.txt',
                default => throw new \LogicException("La doublure HTTP ne connait pas cette URL : $url"),
            };

            return new MockResponse(file_get_contents(self::FIXTURES.$fixture));
        });
        $cache = new ArrayAdapter();
        $tracker = new NasaUsageTracker($cache);
        $log = new NeoComparisonLog($this->logPath, $cache);
        $builder = new NeoFeedBuilder(
            new JplCadClient($http, 'https://jpl.test'),
            new NasaApiClient($http, $tracker, 'https://nasa.test', 'DEMO_KEY'),
            new EsaNeoccClient($http, 'https://esa.test'),
            new NeoFeedMerger(),
            $log,
            $cache,
            new NullLogger(),
        );

        return [$builder, $tracker, $log];
    }

    public function testAllSourcesMergedAndJournaled(): void
    {
        [$builder, $tracker, $log] = $this->builder();

        $feed = $builder->build('2026-09-17', '2026-09-18');

        self::assertSame(['jpl_cad' => 'ok', 'nasa_neows' => 'ok', 'esa_neocc' => 'ok', 'jpl_sentry' => 'ok', 'esa_risk_list' => 'ok'], $feed['sources']);
        // 25 JPL approaches + "(2019 ZZ9)", only in the NeoWs fixture (ESA's 2026 RF15 passes on the 19th, outside the range).
        self::assertSame(26, $feed['count']);
        $objects = array_column($feed['objects'], null, 'designation');
        self::assertSame(['jpl_cad', 'nasa_neows', 'esa_neocc'], $objects['2026 NT2']['sources']);
        self::assertSame(['nasa_neows'], $objects['2019 ZZ9']['sources']);
        self::assertSame(['jpl_cad', 'esa_neocc'], $objects['2026 RD38']['sources']);
        self::assertArrayNotHasKey('2026 RF15', $objects);
        self::assertSame(1, $tracker->getTodayCount(), 'only NeoWs is counted against the NASA quota');

        $entries = iterator_to_array($log->read(), false);
        self::assertCount(1, $entries);
        self::assertSame('2026-09-17T14:17Z', $entries[0]['source_updates']['esa_neocc']);
        self::assertCount(26, $entries[0]['objects']);

        $builder->build('2026-09-17', '2026-09-18');
        self::assertCount(1, iterator_to_array($log->read(), false), 'unchanged data is not journaled twice');
    }

    public function testNeowsQuotaExhaustedDegradesToOtherSources(): void
    {
        [$builder] = $this->builder(static fn (string $url) => str_contains($url, '/feed')
            ? new MockResponse('{"error":{"code":"OVER_RATE_LIMIT"}}', ['http_code' => 429])
            : null);

        $feed = $builder->build('2026-09-17', '2026-09-18');

        self::assertSame('unavailable', $feed['sources']['nasa_neows']);
        self::assertSame(25, $feed['count']);
        self::assertSame(25, $feed['comparison']['nasa_neows']['unavailable']);
    }

    public function testNoCloseApproachSourceIsAnError(): void
    {
        [$builder] = $this->builder(static fn (string $url) => str_contains($url, 'sentry') ? null : new MockResponse('down', ['http_code' => 503]));

        $this->expectException(ExceptionInterface::class);
        $builder->build('2026-09-17', '2026-09-18');
    }
}
