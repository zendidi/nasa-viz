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
}
