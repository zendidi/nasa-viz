<?php

namespace App\Tests\Service;

use App\Service\EsaNeoccClient;
use App\Service\SmallBodyDetailsClient;
use PHPUnit\Framework\TestCase;
use Symfony\Component\HttpClient\Exception\TransportException;
use Symfony\Component\HttpClient\MockHttpClient;
use Symfony\Component\HttpClient\Response\MockResponse;

final class SmallBodyDetailsClientTest extends TestCase
{
    private const FIXTURES = __DIR__.'/../Fixtures/';

    /**
     * @param array<string, array{string, int}> $routes "service|query" => [fixture file or raw body, HTTP code];
     *                                                   code 0 means a transport failure instead of an HTTP response — $body is then the error message
     *
     * A designation with no "esa|…" route gets the same default body as any
     * other unmapped route: valid JSON, but no "END_OF_HEADER" line, so
     * EsaNeoccClient::parseOrbit() reads it as "not an OEF2.0 file" and
     * returns null regardless — no special-casing needed to make ESA default
     * to "not_found" in a test that isn't about ESA.
     */
    private function client(array $routes): SmallBodyDetailsClient
    {
        $http = new MockHttpClient(function (string $method, string $url) use ($routes) {
            parse_str((string) parse_url($url, PHP_URL_QUERY), $query);
            $service = match (true) {
                str_contains($url, 'sbdb.api') => 'sbdb|'.$query['sstr'],
                str_contains($url, 'ssocard.php') => 'ssocard|'.$query['q'],
                str_contains($url, 'sentry.api') => 'sentry|'.$query['des'],
                str_contains($url, '/download') => 'esa|'.$query['file'],
                default => throw new \LogicException("La doublure HTTP ne connait pas cette URL : $url"),
            };
            [$body, $code] = $routes[$service] ?? ['{"error":"specified object not found"}', 200];
            if ($code === 0) {
                return new MockResponse('', ['error' => $body]);
            }
            $content = is_file(self::FIXTURES.$body) ? file_get_contents(self::FIXTURES.$body) : $body;

            return new MockResponse($content, ['http_code' => $code]);
        });

        return new SmallBodyDetailsClient($http, 'https://jpl.test', 'https://imcce.test', new EsaNeoccClient($http, 'https://esa.test'));
    }

