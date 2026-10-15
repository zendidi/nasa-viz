<?php

namespace App\Tests\Service;

use App\Service\EsaNeoccClient;
use PHPUnit\Framework\TestCase;
use Symfony\Component\HttpClient\MockHttpClient;
use Symfony\Component\HttpClient\Response\MockResponse;

final class EsaNeoccClientTest extends TestCase
{
    private const FIXTURES = __DIR__.'/../Fixtures/';

    private function client(): EsaNeoccClient
    {
        return new EsaNeoccClient(new MockHttpClient(function (string $method, string $url) {
            parse_str((string) parse_url($url, PHP_URL_QUERY), $query);

            return new MockResponse(file_get_contents(self::FIXTURES.$query['file'].'.txt'));
        }), 'https://esa.test');
    }

    public function testCloseApproachesMergeRecentAndUpcoming(): void
    {
        $result = ($this->client()->requestCloseApproaches())();

        self::assertSame('2026-09-17T14:17Z', $result['last_update']);
        self::assertSame('2026-09-16', $result['from']);
        self::assertSame('2026-11-02', $result['to']);
        self::assertCount(9, $result['approaches']);

        $byName = array_column($result['approaches'], null, 'name');
        $rn4 = $byName['(2026 RN4)'];
        self::assertSame('2026 RN4', $rn4['designation']);
        self::assertNull($rn4['number']);
        self::assertSame('2026-09-17', $rn4['date']);
        self::assertSame(6200297.0, $rn4['dist_km']);
        self::assertSame(0.041446, $rn4['dist_au']);
        self::assertSame(19.0, $rn4['diameter_m']);
        self::assertTrue($rn4['diameter_estimated']);
        self::assertSame(26.4, $rn4['h']);
        self::assertSame(8.9, $rn4['v_rel_kms']);

        $zoozve = $byName['524522 Zoozve'];
        self::assertSame('524522', $zoozve['number']);
        self::assertNull($zoozve['designation']);
    }

    public function testRiskList(): void
    {
        $result = ($this->client()->requestRiskList())();

        self::assertSame('2026-09-17T14:00Z', $result['last_update']);
        $byDesignation = array_column($result['objects'], null, 'designation');
        self::assertSame(2.35E-3, $byDesignation['2023 VD3']['impact_probability']);
        self::assertSame(-2.70, $byDesignation['1979 XB']['palermo_cum']);
        self::assertSame('2056-2113', $byDesignation['1979 XB']['range']);
    }

    public function testUnexpectedFormatIsRejected(): void
    {
        $this->expectException(\UnexpectedValueException::class);
        EsaNeoccClient::parseTable('<html>maintenance</html>');
    }

    public function testRequestOrbitPrefersKe1AtTheCommonEpoch(): void
    {
        // .ke1 is MJD 61200.0 = JD 2461200.5 — the exact epoch SBDB and
        // ssoCard already sit at for Apophis (measured 2026-10-12). Preferred
        // over .ke0 for exactly that reason: see requestOrbit()'s docblock.
        $client = new EsaNeoccClient(new MockHttpClient(fn () => new MockResponse(file_get_contents(self::FIXTURES.'esa_orbit_apophis.ke1'))), 'https://esa.test');
        $orbit = ($client->requestOrbit('99942'))();

        self::assertNotNull($orbit);
        self::assertSame('ke1', $orbit['solution']);
        self::assertSame(2461200.5, $orbit['epoch_jd']); // MJD 61200.000000000 + 2400000.5
        self::assertSame(0.9223592223762012, $orbit['a_au']);
        self::assertSame(0.19114922446996477, $orbit['e']);
        self::assertSame(3.3409970023876, $orbit['i_deg']);
        self::assertSame(203.8936387948748, $orbit['node_deg']);
        self::assertSame(126.67958271092, $orbit['peri_deg']);
        self::assertSame(175.33040226699205, $orbit['mean_anomaly_deg']);
        self::assertSame(323.55533757247844, $orbit['period_days']);
        self::assertEqualsWithDelta(0.7460509723362706, $orbit['q_au'], 1e-12);
        self::assertEqualsWithDelta(1.0986674724161318, $orbit['ad_au'], 1e-12);
        self::assertEqualsWithDelta(0.00010792914778217588, $orbit['moid_earth_au'], 1e-15);
        self::assertSame('Aten', $orbit['orbit_type']);
        self::assertTrue($orbit['is_pha']);
    }

