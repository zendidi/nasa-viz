<?php

namespace App\Service;

use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpClient\Exception\TransportException;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;
use Symfony\Contracts\HttpClient\HttpClientInterface;
use Symfony\Contracts\HttpClient\ResponseInterface;

/**
 * Wraps JPL Horizons (ssd.jpl.nasa.gov — keyless, not part of the
 * api.nasa.gov quota, so not recorded by NasaUsageTracker) to get real
 * geocentric positions of small bodies as an hourly table of vectors.
 *
 * Output frame is ICRF, Earth-centred, km — the same equatorial frame the web
 * viewer's star sphere uses. Objects are addressed by designation
 * ("2014 SU1"), not by NeoWs id, which Horizons doesn't know. Times are
 * TDB (the API rejects TIME_TYPE) — ~69 s off UTC, negligible here.
 */
final class HorizonsClient
{
    public const STEP_SECONDS = 3600;

    public function __construct(
        private readonly HttpClientInterface $httpClient,
        #[Autowire(env: 'HORIZONS_BASE_URL')]
        private readonly string $baseUrl,
    ) {
    }

    /**
     * Fires one Horizons request per designation concurrently (callers keep
     * the batch small — JPL asks users not to hammer the service). A null
     * entry means Horizons couldn't resolve that designation.
     *
     * @param list<string> $designations
     *
     * @return array<string, array{start: int, positions: list<array{int, int, int}>}|null>
     *
     * @throws ExceptionInterface on transport failure (nothing is known about any object then)
     */
    public function getVectors(array $designations, \DateTimeImmutable $start, \DateTimeImmutable $stop): array
    {
        /** @var array<string, ResponseInterface> $responses */
        $responses = [];
        foreach ($designations as $designation) {
            // Query string built by hand: HttpClient's `query` option leaves ';'
            // raw, and Horizons then splits COMMAND='DES=…;' at it (HTTP 400).
            $query = http_build_query([
                'format' => 'json',
                'COMMAND' => sprintf("'DES=%s;'", $designation),
                'OBJ_DATA' => 'NO',
                'MAKE_EPHEM' => 'YES',
                'EPHEM_TYPE' => 'VECTORS',
                'CENTER' => "'500@399'",
                'START_TIME' => sprintf("'%s'", $start->format('Y-m-d H:i')),
                'STOP_TIME' => sprintf("'%s'", $stop->format('Y-m-d H:i')),
                'STEP_SIZE' => sprintf("'%dm'", self::STEP_SECONDS / 60),
                'VEC_TABLE' => '1',
                'REF_PLANE' => 'FRAME',
                'OUT_UNITS' => "'KM-S'",
                'CSV_FORMAT' => 'YES',
            ], '', '&', PHP_QUERY_RFC3986);
            $responses[$designation] = $this->httpClient->request('GET', $this->baseUrl.'/horizons.api?'.$query, ['timeout' => 30]);
        }

        $result = [];
        foreach ($responses as $designation => $response) {
            // Unknown objects still come back 200 (see parseVectorTable) — any
            // other status means the request itself is wrong or JPL is down, so
            // it must not be mistaken for (and cached as) "object not found".
            if (200 !== $response->getStatusCode()) {
                throw new TransportException(sprintf('Horizons answered HTTP %d: %s', $response->getStatusCode(), $response->getContent(false)));
            }
            $data = $response->toArray(false);
            $result[$designation] = $this->parseVectorTable($data['result'] ?? '', $start);
        }

        return $result;
    }

    /**
     * Horizons answers 200 with plain text inside "result" either way — a
     * vector table between $$SOE/$$EOE markers on success, or a free-form
     * message (no match, several matches…) otherwise.
     *
     * @return array{start: int, positions: list<array{int, int, int}>}|null
     */
    private function parseVectorTable(string $text, \DateTimeImmutable $start): ?array
    {
        $soe = strpos($text, '$$SOE');
        $eoe = strpos($text, '$$EOE');
        if ($soe === false || $eoe === false) {
            return null;
        }

        $positions = [];
        foreach (explode("\n", trim(substr($text, $soe + 5, $eoe - $soe - 5))) as $line) {
            // JD, calendar date, X, Y, Z, (trailing empty field)
            $fields = array_map('trim', explode(',', $line));
            if (count($fields) < 5) {
                continue;
            }
            $positions[] = [(int) round((float) $fields[2]), (int) round((float) $fields[3]), (int) round((float) $fields[4])];
        }

        return $positions === [] ? null : ['start' => $start->getTimestamp(), 'positions' => $positions];
    }
}
