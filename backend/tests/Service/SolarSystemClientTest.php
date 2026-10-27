<?php

namespace App\Tests\Service;

use App\Service\HorizonsClient;
use App\Service\SolarSystemClient;
use PHPUnit\Framework\TestCase;
use Symfony\Component\HttpClient\MockHttpClient;
use Symfony\Component\HttpClient\Response\MockResponse;

final class SolarSystemClientTest extends TestCase
{
    private const MARS_RESULT = <<<'TXT'
        Target body name: Mars (499)                    {source: mar097}
        Center body name: Earth (399)                   {source: DE441}
        $$SOE
        2461305.500000000, A.D. 2026-Sep-22 00:00:00.0000, -1.110860301234567E+08,  2.131723371234567E+08,  9.658468212345678E+07,
        2461306.500000000, A.D. 2026-Sep-23 00:00:00.0000, -1.113000001234567E+08,  2.132000001234567E+08,  9.659000001234567E+07,
        $$EOE
        TXT;

    /**
     * The recorder is an ArrayObject rather than a plain array: it keeps
     * filling after this method returns, and a PHP array would be copied out.
     *
     * @return array{SolarSystemClient, \ArrayObject<int, string>}
     */
    private function clientRecording(callable $body): array
    {
        /** @var \ArrayObject<int, string> $urls */
        $urls = new \ArrayObject();
        $http = new MockHttpClient(function (string $method, string $url) use ($urls, $body) {
            $urls[] = $url;

            return $body($url);
        });

        return [new SolarSystemClient(new HorizonsClient($http, 'https://horizons.test/api')), $urls];
    }

    public function testAsksHorizonsByBodyIdAtADailyStep(): void
    {
        [$client, $urls] = $this->clientRecording(
            static fn (string $url) => new MockResponse(json_encode(['result' => self::MARS_RESULT])),
        );
        $start = new \DateTimeImmutable('2026-09-01', new \DateTimeZone('UTC'));

        $tables = $client->getPositions(['mars', 'venus'], $start);

        // A major body is addressed by its Horizons id, NOT wrapped in DES=…;
        // — that form is for small bodies, and Horizons wouldn't resolve it.
        self::assertStringContainsString('COMMAND=%27499%27', $urls[0]);
        self::assertStringNotContainsString('DES', $urls[0]);
        self::assertStringContainsString('STEP_SIZE=%271d%27', $urls[0]);
        self::assertStringContainsString('CENTER=%27500%40399%27', $urls[0]);
        // The window is a year from the given start, not a few days.
        self::assertStringContainsString('STOP_TIME=%272027-09-01', $urls[0]);
        self::assertCount(2, $urls);

        self::assertSame(
            [[-111086030, 213172337, 96584682], [-111300000, 213200000, 96590000]],
            $tables['mars'],
        );
    }

    public function testABodyHorizonsDoesNotAnswerForIsNullRatherThanFailingTheBatch(): void
    {
        [$client] = $this->clientRecording(static fn (string $url) => str_contains($url, '%27499%27')
            ? new MockResponse(json_encode(['result' => 'No ephemeris for target "Mars" after A.D. …']))
            : new MockResponse(json_encode(['result' => self::MARS_RESULT])));

        $tables = $client->getPositions(['mars', 'venus'], new \DateTimeImmutable('2026-09-01', new \DateTimeZone('UTC')));

        self::assertNull($tables['mars']);
        self::assertNotNull($tables['venus']);
    }

    /**
     * Tables are cached one body at a time but read against a single clock, so
     * the window must not depend on the day a given body happened to be fetched.
     */
    public function testWindowStartsOnTheFirstOfTheMonthWhicheverDayItIsAskedOn(): void
    {
        $utc = new \DateTimeZone('UTC');
        $first = SolarSystemClient::windowStart(new \DateTimeImmutable('2026-09-01 00:05', $utc));
        $last = SolarSystemClient::windowStart(new \DateTimeImmutable('2026-09-30 23:55', $utc));

        self::assertSame('2026-09-01 00:00:00', $first->format('Y-m-d H:i:s'));
        self::assertEquals($first, $last);
        // The month is the UTC one, not the caller's: 1 September 01:00 in
        // Brussels is still 31 August in UTC, so it belongs to August's window.
        // Two clients in different time zones must land on the same samples.
        self::assertSame(
            '2026-08-01 00:00:00',
            SolarSystemClient::windowStart(new \DateTimeImmutable('2026-09-01 01:00', new \DateTimeZone('Europe/Brussels')))
                ->format('Y-m-d H:i:s'),
        );
    }

