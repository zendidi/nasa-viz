<?php

namespace App\Tests\Service;

use App\Service\HorizonsClient;
use App\Service\JplCadClient;
use App\Service\SmallBodyPositionsClient;
use PHPUnit\Framework\TestCase;
use Symfony\Component\HttpClient\MockHttpClient;
use Symfony\Component\HttpClient\Response\MockResponse;

final class SmallBodyPositionsClientTest extends TestCase
{
    private const FIXTURES = __DIR__.'/../Fixtures/';
    private const VECTORS = <<<'TXT'
        $$SOE
        2461299.500000000, A.D. 2026-Sep-16 00:00:00.0000, -8.076181512262613E+06,  6.900159747660628E+07,  2.528791899701072E+07,
        2461299.541666667, A.D. 2026-Sep-16 01:00:00.0000, -8.136033312549472E+06,  6.899867511474995E+07,  2.529008354433306E+07,
        $$EOE
        TXT;
    private const CAD_FIELDS = ['des', 'orbit_id', 'jd', 'cd', 'dist', 'dist_min', 'dist_max', 'v_rel', 'v_inf', 't_sigma_f', 'h'];

    /** @var list<array<string, string>> every Horizons query sent, decoded */
    private array $horizons = [];
    /** @var list<string> */
    private array $cadSpk = [];

    /**
     * @param array<int|string, string> $cadBodyBySpk SPK-ID => CAD answer body (default: the fixture); 'FAIL' = HTTP 500
     * @param list<string> $noTable SPK-IDs Horizons does not resolve
     */
    private function client(array $cadBodyBySpk = [], array $noTable = []): SmallBodyPositionsClient
    {
        $this->horizons = [];
        $this->cadSpk = [];
        $http = new MockHttpClient(function (string $method, string $url) use ($cadBodyBySpk, $noTable) {
            parse_str((string) parse_url($url, PHP_URL_QUERY), $q);
            if (str_starts_with($url, 'https://horizons.test')) {
                $this->horizons[] = $q;
                $unresolved = array_filter($noTable, static fn (string $id) => str_contains($q['COMMAND'], $id));

                return new MockResponse(json_encode(['result' => $unresolved ? 'No matches found.' : self::VECTORS]));
            }
            $this->cadSpk[] = $q['spk'];
            $body = $cadBodyBySpk[$q['spk']] ?? file_get_contents(self::FIXTURES.'cad_object_two_close.json');

            return 'FAIL' === $body ? new MockResponse('boom', ['http_code' => 500]) : new MockResponse($body);
        });

        return new SmallBodyPositionsClient(
            new HorizonsClient($http, 'https://horizons.test'),
            new JplCadClient($http, 'https://cad.test'),
        );
    }

    /** @return array{spkid: string, des: string, fullname: string, neo: bool} */
    private static function body(string $spkid, bool $neo): array
    {
        return ['spkid' => $spkid, 'des' => 'D'.$spkid, 'fullname' => 'N '.$spkid, 'neo' => $neo];
    }

    private static function start(): \DateTimeImmutable
    {
        return new \DateTimeImmutable('2026-07-01', new \DateTimeZone('UTC'));
    }

    private static function end(): \DateTimeImmutable
    {
        return new \DateTimeImmutable('2027-07-01', new \DateTimeZone('UTC'));
    }

    public function testNeoIsHourlyAndNonNeoDailyWithDesCommand(): void
    {
        $client = $this->client();

        $objects = $client->getPositions([self::body('20000001', false), self::body('20099942', true)], self::start(), self::end());

        $steps = [];
        foreach (array_slice($this->horizons, 0, 2) as $q) {
            $steps[$q['COMMAND']] = $q['STEP_SIZE'];
        }
        self::assertSame(["'DES=20000001;'" => "'1d'", "'DES=20099942;'" => "'1h'"], $steps);
        self::assertSame(86400, $objects['20000001']['table']['step_seconds']);
        self::assertSame(3600, $objects['20099942']['table']['step_seconds']);
        self::assertSame(self::start()->getTimestamp(), $objects['20099942']['table']['start']);
        self::assertSame([-8076182, 69001597, 25287919], $objects['20099942']['table']['positions'][0]);
        self::assertSame("'2026-07-01 00:00:00'", $this->horizons[0]['START_TIME']);
        self::assertSame("'2027-07-01 00:00:00'", $this->horizons[0]['STOP_TIME']);
    }

    public function testNonNeoGetsNoCadCallNoSegmentsNoApproaches(): void
    {
        $objects = $this->client()->getPositions([self::body('20000001', false)], self::start(), self::end());

        self::assertSame([], $this->cadSpk);
        self::assertSame([], $objects['20000001']['segments']);
        self::assertSame([], $objects['20000001']['close_approaches']);
        self::assertNull($objects['20000001']['next_close_approach_after_window']);
        self::assertCount(1, $this->horizons);
    }

