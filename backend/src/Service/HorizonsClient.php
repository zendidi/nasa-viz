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
 * geocentric positions as tables of vectors.
 *
 * Output frame is ICRF, Earth-centred, km — the same equatorial frame the web
 * viewer's star sphere uses. Times are TDB (the API rejects TIME_TYPE) —
 * ~69 s off UTC, negligible here.
 *
 * Two kinds of body, one request shape: only COMMAND and STEP_SIZE differ. A
 * small body is addressed by the designation the catalogues agree on
 * ("DES=2014 SU1;" — Horizons doesn't know NeoWs ids); a major body (planet
 * or natural satellite) by its Horizons id ("499" is Mars, "501" is Io).
 */
final class HorizonsClient
{
    public const STEP_SECONDS = 3600;

    /** Earth centre — the frame every table shared until moons needed their own planet. */
    public const GEOCENTRIC = '500@399';

    /** CENTER for a body's own planet, e.g. `centreOf('599')` for Jupiter. */
    public static function centreOf(string $horizonsId): string
    {
        return '500@'.$horizonsId;
    }

    public function __construct(
        private readonly HttpClientInterface $httpClient,
        #[Autowire(env: 'HORIZONS_BASE_URL')]
        private readonly string $baseUrl,
    ) {
    }

    /**
     * Small bodies, by catalogue designation, at the hourly step their nearly
     * straight geocentric path over an hour is interpolated from. A null entry
     * means Horizons couldn't resolve that designation.
     *
     * @param list<string> $designations
     *
     * @return array<string, array{start: int, positions: list<array{int, int, int}>}|null>
     *
     * @throws ExceptionInterface on transport failure (nothing is known about any object then)
     */
    public function getVectors(array $designations, \DateTimeImmutable $start, \DateTimeImmutable $stop): array
    {
        $commands = [];
        foreach ($designations as $designation) {
            $commands[$designation] = sprintf("'DES=%s;'", $designation);
        }

        return $this->fetch($commands, $start, $stop, sprintf('%dm', intdiv(self::STEP_SECONDS, 60)));
    }

    /**
     * Major bodies (planets, natural satellites) by Horizons id, at whichever
     * step that class of body needs — a planet's geocentric path is smooth
     * enough for a daily step, a close-in moon's is not (see
     * `docs/planetes-et-lunes.md` §3c). `$stepSize` is a Horizons step ('1d',
     * '1h'); a *unitless* value there would mean a number of intervals
     * between the two dates, not a duration.
     *
     * @param array<string, string> $ids the caller's own key => Horizons id, e.g. '499'
     * @param string $center Horizons CENTER — '500@399' is geocentric, '500@599' is
     *   Jupiter-centred. A moon is asked for around *its planet*: the table then needs
     *   no subtraction client-side, and stays usable whatever the planet itself does.
     *
     * @return array<string, array{start: int, positions: list<array{int, int, int}>}|null>
     *
     * @throws ExceptionInterface on transport failure
     */
    public function getMajorBodyVectors(array $ids, \DateTimeImmutable $start, \DateTimeImmutable $stop, string $stepSize, string $center = self::GEOCENTRIC): array
    {
        return $this->fetch(array_map(static fn (string $id) => sprintf("'%s'", $id), $ids), $start, $stop, $stepSize, $center);
    }

    /**
     * Fires one Horizons request per body concurrently (callers keep the batch
     * small — JPL asks users not to hammer the service), then reads them all.
     *
     * @param array<string, string> $commands key => ready-made COMMAND value
     *
     * @return array<string, array{start: int, positions: list<array{int, int, int}>}|null>
     */
    private function fetch(array $commands, \DateTimeImmutable $start, \DateTimeImmutable $stop, string $stepSize, string $center = self::GEOCENTRIC): array
    {
        /** @var array<string, ResponseInterface> $responses */
        $responses = [];
        foreach ($commands as $key => $command) {
            // Query string built by hand: HttpClient's `query` option leaves ';'
            // raw, and Horizons then splits COMMAND='DES=…;' at it (HTTP 400).
            $query = http_build_query([
                'format' => 'json',
                'COMMAND' => $command,
                'OBJ_DATA' => 'NO',
                'MAKE_EPHEM' => 'YES',
                'EPHEM_TYPE' => 'VECTORS',
                'CENTER' => sprintf("'%s'", $center),
                'START_TIME' => sprintf("'%s'", $start->format('Y-m-d H:i')),
                'STOP_TIME' => sprintf("'%s'", $stop->format('Y-m-d H:i')),
                'STEP_SIZE' => sprintf("'%s'", $stepSize),
                'VEC_TABLE' => '1',
                'REF_PLANE' => 'FRAME',
                'OUT_UNITS' => "'KM-S'",
                'CSV_FORMAT' => 'YES',
            ], '', '&', PHP_QUERY_RFC3986);
            $responses[$key] = $this->httpClient->request('GET', $this->baseUrl.'/horizons.api?'.$query, ['timeout' => 30]);
        }

        $result = [];
        foreach ($responses as $key => $response) {
            // Unknown objects still come back 200 (see parseVectorTable) — any
            // other status means the request itself is wrong or JPL is down, so
            // it must not be mistaken for (and cached as) "object not found".
            if (200 !== $response->getStatusCode()) {
                throw new TransportException(sprintf('Horizons answered HTTP %d: %s', $response->getStatusCode(), $response->getContent(false)));
            }
            $data = $response->toArray(false);
            $result[$key] = $this->parseVectorTable($data['result'] ?? '', $start);
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