    /**
     * Two things this pins down. The unitless STEP_SIZE is a *number of
     * intervals*, which is what fits Neptune's 165 years in one request; and
     * the centre is the **Sun**, not the Earth.
     *
     * That centre changed on 2026-09-29 and the assertion below is the guard.
     * The curve used to be fetched geocentric so a client could subtract its own
     * low-precision Sun and have the line pass through its own planet by
     * cancellation. Now that the client places the Sun from DE441 too
     * (`?body=sun`), the subtraction is both pointless and impossible — these
     * samples span a whole sidereal period, 165 years for Neptune, where a Sun
     * table covers one. Reverting this centre without reverting the client would
     * put every planet 951 057 km off its own orbit.
     */
    public function testOrbitIsOnePeriodOfHeliocentricSamplesCutIntoIntervals(): void
    {
        [$client, $urls] = $this->clientRecording(
            static fn (string $url) => new MockResponse(json_encode(['result' => self::MARS_RESULT])),
        );
        $start = new \DateTimeImmutable('2026-09-01', new \DateTimeZone('UTC'));

        $orbit = $client->getOrbit('mars', $start);

        self::assertCount(1, $urls);
        self::assertStringContainsString('COMMAND=%27499%27', $urls[0]);
        self::assertStringContainsString('CENTER=%27500%4010%27', $urls[0]); // 500@10 = the Sun
        self::assertStringNotContainsString('CENTER=%27500%40399%27', $urls[0]);
        // Derived from the constant, not spelled out: what this pins down is that
        // the value goes out **unitless** (a number of intervals) and not as a
        // duration. Hard-coding 180 only made the test stale when it became 360.
        self::assertStringContainsString('STEP_SIZE=%27'.SolarSystemClient::ORBIT_INTERVALS.'%27', $urls[0]);
        self::assertStringNotContainsString('STEP_SIZE=%27'.SolarSystemClient::ORBIT_INTERVALS.'d%27', $urls[0]);

        // Mars' sidereal period is 686,980 d — the window is that long, so "now"
        // (at most 31 days past a monthly anchor) always falls inside it.
        self::assertSame($start->getTimestamp(), $orbit['start']);
        self::assertEqualsWithDelta(686.980 * 86400, $orbit['stop'] - $orbit['start'], 60.0);
        self::assertStringContainsString('STOP_TIME=%272028-07-18%2023%3A31%3A00%27', $urls[0]);

        // The `stop` reported is the one actually sent: Horizons reads minutes,
        // and the client dates each sample from this value to subtract the
        // matching Sun. A truncation on only one side would shift them all.
        self::assertSame(
            '2028-07-18 23:31:00',
            (new \DateTimeImmutable('@'.$orbit['stop']))->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s'),
        );
        self::assertSame([[-111086030, 213172337, 96584682], [-111300000, 213200000, 96590000]], $orbit['positions']);
    }

    public function testOrbitIsNullWhenHorizonsDoesNotAnswer(): void
    {
        [$client] = $this->clientRecording(
            static fn (string $url) => new MockResponse(json_encode(['result' => 'No matches found.'])),
        );

        self::assertNull($client->getOrbit('neptune', new \DateTimeImmutable('2026-09-01', new \DateTimeZone('UTC'))));
    }