    public function testApproachesAreSplitAtTheWindowEndAndTimesAreUtc(): void
    {
        $object = $this->client()->getPositions([self::body('20099942', true)], self::start(), self::end())['20099942'];

        self::assertSame(['20099942'], $this->cadSpk);
        self::assertCount(2, $object['close_approaches']);
        // jd 2461350.0 on the TDB scale is Unix 1793880000 read naively; UTC is 69.184 s earlier.
        self::assertSame(1793879931, $object['close_approaches'][0]['time']);
        self::assertEqualsWithDelta(0.00049 * 149597870.7, $object['close_approaches'][0]['dist_km'], 1e-6);
        self::assertSame(11.5, $object['close_approaches'][0]['v_rel_km_s']);
        self::assertSame('< 00:01', $object['close_approaches'][0]['t_sigma']);
        // First approach at or after the window end (2027-07-01): the 0.0002 au one, not the 2028 one.
        self::assertEqualsWithDelta(0.0002 * 149597870.7, $object['next_close_approach_after_window']['dist_km'], 1e-6);
    }

    public function testFineSegmentOnlyBelowThreshold(): void
    {
        $object = $this->client()->getPositions([self::body('20099942', true)], self::start(), self::end())['20099942'];

        // 0.00049 au gets one, 0.00051 au does not.
        self::assertCount(1, $object['segments']);
        $segment = $object['segments'][0];
        self::assertSame(300, $segment['step_seconds']);
        // approach 1793879931 - 12 h = 1793836731, floored to 5 min.
        self::assertSame(1793836500, $segment['start']);

        $fine = array_values(array_filter($this->horizons, static fn (array $q) => "'5m'" === $q['STEP_SIZE']));
        self::assertCount(1, $fine);
        self::assertSame("'DES=20099942;'", $fine[0]['COMMAND']);
        self::assertSame("'".gmdate('Y-m-d H:i:s', 1793836500)."'", $fine[0]['START_TIME']);
        // approach + 12 h = 1793923131, rounded up to 5 min, so the whole +-12 h is covered.
        self::assertSame("'".gmdate('Y-m-d H:i:s', 1793923200)."'", $fine[0]['STOP_TIME']);
    }

    public function testSegmentsAreCappedAtTenKeepingTheClosest(): void
    {
        $rows = [];
        for ($i = 0; $i < 12; ++$i) {
            // Every 2 days; the two last are the closest of all.
            $rows[] = ['X', '1', sprintf('%.1f', 2461300.0 + 2 * $i), 'x', $i >= 10 ? '0.0001' : '0.0004', '0', '0', '5', '5', '< 00:01', '20'];
        }
        $cad = (string) json_encode(['count' => 12, 'fields' => self::CAD_FIELDS, 'data' => $rows]);
        $object = $this->client(['20099942' => $cad])->getPositions([self::body('20099942', true)], self::start(), self::end())['20099942'];

        self::assertCount(12, $object['close_approaches']);
        self::assertCount(SmallBodyPositionsClient::MAX_FINE_SEGMENTS, $object['segments']);
        $starts = array_column($object['segments'], 'start');
        $sorted = $starts;
        sort($sorted);
        self::assertSame($sorted, $starts, 'segments in time order');
        // The closest (the last two approaches) are kept.
        self::assertGreaterThan(JplCadClient::tdbJulianDateToUnixUtc(2461300.0 + 2 * 11) - 86400, max($starts));
        self::assertCount(10, array_filter($this->horizons, static fn (array $q) => "'5m'" === $q['STEP_SIZE']));
    }

    public function testCadFailureGivesNullApproachesButStillServesTheTable(): void
    {
        $object = $this->client(['20099942' => 'FAIL'])->getPositions([self::body('20099942', true)], self::start(), self::end())['20099942'];

        self::assertNull($object['close_approaches']);
        self::assertNotEmpty($object['table']['positions']);
        self::assertSame([], $object['segments']);
    }

    public function testCadWithNoApproachAtAll(): void
    {
        $empty = (string) json_encode(['signature' => ['version' => '1.5'], 'count' => 0]);
        $object = $this->client(['20000243' => $empty])->getPositions([self::body('20000243', true)], self::start(), self::end())['20000243'];

        self::assertSame([], $object['close_approaches']);
        self::assertNull($object['next_close_approach_after_window']);
    }

    public function testObjectHorizonsCannotResolveIsNull(): void
    {
        $objects = $this->client([], ['20000001'])->getPositions([self::body('20000001', false), self::body('20000002', false)], self::start(), self::end());

        self::assertNull($objects['20000001']);
        self::assertNotNull($objects['20000002']);
    }

    public function testTdbJulianDateToUtcSubtractsTtMinusUtc(): void
    {
        // UTC = TDB - 69.184 s: the instant a CAD jd names is that much earlier on the UTC clock.
        self::assertSame(-69, JplCadClient::tdbJulianDateToUnixUtc(2440587.5));
        self::assertSame(1793879931, JplCadClient::tdbJulianDateToUnixUtc(2461350.0));
        self::assertSame(1870000000 - 69, JplCadClient::tdbJulianDateToUnixUtc(2440587.5 + 1870000000 / 86400));
    }
}
