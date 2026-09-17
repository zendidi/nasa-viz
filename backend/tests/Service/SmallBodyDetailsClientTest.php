<?php

namespace App\Tests\Service;

use App\Service\SmallBodyDetailsClient;
use PHPUnit\Framework\TestCase;
use Symfony\Component\HttpClient\Exception\TransportException;
use Symfony\Component\HttpClient\MockHttpClient;
use Symfony\Component\HttpClient\Response\MockResponse;

final class SmallBodyDetailsClientTest extends TestCase
{
    private const FIXTURES = __DIR__.'/../Fixtures/';

    /**
     * @param array<string, array{string, int}> $routes "service|query" => [fixture file or raw body, HTTP code]
     */
    private function client(array $routes): SmallBodyDetailsClient
    {
        $http = new MockHttpClient(function (string $method, string $url) use ($routes) {
            parse_str((string) parse_url($url, PHP_URL_QUERY), $query);
            $service = match (true) {
                str_contains($url, 'sbdb.api') => 'sbdb|'.$query['sstr'],
                str_contains($url, 'ssocard.php') => 'ssocard|'.$query['q'],
                str_contains($url, 'sentry.api') => 'sentry|'.$query['des'],
            };
            [$body, $code] = $routes[$service] ?? ['{"error":"specified object not found"}', 200];
            $content = is_file(self::FIXTURES.$body) ? file_get_contents(self::FIXTURES.$body) : $body;

            return new MockResponse($content, ['http_code' => $code]);
        });

        return new SmallBodyDetailsClient($http, 'https://jpl.test', 'https://imcce.test');
    }

    public function testFullSheetPrefersSsocardPhysicsAndSbdbOrbit(): void
    {
        $details = $this->client([
            'sbdb|2004 MN4' => ['sbdb_apophis.json', 200],
            'ssocard|2004_MN4' => ['ssocard_apophis.json', 200],
            'sentry|2004 MN4' => ['sentry_removed.json', 200],
        ])->getDetails(['2004 MN4'])['2004 MN4'];

        self::assertSame('99942 Apophis (2004 MN4)', $details['fullname']);
        self::assertSame(['code' => 'ATE', 'name' => 'Aten'], $details['orbit_class']);
        self::assertTrue($details['is_pha']);
        self::assertSame(['class' => 'S', 'complex' => 'S', 'source' => 'ssocard'], $details['taxonomy']);
        self::assertSame(['value' => 0.34, 'source' => 'ssocard'], $details['diameter_km']);
        self::assertSame(0.000108, $details['moid_earth_au']);
        self::assertSame(0.922, $details['orbit']['a_au']);
        self::assertSame(2461200.5, $details['orbit']['epoch_jd']);
        self::assertSame(324.0, $details['orbit']['period_days']);
        self::assertNull($details['impact_risk']);
        self::assertSame(['sbdb' => 'ok', 'ssocard' => 'ok', 'sentry' => 'not_found'], $details['sources']);
        self::assertSame('https://ssp.imcce.fr/forms/ssocard/Apophis', $details['links']['ssocard']);
    }

    public function testRecentObjectFromSbdbOnly(): void
    {
        $details = $this->client([
            'sbdb|2026 NT2' => ['sbdb_2026_NT2.json', 200],
            'ssocard|2026_NT2' => ['ssocard_not_found.json', 404],
        ])->getDetails(['2026 NT2'])['2026 NT2'];

        self::assertSame(['code' => 'APO', 'name' => 'Apollo'], $details['orbit_class']);
        self::assertTrue($details['is_pha']);
        self::assertNull($details['taxonomy']);
        self::assertNull($details['diameter_km']);
        self::assertSame(0.0292, $details['moid_earth_au']);
        self::assertSame(['sbdb' => 'ok', 'ssocard' => 'not_found', 'sentry' => 'not_found'], $details['sources']);
        self::assertNull($details['links']['ssocard']);
    }

    public function testSsocardOnlyFallbackAndSentryRisk(): void
    {
        $details = $this->client([
            'sbdb|1979 XB' => ['sbdb_not_found.json', 200],
            'ssocard|1979_XB' => ['ssocard_2013_ST.json', 200],
            'sentry|1979 XB' => ['sentry_1979_XB.json', 200],
        ])->getDetails(['1979 XB'])['1979 XB'];

        self::assertSame(['code' => null, 'name' => 'NEA>Aten'], $details['orbit_class']);
        self::assertFalse($details['is_pha']);
        self::assertSame(24.7, $details['absolute_magnitude_h']);
        self::assertSame(0.072178, $details['moid_earth_au']);
        self::assertNotNull($details['orbit']['a_au']);
        self::assertSame(8.515158e-07, $details['impact_risk']['probability']);
        self::assertSame('2056-2113', $details['impact_risk']['range']);
        self::assertSame(4, $details['impact_risk']['n_impacts']);
    }

    public function testUnknownObjectIsNull(): void
    {
        $result = $this->client([
            'sbdb|2099 ZZ99' => ['sbdb_not_found.json', 200],
            'ssocard|2099_ZZ99' => ['ssocard_not_found.json', 404],
        ])->getDetails(['2099 ZZ99']);

        self::assertSame(['2099 ZZ99' => null], $result);
    }

    public function testBothCataloguesDownIsATransportError(): void
    {
        $client = $this->client([
            'sbdb|2026 NT2' => ['oops', 503],
            'ssocard|2026_NT2' => ['oops', 502],
        ]);

        $this->expectException(TransportException::class);
        $client->getDetails(['2026 NT2']);
    }

    public function testTaxonomyComplex(): void
    {
        foreach (['Sq' => 'S', 'Q' => 'S', 'Ch' => 'C', 'B' => 'C', 'Xe' => 'X', 'M' => 'X', 'V' => 'V', 'D' => 'D'] as $class => $complex) {
            self::assertSame($complex, SmallBodyDetailsClient::taxonomyComplex($class), $class);
        }
    }
}
