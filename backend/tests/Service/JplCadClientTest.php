<?php

namespace App\Tests\Service;

use App\Service\JplCadClient;
use PHPUnit\Framework\TestCase;
use Symfony\Component\HttpClient\MockHttpClient;
use Symfony\Component\HttpClient\Response\MockResponse;

final class JplCadClientTest extends TestCase
{
    private const FIXTURES = __DIR__.'/../Fixtures/';

    public function testApproachesAreReadByFieldNameWithPhaFlag(): void
    {
        $urls = [];
        $http = new MockHttpClient(function (string $method, string $url) use (&$urls) {
            $urls[] = urldecode($url);

            return new MockResponse(file_get_contents(self::FIXTURES.(str_contains($url, 'pha=true') ? 'cad_pha.json' : 'cad_all.json')));
        });
        $client = new JplCadClient($http, 'https://jpl.test');

        $approaches = ($client->requestApproaches(new \DateTimeImmutable('2026-09-17'), new \DateTimeImmutable('2026-09-18')))();

        self::assertCount(25, $approaches);
        $byDesignation = array_column($approaches, null, 'designation');

        $nt2 = $byDesignation['2026 NT2'];
        self::assertTrue($nt2['is_pha']);
        self::assertSame('2026-09-17T05:07Z', $nt2['approach_at']);
        self::assertSame('2026-09-17', $nt2['date']);
        self::assertEqualsWithDelta(0.0413304639733313, $nt2['dist_au'], 1e-12);
        self::assertLessThan($nt2['dist_au'], $nt2['dist_min_au']);
        self::assertNull($nt2['number']);
        self::assertSame('(2026 NT2)', $nt2['name']);

        $numbered = $byDesignation['2004 TR12'];
        self::assertSame('260277', $numbered['number']);
        self::assertFalse($numbered['is_pha']);
        self::assertSame(0.47, $numbered['diameter_km']);

        self::assertCount(2, $urls);
        self::assertStringContainsString('date-min=2026-09-17T00:00:00', $urls[0]);
        self::assertStringContainsString('date-max=2026-09-18T23:59:59', $urls[0]);
        self::assertStringContainsString('kind=a', $urls[0]);
        self::assertStringContainsString('dist-max='.JplCadClient::DIST_MAX_AU, $urls[0]);
    }

    public function testSentryList(): void
    {
        $client = new JplCadClient(new MockHttpClient(new MockResponse(file_get_contents(self::FIXTURES.'sentry_list.json'))), 'https://jpl.test');

        $rows = array_column(($client->requestSentryList())(), null, 'name');

        self::assertSame('1979 XB', $rows['(1979 XB)']['designation']);
        self::assertSame('101955', $rows['101955 Bennu (1999 RQ36)']['number']);
        self::assertSame('1999 RQ36', $rows['101955 Bennu (1999 RQ36)']['designation']);
        self::assertEqualsWithDelta(8.515158e-07, $rows['(1979 XB)']['impact_probability'], 1e-12);
    }

    /**
     * A day without a single PHA approach: cad.api answers 200 with only
     * {signature, count: 0}. Nothing is wrong — every approach is simply
     * non-PHA — so the source must stay usable (regression, 2026-09-18).
     */
    public function testEmptyPhaResultKeepsTheSourceUsable(): void
    {
        $http = new MockHttpClient(static fn (string $method, string $url) => new MockResponse(
            str_contains($url, 'pha=true')
                ? '{"signature":{"source":"NASA/JPL SBDB Close Approach Data API","version":"1.5"},"count":0}'
                : file_get_contents(self::FIXTURES.'cad_all.json'),
        ));
        $client = new JplCadClient($http, 'https://jpl.test');

        $approaches = ($client->requestApproaches(new \DateTimeImmutable('2026-09-17'), new \DateTimeImmutable('2026-09-18')))();

        self::assertCount(25, $approaches);
        self::assertSame([], array_filter(array_column($approaches, 'is_pha')));
    }

    /** A non-empty answer that really is missing "fields" is still a failure. */
    public function testMalformedAnswerStillFails(): void
    {
        $client = new JplCadClient(
            new MockHttpClient(static fn () => new MockResponse('{"count":3}')),
            'https://jpl.test',
        );
        $resolve = $client->requestApproaches(new \DateTimeImmutable('2026-09-17'), new \DateTimeImmutable('2026-09-17'));

        $this->expectException(\UnexpectedValueException::class);
        $resolve();
    }

    public function testHttpErrorSurfacesWhenCollected(): void
    {
        $client = new JplCadClient(new MockHttpClient(static fn () => new MockResponse('{"message":"bad"}', ['http_code' => 400])), 'https://jpl.test');
        $resolve = $client->requestApproaches(new \DateTimeImmutable('2026-09-17'), new \DateTimeImmutable('2026-09-17'));

        $this->expectException(\Symfony\Contracts\HttpClient\Exception\ExceptionInterface::class);
        $resolve();
    }
}