    public function testTheMoonIsAskedAtASixHourStepAndTheRestStaysDaily(): void
    {
        // A daily Moon table cost 320 km at worst under Catmull-Rom (3′ seen from
        // the Earth, measured 2026-10-21); the Moon alone gets 6 h. Mixed in one
        // call, each body must still get its own step, in the caller's order.
        [$client, $urls] = $this->clientRecording(
            static fn (string $url) => new MockResponse(json_encode(['result' => self::MARS_RESULT])),
        );
        $start = new \DateTimeImmutable('2026-09-01', new \DateTimeZone('UTC'));

        $tables = $client->getPositions(['moon', 'mars'], $start);

        self::assertSame(['moon', 'mars'], array_keys($tables));
        self::assertSame(21600, SolarSystemClient::stepSeconds('moon'));
        self::assertSame(SolarSystemClient::STEP_SECONDS, SolarSystemClient::stepSeconds('mars'));
        self::assertSame(21600, SolarSystemClient::stepSeconds('mercury'));
        $moonUrl = array_values(array_filter($urls->getArrayCopy(), static fn (string $u) => str_contains($u, 'COMMAND=%27301%27')))[0];
        $marsUrl = array_values(array_filter($urls->getArrayCopy(), static fn (string $u) => str_contains($u, 'COMMAND=%27499%27')))[0];
        self::assertStringContainsString('STEP_SIZE=%27360m%27', $moonUrl);
        self::assertStringContainsString('STEP_SIZE=%271d%27', $marsUrl);
    }

    public function testEveryKnownIdDescribesItself(): void
    {
        // The Sun and the Moon ride along in BODIES because their tables have
        // exactly a planet's shape, but neither is a planet and `planetIds()` must
        // keep them out — no moons and no orbit route.
        self::assertSame(
            ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto', 'sun', 'moon'],
            SolarSystemClient::ids(),
        );
        self::assertSame(
            ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'],
            SolarSystemClient::planetIds(),
        );
        self::assertSame(['id' => 'sun', 'name' => 'Sun', 'radius_km' => 695700.0, 'equatorial_radius_km' => 695700.0, 'polar_radius_km' => 695700.0], SolarSystemClient::describe('sun'));
        self::assertSame('301', SolarSystemClient::horizonsId('moon'));
        // The Earth is the frame's origin — a table of zeroes, deliberately absent.
        self::assertFalse(SolarSystemClient::isKnown('earth'));
        self::assertSame(['id' => 'jupiter', 'name' => 'Jupiter', 'radius_km' => 69911.0, 'equatorial_radius_km' => 71492.0, 'polar_radius_km' => 66854.0], SolarSystemClient::describe('jupiter'));
        // Every shape brackets its own mean radius: a polar radius above the
        // equatorial one, or a mean outside the pair, is a typo in the table.
        foreach (SolarSystemClient::ids() as $id) {
            $d = SolarSystemClient::describe($id);
            self::assertGreaterThanOrEqual($d['polar_radius_km'], $d['equatorial_radius_km'], $id);
            self::assertGreaterThanOrEqual($d['polar_radius_km'], $d['radius_km'], $id);
            self::assertLessThanOrEqual($d['equatorial_radius_km'], $d['radius_km'], $id);
        }
    }

    /**
     * Pluto's body-centre ephemeris (plu060) stops on 2199-12-29 and its 248-year
     * period from 2026 ends in 2274, so Horizons answers "No ephemeris for target
     * Pluto after A.D. 2199" (measured 2026-10-16). Its orbit is therefore drawn
     * from the barycentre '9' (DE441, to 2650); its positions, a year long, stay
     * on '999'. Without this the orbit route returns nothing for Pluto.
     */
    public function testPlutosOrbitComesFromTheBarycentreButItsPositionsFromTheBody(): void
    {
        [$client, $urls] = $this->clientRecording(
            static fn (string $url) => new MockResponse(json_encode(['result' => self::MARS_RESULT])),
        );
        $start = new \DateTimeImmutable('2026-10-01', new \DateTimeZone('UTC'));

        $client->getPositions(['pluto'], $start);
        $orbit = $client->getOrbit('pluto', $start);

        self::assertStringContainsString('COMMAND=%27999%27', $urls[0]);
        self::assertStringContainsString('COMMAND=%279%27', $urls[1]);
        self::assertStringContainsString('STEP_SIZE=%27'.SolarSystemClient::ORBIT_INTERVALS.'%27', $urls[1]);
        // 90 560 d is 247,9 years, a window Horizons serves in one request.
        self::assertEqualsWithDelta(90560 * 86400, $orbit['stop'] - $orbit['start'], 60.0);
        self::assertSame(
            ['id' => 'pluto', 'name' => 'Pluto', 'radius_km' => 1188.3, 'equatorial_radius_km' => 1188.3, 'polar_radius_km' => 1188.3],
            SolarSystemClient::describe('pluto'),
        );
        self::assertSame('999', SolarSystemClient::horizonsId('pluto'));
    }
}