    public function testFullSheetPrefersSsocardPhysicsAndSbdbOrbit(): void
    {
        // Queried by number, not by "2004 MN4": ESA's own download only
        // resolves a NUMBERED object by its number (measured 2026-10-12 —
        // file=2004MN4.ke1/.ke0 are both empty, file=99942.ke1 is Apophis's
        // own elements at the common epoch), a trap beyond the two documented
        // on EsaNeoccClient::requestOrbit(). A caller wanting ESA's orbit for
        // a numbered object must pass its number, same as SBDB's own "sstr"
        // already accepts either — SmallBodyDetailsClient also retries with
        // SBDB's own number when the first attempt fails, see
        // testEsaRetriesWithSbdbsNumberWhenTheProvisionalDesignationFails().
        // array_values(), not a $result['99942'] offset: PHP itself casts an
        // all-digit array key to int, and PHPStan — reasoning from
        // getDetails()'s declared `array<string, …>` — calls that exact
        // offset unfound, which is true of the type declaration and not of
        // what actually happens at runtime. One object requested, one in the
        // result, so the first (only) element is unambiguous either way.
        $result = $this->client([
            'sbdb|99942' => ['sbdb_apophis.json', 200],
            'ssocard|99942' => ['ssocard_apophis.json', 200],
            'sentry|99942' => ['sentry_removed.json', 200],
            'esa|99942.ke1' => ['esa_orbit_apophis.ke1', 200],
        ])->getDetails(['99942']);
        self::assertCount(1, $result);
        $details = array_values($result)[0];

        self::assertSame('99942 Apophis (2004 MN4)', $details['fullname']);
        self::assertSame(['code' => 'ATE', 'name' => 'Aten'], $details['orbit_class']);
        self::assertTrue($details['is_pha']);
        self::assertSame(['class' => 'S', 'complex' => 'S', 'source' => 'ssocard'], $details['taxonomy']);
        self::assertSame(['value' => 0.34, 'source' => 'ssocard'], $details['diameter_km']);
        self::assertSame(0.000107917, $details['moid_earth_au']);
        self::assertSame(0.9223592206975018, $details['orbit']['a_au']);
        self::assertSame(2461200.5, $details['orbit']['epoch_jd']);
        self::assertSame(323.5553366891694, $details['orbit']['period_days']);
        self::assertNull($details['impact_risk']);
        self::assertSame(['sbdb' => 'ok', 'ssocard' => 'ok', 'sentry' => 'not_found', 'esa' => 'ok'], $details['sources']);
        self::assertSame('https://ssp.imcce.fr/forms/ssocard/Apophis', $details['links']['ssocard']);

        // The fixture's own ESA elements, downloaded directly from
        // https://neo.ssa.esa.int 2026-10-12, sit beside SBDB's in 'orbits'.
        // 'solution' is 'ke1': this is the file propagated to MJD 61200 (JD
        // 2461200.5) — the SAME epoch SBDB and ssoCard already sit at below.
        self::assertSame('ke1', $details['orbits']['esa']['solution']);
        self::assertSame(0.9223592223762012, $details['orbits']['esa']['a_au']);
        self::assertSame(2461200.5, $details['orbits']['esa']['epoch_jd']);
        self::assertSame('Aten', $details['orbits']['esa']['orbit_type']);
        self::assertTrue($details['orbits']['esa']['is_pha']);
        self::assertSame($details['orbit']['a_au'], $details['orbits']['sbdb']['a_au']);
        // This fixture's ssoCard *does* carry orbital elements (IMCCE's own
        // propagation of the same astrometry) — all three sources compare.
        self::assertNotNull($details['orbits']['ssocard']);

        // Three real, independently-fitted solutions, all at the SAME epoch
        // this time: the actual measure of disagreement between SBDB, ESA
        // and ssoCard is on the order of 1e-7 to 1e-9 relative — two to four
        // orders below what the OLD `.ke0` fixture showed for the exact same
        // object (2e-4 on a_au, 0.16 % on e) purely because that file sits 8
        // years away from SBDB's/ssoCard's epoch. same_epoch being true is
        // what makes this comparison mean anything, and the two numbers next
        // to each other — 1e-7 here, 2e-4 there — are the proof, not just the
        // justification for the check (see compareOrbits()'s own docblock).
        self::assertSame(['sbdb', 'esa', 'ssocard'], $details['orbit_comparison']['compared']);
        self::assertTrue($details['orbit_comparison']['same_epoch']);
        self::assertEqualsWithDelta(2.376201124754118E-9, $details['orbit_comparison']['spread']['a_au'], 1e-15);
        self::assertEqualsWithDelta(5.530035235290498E-9, $details['orbit_comparison']['spread']['e'], 1e-15);
        self::assertEqualsWithDelta(1.249984450168995E-6, $details['orbit_comparison']['spread']['period_days'], 1e-12);
        // Now meaningful (same_epoch is true) and present, unlike at different epochs.
        self::assertEqualsWithDelta(2.265927389544231E-5, $details['orbit_comparison']['spread']['mean_anomaly_deg'], 1e-12);
        self::assertSame('peri_deg', $details['orbit_comparison']['worst']['field']);
        self::assertEqualsWithDelta(9.252893309823978E-8, $details['orbit_comparison']['worst']['relative'], 1e-15);
        self::assertSame('https://neo.ssa.esa.int/search-for-asteroids?sum=1&des=99942', $details['links']['esa']);
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
        self::assertSame(0.0291634, $details['moid_earth_au']);
        self::assertSame(['sbdb' => 'ok', 'ssocard' => 'not_found', 'sentry' => 'not_found', 'esa' => 'not_found'], $details['sources']);
        self::assertNull($details['links']['ssocard']);
        self::assertNull($details['links']['esa']);
        self::assertNull($details['orbits']['esa']);
        // A single source (SBDB) has elements — nothing to compare against.
        self::assertNull($details['orbit_comparison']);
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
        // 'orbit' fell back to ssoCard (SBDB didn't know this object); 'orbits.ssocard' is that same array.
        self::assertSame($details['orbit'], $details['orbits']['ssocard']);
    }

