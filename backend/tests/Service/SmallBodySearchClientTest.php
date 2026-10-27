<?php

namespace App\Tests\Service;

use App\Service\SmallBodySearchClient;
use PHPUnit\Framework\TestCase;
use Symfony\Component\HttpClient\Exception\TransportException;
use Symfony\Component\HttpClient\MockHttpClient;
use Symfony\Component\HttpClient\Response\MockResponse;

final class SmallBodySearchClientTest extends TestCase
{
    private const FIXTURES = __DIR__.'/../Fixtures/';

    /** @var list<string> every `sstr` sent, in order */
    private array $asked = [];

    /**
     * @param array<string, array{string, int}> $routes sstr => [fixture file or raw body, HTTP code];
     *                                                   code 0 means a transport failure
     */
    private function client(array $routes): SmallBodySearchClient
    {
        $this->asked = [];
        $http = new MockHttpClient(function (string $method, string $url) use ($routes) {
            parse_str((string) parse_url($url, PHP_URL_QUERY), $query);
            $this->asked[] = $query['sstr'];
            [$body, $code] = $routes[$query['sstr']] ?? throw new \LogicException('unexpected sstr '.$query['sstr']);
            if ($code === 0) {
                return new MockResponse('', ['error' => $body]);
            }

            return new MockResponse(is_file(self::FIXTURES.$body) ? (string) file_get_contents(self::FIXTURES.$body) : $body, ['http_code' => $code]);
        });

        return new SmallBodySearchClient($http, 'https://jpl.test');
    }

    public function testDirectMatchIsNormalisedAndFlagsComeFromSbdb(): void
    {
        $result = $this->client(['Apophis' => ['sbdb_search_apophis.json', 200]])->search('Apophis');

        self::assertSame(['Apophis'], $this->asked, 'a direct hit must not spend a second request');
        self::assertSame([
            'spkid' => '20099942',
            'des' => '99942',
            'fullname' => '99942 Apophis (2004 MN4)',
            'shortname' => '99942 Apophis',
            'kind' => 'an',
            'neo' => true,
            'pha' => true,
            'orbit_class' => ['code' => 'ATE', 'name' => 'Aten'],
        ], $result['match']);
    }

    public function testAmbiguousQueryAnsweredHttp300GivesCandidates(): void
    {
        // SBDB's status mirrors the body code: 300, not 200, and it must not be an error.
        $result = $this->client(['Apo*' => ['sbdb_search_apo_list.json', 300]])->search('Apo*');

        self::assertNull($result['match']);
        self::assertSame('1862', $result['candidates'][0]['pdes']);
    }

    public function testNotFoundIsRetriedOnceWithAWildcard(): void
    {
        $result = $this->client([
            'Apo' => ['sbdb_search_notfound.json', 200],
            'Apo*' => ['sbdb_search_apo_list.json', 300],
        ])->search('Apo');

        self::assertSame(['Apo', 'Apo*'], $this->asked);
        self::assertNull($result['match']);
        self::assertArrayHasKey('candidates', $result);
    }

    public function testNotFoundTwiceIsAnEmptyMatchNotAnError(): void
    {
        $result = $this->client([
            'Zzzzqq' => ['sbdb_search_notfound.json', 200],
            'Zzzzqq*' => ['sbdb_search_notfound.json', 200],
        ])->search('Zzzzqq');

        self::assertSame(['match' => null], $result);
        self::assertCount(2, $this->asked, 'one retry, never more');
    }

    public function testCometMatchIsRejectedNotReturned(): void
    {
        $result = $this->client(['1P' => ['sbdb_search_comet.json', 200]])->search('1P');

        self::assertSame(['match' => null, 'rejected' => ['reason' => 'comet', 'fullname' => '1P/Halley']], $result);
    }

    public function testCometsAreFilteredFromCandidatesAndCountFollows(): void
    {
        $result = $this->client(['Halley' => ['sbdb_search_halley_ambiguous.json', 300]])->search('Halley');

        self::assertSame([['pdes' => '2688', 'name' => '2688 Halley (1982 HG1)']], $result['candidates']);
        self::assertSame(1, $result['count']);
    }

    public function testListOfOnlyCometsIsNothing(): void
    {
        $body = '{"code":"300","list":[{"pdes":"C/2020 F3","name":"C/2020 F3 (NEOWISE)"},{"pdes":"73P-B","name":"73P-B/S-W 3"}],"count":2}';

        self::assertSame(['match' => null], $this->client(['neowise' => [$body, 300]])->search('neowise'));
    }

    public function testInterstellarAsteroidDesignationIsNotTakenForAComet(): void
    {
        $body = '{"code":"300","list":[{"pdes":"A/2017 U1","name":"A/2017 U1"},{"pdes":"I/2017 U1","name":"I/2017 U1"},{"pdes":"D/1993 F2","name":"x"}],"count":3}';

        $result = $this->client(['x' => [$body, 300]])->search('x');

        self::assertSame(['A/2017 U1'], array_column($result['candidates'], 'pdes'));
    }

    public function testCandidatesAreTruncatedButCountKeepsTheTotal(): void
    {
        $list = array_map(static fn (int $n) => ['pdes' => (string) (1000 + $n), 'name' => 'n'.$n], range(1, 35));
        $body = json_encode(['code' => '300', 'list' => $list, 'count' => 35]);

        $result = $this->client(['a*' => [(string) $body, 300]])->search('a*');

        self::assertCount(20, $result['candidates']);
        self::assertSame(35, $result['count']);
    }

    public function testServerErrorAndTransportFailureThrow(): void
    {
        foreach ([['', 503], ['not json', 200], ['boom', 0]] as $i => [$body, $code]) {
            try {
                $this->client(['Eros' => [$body, $code]])->search('Eros');
                self::fail("case $i should have thrown");
            } catch (TransportException) {
                self::addToAssertionCount(1);
            }
        }
    }

    public function testQueryValidation(): void
    {
        self::assertSame('2004 MN4', SmallBodySearchClient::normalizeQuery("  2004   MN4 \n"));
        self::assertSame("D'Arrest (x)-1.5/2", SmallBodySearchClient::normalizeQuery("D'Arrest (x)-1.5/2"));
        self::assertSame('Ångström', SmallBodySearchClient::normalizeQuery('Ångström'));
        foreach (['', '   ', 'Apo*', str_repeat('a', 41), 'a;b', 'a&b=c', '<x>'] as $bad) {
            self::assertNull(SmallBodySearchClient::normalizeQuery($bad), $bad);
        }
        self::assertNotNull(SmallBodySearchClient::normalizeQuery(str_repeat('a', 40)));
    }

    public function testCacheKeyIgnoresCase(): void
    {
        self::assertSame(SmallBodySearchClient::cacheKey('Apophis'), SmallBodySearchClient::cacheKey('apophis'));
        self::assertNotSame(SmallBodySearchClient::cacheKey('Apophis'), SmallBodySearchClient::cacheKey('Apophi'));
    }
}
