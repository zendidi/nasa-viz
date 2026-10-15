<?php

namespace App\Tests\Service;

use App\Service\EsaNeoccClient;
use App\Service\HorizonsClient;
use App\Service\IssPositionClient;
use App\Service\JplCadClient;
use App\Service\NasaApiClient;
use App\Service\NasaUsageTracker;
use App\Service\SmallBodyDetailsClient;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Symfony\Component\Cache\Adapter\ArrayAdapter;
use Symfony\Component\HttpClient\Exception\TransportException;
use Symfony\Component\HttpClient\MockHttpClient;
use Symfony\Component\HttpClient\Response\MockResponse;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;
use Symfony\Contracts\HttpClient\Exception\TransportExceptionInterface;

/**
 * Every outgoing client carries an explicit time budget, and an upstream that
 * goes silent comes out as the exception its route already catches.
 *
 * Why it is pinned: without a budget a client inherits `default_socket_timeout`
 * (60 s), longer than PHP's 30 s `max_execution_time`, so a hung upstream became
 * an uncatchable fatal rendered as HTTP 200 (2026-09-30, see ApodClient and
 * docs/agent/gotchas.md). Two halves, because either alone proves little:
 * the options really sent, and the exception really thrown on a stalled body
 * (a MockResponse whose generator yields '' is an idle timeout).
 */
final class UpstreamBudgetTest extends TestCase
{
    /** PHP's wall for a web request is 30 s; no single request may be allowed to approach it. */
    private const LONGEST_ALLOWED_SECONDS = 22;

    /**
     * @param list<array{string, array<string, mixed>}> $sent
     */
    private function stalled(array &$sent): MockHttpClient
    {
        return new MockHttpClient(function (string $method, string $url, array $options) use (&$sent) {
            $sent[] = [$url, $options];

            return new MockResponse((static function () {
                yield '';
            })());
        });
    }

    /** @return iterable<string, array{\Closure(MockHttpClient): mixed}> */
    public static function clients(): iterable
    {
        $start = new \DateTimeImmutable('2026-10-15', new \DateTimeZone('UTC'));

        yield 'ISS' => [static fn (MockHttpClient $http) => (new IssPositionClient($http, 'https://iss.test'))->getPosition()];
        yield 'NeoWs' => [static fn (MockHttpClient $http) => (new NasaApiClient($http, new NasaUsageTracker(new ArrayAdapter()), 'https://nasa.test', 'KEY'))
            ->requestNeoApproaches('2026-10-15', '2026-10-16')()];
        yield 'JPL CAD' => [static fn (MockHttpClient $http) => (new JplCadClient($http, 'https://jpl.test'))->requestApproaches($start, $start)()];
        yield 'JPL Sentry list' => [static fn (MockHttpClient $http) => (new JplCadClient($http, 'https://jpl.test'))->requestSentryList()()];
        yield 'ESA close approaches' => [static fn (MockHttpClient $http) => (new EsaNeoccClient($http, 'https://esa.test'))->requestCloseApproaches()()];
        yield 'ESA risk list' => [static fn (MockHttpClient $http) => (new EsaNeoccClient($http, 'https://esa.test'))->requestRiskList()()];
        yield 'Horizons vectors' => [static fn (MockHttpClient $http) => (new HorizonsClient($http, 'https://horizons.test'))
            ->getVectors(['2014 SU1', '2024 YR4'], $start, $start->modify('+1 day'))];
        yield 'Horizons orientation' => [static fn (MockHttpClient $http) => (new HorizonsClient($http, 'https://horizons.test'))
            ->getOrientations(['mars' => '499'], $start)];
        // SBDB and ssoCard both silent is the one case getDetails() throws on.
        yield 'SBDB + ssoCard' => [static fn (MockHttpClient $http) => (new SmallBodyDetailsClient(
            $http,
            'https://jpl.test',
            'https://sso.test',
            new EsaNeoccClient($http, 'https://esa.test'),
        ))->getDetails(['99942'])];
    }

    /** @param \Closure(MockHttpClient): mixed $call */
    #[DataProvider('clients')]
    public function testEveryRequestCarriesAnExplicitBudgetUnderTheWall(\Closure $call): void
    {
        $sent = [];
        try {
            $call($this->stalled($sent));
        } catch (ExceptionInterface) {
            // Expected; the next test asserts on it.
        }

        self::assertNotSame([], $sent);
        foreach ($sent as [$url, $options]) {
            self::assertGreaterThan(0, $options['max_duration'], "$url has no max_duration");
            self::assertLessThanOrEqual(self::LONGEST_ALLOWED_SECONDS, $options['max_duration'], $url);
            self::assertLessThanOrEqual($options['max_duration'], $options['timeout'], "$url idle timeout above its own max_duration");
        }
    }

    /** @param \Closure(MockHttpClient): mixed $call */
    #[DataProvider('clients')]
    public function testASilentUpstreamBecomesAnExceptionTheRouteCatches(\Closure $call): void
    {
        $sent = [];

        // Every route catches ExceptionInterface; a transport failure must be one.
        $this->expectException(TransportExceptionInterface::class);
        $call($this->stalled($sent));
    }

    public function testEsaFollowUpIsRefusedOncePastTheRouteDeadline(): void
    {
        $sent = [];
        $client = new EsaNeoccClient($this->stalled($sent), 'https://esa.test');

        try {
            $client->requestOrbit('99942', microtime(true) - 1);
            self::fail('a spent deadline must refuse the request');
        } catch (TransportException) {
            self::assertSame([], $sent, 'nothing may be sent once the budget is gone');
        }
    }

    public function testEsaFollowUpIsCappedByWhatIsLeftOfTheDeadline(): void
    {
        $sent = [];
        $client = new EsaNeoccClient(new MockHttpClient(function (string $method, string $url, array $options) use (&$sent) {
            $sent[] = [$url, $options];

            return new MockResponse('');
        }), 'https://esa.test');

        $client->requestOrbit('99942', microtime(true) + 3)();

        self::assertLessThanOrEqual(3, $sent[0][1]['max_duration']);
        self::assertLessThanOrEqual(3, $sent[0][1]['timeout']);
    }
}
