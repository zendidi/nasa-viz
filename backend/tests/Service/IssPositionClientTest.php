<?php

namespace App\Tests\Service;

use App\Service\IssPositionClient;
use PHPUnit\Framework\TestCase;
use Symfony\Component\HttpClient\Exception\TransportException;
use Symfony\Component\HttpClient\MockHttpClient;
use Symfony\Component\HttpClient\Response\MockResponse;

final class IssPositionClientTest extends TestCase
{
    public function testAsksForATenMinuteTrackAndKeepsTheFlatReading(): void
    {
        // The single reading's timestamp used to be ignored, so the marker sat up
        // to ~460 km behind (audit 2026-10-21). The track is what lets the client
        // place the ISS at the real "now" — and the flat fields stay, so the
        // contract only gains one.
        $urls = [];
        $http = new MockHttpClient(function (string $method, string $url) use (&$urls) {
            $urls[] = $url;
            $body = array_map(static fn (int $i) => [
                'latitude' => 10.0 + $i, 'longitude' => 20.0 + $i, 'altitude' => 420.0, 'velocity' => 27600.0,
                'timestamp' => 1_800_000_000 + 60 * $i,
            ], range(0, IssPositionClient::TRACK_SAMPLES - 1));

            return new MockResponse(json_encode($body));
        });
        $client = new IssPositionClient($http, 'https://iss.test/v1');

        $position = $client->getPosition(1_800_000_000);

        self::assertStringContainsString('/satellites/25544/positions', $urls[0]);
        self::assertStringContainsString('timestamps=1800000000%2C1800000060', $urls[0]);
        self::assertSame(10.0, $position['latitude']);
        self::assertSame(1_800_000_000, $position['timestamp']);
        self::assertCount(IssPositionClient::TRACK_SAMPLES, $position['track']);
        self::assertSame([1_800_000_540, 19.0, 29.0, 420.0], $position['track'][9]);
    }

    public function testAnEmptyTrackIsAnUpstreamFailure(): void
    {
        $client = new IssPositionClient(new MockHttpClient(new MockResponse('[]')), 'https://iss.test/v1');

        $this->expectException(TransportException::class);
        $client->getPosition(1_800_000_000);
    }
}