    public function testRequestOrbitFallsBackToKe0WhenKe1IsEmpty(): void
    {
        $client = new EsaNeoccClient(new MockHttpClient(function (string $method, string $url) {
            parse_str((string) parse_url($url, PHP_URL_QUERY), $query);

            // Only the .ke1 attempt comes back empty — the fallback .ke0 then
            // answers with Apophis's OWN (8-years-old) fit epoch.
            return str_ends_with($query['file'], '.ke1')
                ? new MockResponse('')
                : new MockResponse(file_get_contents(self::FIXTURES.'esa_orbit_apophis.ke0'));
        }), 'https://esa.test');
        $orbit = ($client->requestOrbit('99942'))();

        self::assertNotNull($orbit);
        self::assertSame('ke0', $orbit['solution']);
        self::assertSame(2458368.425507462, $orbit['epoch_jd']); // MJD 58367.925507462 + 2400000.5, NOT 2461200.5
    }

    public function testRequestOrbitStripsSpacesBeforeAsking(): void
    {
        // The real file's own name line is "99942" with no "des=" echo of what
        // was asked — a space in the query is this method's job to strip
        // before the request even goes out (see requestOrbit()'s docblock).
        $client = new EsaNeoccClient(new MockHttpClient(function (string $method, string $url) {
            parse_str((string) parse_url($url, PHP_URL_QUERY), $query);
            self::assertSame('99942.ke1', $query['file'], 'the space in "99942" (there is none) or a designation must be stripped');

            return new MockResponse(file_get_contents(self::FIXTURES.'esa_orbit_apophis.ke1'));
        }), 'https://esa.test');

        self::assertNotNull(($client->requestOrbit('99942'))());
    }

    public function testRequestOrbitRejectsAnEmptyBody(): void
    {
        // Both .ke1 and .ke0 are empty for an unknown object — not just the first.
        $client = new EsaNeoccClient(new MockHttpClient(fn () => new MockResponse('')), 'https://esa.test');

        self::assertNull(($client->requestOrbit('2018 PL23'))());
    }

    public function testParseOrbitRejectsAnEmptyBody(): void
    {
        self::assertNull(EsaNeoccClient::parseOrbit('', '2018 PL23'));
    }

    public function testParseOrbitRejectsAWrongReferenceFrame(): void
    {
        // Trusting the client's own idea of the frame — rather than the
        // file's own "refsys" line — produced rosette orbits for forty days
        // once (web/src/scene/planets.js, ORBIT_FRAME); refusing anything but
        // the exact header values is that lesson applied to this parser too.
        $wrongFrame = str_replace('ECLM J2000', 'EQUM J2000', file_get_contents(self::FIXTURES.'esa_orbit_apophis.ke0'));

        self::assertNull(EsaNeoccClient::parseOrbit($wrongFrame, '99942'));
    }

    public function testParseOrbitRejectsAMismatchedDesignation(): void
    {
        // Measured 2026-10-12: file=2024%20YR4.ke0 — a space in the query —
        // answers HTTP 200 with a DIFFERENT object's elements (a=2.325 au,
        // not 2024 YR4's own a=2.516 au), under a name line that reads "2024"
        // instead of "2024YR4". The only way to catch this is to check the
        // name line against what was actually asked.
        $mismatched = file_get_contents(self::FIXTURES.'esa_orbit_name_mismatch.ke0');

        self::assertSame('2024', trim(explode("\n", trim($mismatched))[4]), 'fixture sanity check: this really is the wrong object');
        self::assertNull(EsaNeoccClient::parseOrbit($mismatched, '2024 YR4'));
        // The SAME file content, asked for under the name it actually carries,
        // parses fine — this isn't a reason to reject the format outright.
        self::assertNotNull(EsaNeoccClient::parseOrbit($mismatched, '2024'));
    }
}
