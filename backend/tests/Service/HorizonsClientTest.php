<?php

namespace App\Tests\Service;

use App\Service\HorizonsClient;
use PHPUnit\Framework\TestCase;
use Symfony\Component\HttpClient\Exception\TransportException;
use Symfony\Component\HttpClient\MockHttpClient;
use Symfony\Component\HttpClient\Response\MockResponse;

final class HorizonsClientTest extends TestCase
{
    private const VECTOR_RESULT = <<<'TXT'
        Target body name: (2014 SU1)
        $$SOE
        2461299.500000000, A.D. 2026-Sep-16 00:00:00.0000, -8.076181512262613E+06,  6.900159747660628E+07,  2.528791899701072E+07,
        2461299.541666667, A.D. 2026-Sep-16 01:00:00.0000, -8.136033312549472E+06,  6.899867511474995E+07,  2.529008354433306E+07,
        $$EOE
        TXT;

    public function testParsesVectorTableAndEncodesSemicolon(): void
    {
        $requestedUrls = [];
        $http = new MockHttpClient(function (string $method, string $url) use (&$requestedUrls) {
            $requestedUrls[] = $url;

            return str_contains($url, 'SU1')
                ? new MockResponse(json_encode(['result' => self::VECTOR_RESULT]))
                : new MockResponse(json_encode(['result' => 'No matches found.']));
        });
        $client = new HorizonsClient($http, 'https://horizons.test/api');
        $start = new \DateTimeImmutable('2026-09-16', new \DateTimeZone('UTC'));

        $result = $client->getVectors(['2014 SU1', '1999 XX999'], $start, $start->modify('+1 day'));

        self::assertSame([
            'start' => $start->getTimestamp(),
            'positions' => [[-8076182, 69001597, 25287919], [-8136033, 68998675, 25290084]],
        ], $result['2014 SU1']);
        self::assertNull($result['1999 XX999']);
        self::assertStringContainsString('COMMAND=%27DES%3D2014%20SU1%3B%27', $requestedUrls[0]);
    }

    public function testNon200IsATransportErrorNotANotFound(): void
    {
        $http = new MockHttpClient(new MockResponse('{"message":"bad"}', ['http_code' => 400]));
        $client = new HorizonsClient($http, 'https://horizons.test/api');
        $start = new \DateTimeImmutable('2026-09-16');

        $this->expectException(TransportException::class);
        $client->getVectors(['2014 SU1'], $start, $start->modify('+1 day'));
    }
}