    public function testEsaUnavailableLeavesTheRestOfTheSheetIntact(): void
    {
        $details = $this->client([
            'sbdb|2004 MN4' => ['sbdb_apophis.json', 200],
            'ssocard|2004_MN4' => ['ssocard_apophis.json', 200],
            'sentry|2004 MN4' => ['sentry_removed.json', 200],
            // A genuine transport failure (DNS, connection refused…) — the
            // only way ESA becomes "unavailable" rather than "not_found": an
            // HTTP error response still has a body, which parseOrbit() just
            // reads as "not an OEF2.0 file" (see client()'s own default).
            'esa|2004MN4.ke0' => ['esa unreachable', 0],
        ])->getDetails(['2004 MN4'])['2004 MN4'];

        self::assertSame('unavailable', $details['sources']['esa']);
        self::assertNull($details['orbits']['esa']);
        self::assertNull($details['links']['esa']);
        // SBDB and ssoCard both have elements regardless of ESA — the
        // comparison just drops to those two instead of going null.
        self::assertSame(['sbdb', 'ssocard'], $details['orbit_comparison']['compared']);
        // Everything SBDB/ssoCard-derived is unaffected by ESA being down.
        self::assertSame('99942 Apophis (2004 MN4)', $details['fullname']);
        self::assertNotNull($details['orbit']);
    }

    public function testEsaRetriesWithSbdbsNumberWhenTheProvisionalDesignationFails(): void
    {
        // The designation actually asked for is "2004 MN4" — exactly what a
        // numbered object's own NeoWs name parses out between parentheses
        // (web's designationOf()) — so the FIRST esa attempt ("2004MN4.ke1",
        // then "2004MN4.ke0") finds nothing, same as the real service. SBDB's
        // "object.des" is "99942" (fixture-verified: sbdb_apophis.json, not
        // assumed), so SmallBodyDetailsClient retries once more with that
        // number — not in parallel with the other three requests, since the
        // number only exists once SBDB has already answered.
        $details = $this->client([
            'sbdb|2004 MN4' => ['sbdb_apophis.json', 200],
            'ssocard|2004_MN4' => ['ssocard_not_found.json', 404],
            'esa|99942.ke1' => ['esa_orbit_apophis.ke1', 200],
        ])->getDetails(['2004 MN4'])['2004 MN4'];

        self::assertSame('ok', $details['sources']['esa']);
        self::assertSame('ke1', $details['orbits']['esa']['solution']);
        self::assertSame(0.9223592223762012, $details['orbits']['esa']['a_au']);
        // The link is built from the designation actually asked for, same as
        // SBDB's own — the retry only widens what ESA itself was asked, not
        // what the rest of the sheet presents the object as.
        self::assertSame('https://neo.ssa.esa.int/search-for-asteroids?sum=1&des=2004%20MN4', $details['links']['esa']);
    }

    public function testEsaRetryIsSkippedWhenTheFirstAttemptAlreadyUsedTheNumber(): void
    {
        // Querying directly by number ("99942"): the first esa attempt
        // already succeeds, so there's nothing to retry — and nothing here
        // would even make a second attempt possible, since the mock has no
        // route for a second request.
        $details = $this->client([
            'sbdb|99942' => ['sbdb_apophis.json', 200],
            'ssocard|99942' => ['ssocard_not_found.json', 404],
            'esa|99942.ke1' => ['esa_orbit_apophis.ke1', 200],
        ])->getDetails(['99942']);
        $details = array_values($details)[0];

        self::assertSame('ok', $details['sources']['esa']);
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

    public function testOrbitComparisonWrapsAngularSpreadAcrossZero(): void
    {
        // 0.0005° and 359.9995° are 0.001° apart on the sky, not 359.999° —
        // a naive max-min on the raw degrees would get this one wrong. Same
        // epoch on both sources, so mean_anomaly_deg (itself an angle) also
        // compares — wrapped the same way, 0.0001° here, not 359.9999°.
        $base = ['epoch_jd' => 2461200.5, 'a_au' => 1.0, 'e' => 0.1, 'i_deg' => 5.0, 'peri_deg' => 10.0, 'period_days' => 100.0];
        $comparison = SmallBodyDetailsClient::compareOrbits([
            'sbdb' => $base + ['node_deg' => 0.0005, 'mean_anomaly_deg' => 0.00005],
            'esa' => $base + ['node_deg' => 359.9995, 'mean_anomaly_deg' => 359.99995],
            'ssocard' => null,
        ]);

        self::assertTrue($comparison['same_epoch']);
        self::assertEqualsWithDelta(0.001, $comparison['spread']['node_deg'], 1e-9);
        self::assertEqualsWithDelta(0.0001, $comparison['spread']['mean_anomaly_deg'], 1e-9);
        self::assertSame('node_deg', $comparison['worst']['field']); // the larger of the two differing angles
    }

    public function testOrbitComparisonForcesMeanAnomalyNullAtDifferentEpochs(): void
    {
        // Same two orbits as above, but 10 days apart — same_epoch is now
        // false, and mean_anomaly_deg goes null even though both sources
        // have it: a value here would look like a measurement of
        // disagreement and would actually just be the orbit having moved.
        $base = ['a_au' => 1.0, 'e' => 0.1, 'i_deg' => 5.0, 'node_deg' => 10.0, 'peri_deg' => 10.0, 'period_days' => 100.0, 'mean_anomaly_deg' => 0.0];
        $comparison = SmallBodyDetailsClient::compareOrbits([
            'sbdb' => $base + ['epoch_jd' => 2461200.5],
            'esa' => $base + ['epoch_jd' => 2461210.5],
            'ssocard' => null,
        ]);

        self::assertFalse($comparison['same_epoch']);
        self::assertNull($comparison['spread']['mean_anomaly_deg']);
    }

    public function testOrbitComparisonEpochToleranceIsEightySixSeconds(): void
    {
        $base = ['a_au' => 1.0, 'e' => 0.1, 'i_deg' => 5.0, 'node_deg' => 10.0, 'peri_deg' => 10.0, 'period_days' => 100.0, 'mean_anomaly_deg' => 0.0];

        // Clearly under 1e-3 day (86.4 s): still "the same epoch". (Not an
        // exact-boundary test: subtracting two ~2.46e6 magnitude floats
        // loses enough precision that testing right at 0.001 itself is
        // unreliable — the tolerance's existence matters here, not its last bit.)
        self::assertTrue(SmallBodyDetailsClient::compareOrbits([
            'sbdb' => $base + ['epoch_jd' => 2461200.5],
            'esa' => $base + ['epoch_jd' => 2461200.5 + 0.0005],
            'ssocard' => null,
        ])['same_epoch']);

        // Clearly over: no longer.
        self::assertFalse(SmallBodyDetailsClient::compareOrbits([
            'sbdb' => $base + ['epoch_jd' => 2461200.5],
            'esa' => $base + ['epoch_jd' => 2461200.5 + 0.01],
            'ssocard' => null,
        ])['same_epoch']);
    }

    public function testOrbitComparisonNullBelowTwoSources(): void
    {
        $orbit = ['epoch_jd' => 2461200.5, 'a_au' => 1.0, 'e' => 0.1, 'i_deg' => 5.0, 'node_deg' => 10.0, 'peri_deg' => 10.0, 'mean_anomaly_deg' => 0.0, 'period_days' => 100.0];
        self::assertNull(SmallBodyDetailsClient::compareOrbits(['sbdb' => $orbit, 'esa' => null, 'ssocard' => null]));
        self::assertNull(SmallBodyDetailsClient::compareOrbits(['sbdb' => null, 'esa' => null, 'ssocard' => null]));
    }

    public function testTaxonomyComplex(): void
    {
        foreach (['Sq' => 'S', 'Q' => 'S', 'Ch' => 'C', 'B' => 'C', 'Xe' => 'X', 'M' => 'X', 'V' => 'V', 'D' => 'D'] as $class => $complex) {
            self::assertSame($complex, SmallBodyDetailsClient::taxonomyComplex($class), $class);
        }
    }
}
