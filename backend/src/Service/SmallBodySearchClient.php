<?php

namespace App\Service;

use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpClient\Exception\TransportException;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;
use Symfony\Contracts\HttpClient\HttpClientInterface;

/**
 * Resolves a name or designation typed by a user ("Apophis", "2004 MN4",
 * "99942", "20099942") to one asteroid, through JPL SBDB's `sstr` lookup —
 * keyless, so this spends no NASA quota. "Asteroid" here is any non-comet
 * small body (1.58 M of them), not only NEOs: `neo` in the answer is a
 * property of the match, never a precondition.
 *
 * Comets are out of scope for now (Horizons needs an apparition choice, see
 * docs/cometes.md): a comet match is reported as `rejected`, and comets are
 * dropped from candidate lists.
 */
final class SmallBodySearchClient
{
    /** Same pair as SmallBodyDetailsClient — one request, so no concurrency budget to share. */
    private const TIMEOUT_SECONDS = 8;
    private const MAX_DURATION_SECONDS = 15;

    public const MAX_CANDIDATES = 20;

    public function __construct(
        private readonly HttpClientInterface $httpClient,
        #[Autowire(env: 'JPL_SSD_API_BASE_URL')]
        private readonly string $jplBaseUrl,
    ) {
    }

    /**
     * The query as the cache keys on it and as SBDB receives it: trimmed,
     * inner spaces collapsed. Null when it is not an acceptable query —
     * 1 to 40 characters of letters, digits, space and ' / ( ) . -. No `*`:
     * the wildcard is ours to add, see search().
     */
    public static function normalizeQuery(string $raw): ?string
    {
        $query = preg_replace('/ +/', ' ', trim($raw));
        if ($query === null || $query === '' || mb_strlen($query) > 40 || !preg_match('/^[\p{L}\p{N} \'\/().\-]+$/u', $query)) {
            return null;
        }

        return $query;
    }

    /** Case-insensitive, since SBDB is. */
    public static function cacheKey(string $normalizedQuery): string
    {
        return 'small_body_search_'.md5(mb_strtolower($normalizedQuery));
    }

    /**
     * One of:
     * - `['match' => [...]]` — one asteroid;
     * - `['match' => null, 'rejected' => ['reason' => 'comet', 'fullname' => …]]`;
     * - `['match' => null, 'candidates' => [...up to MAX_CANDIDATES], 'count' => N]`
     *   where N is the number of non-comet candidates SBDB found, not the
     *   length of the truncated list;
     * - `['match' => null]` — nothing.
     *
     * @param string $query already through normalizeQuery()
     *
     * @return array<string, mixed>
     *
     * @throws ExceptionInterface when SBDB is unreachable or answers 5xx / garbage
     */
    public function search(string $query): array
    {
        $answer = $this->ask($query);
        if ($answer['code'] === 'notfound') {
            // "Apo" is not a name but "Apo*" lists seven; SBDB won't do that itself.
            $answer = $this->ask($query.'*');
        }

        return match ($answer['code']) {
            'match' => self::fromObject($answer['body']['object']),
            'list' => self::fromList($answer['body']),
            default => ['match' => null],
        };
    }

    /**
     * SBDB's HTTP status mirrors the body's `code`: an ambiguous query is
     * answered HTTP 300 (with a body, no Location), an unknown one HTTP 200.
     * getContent(false) is what keeps Symfony from throwing on the 300.
     *
     * @return array{code: 'match'|'list'|'notfound', body: array<string, mixed>}
     */
    private function ask(string $sstr): array
    {
        $response = $this->httpClient->request('GET', $this->jplBaseUrl.'/sbdb.api', [
            'query' => ['sstr' => $sstr],
            'timeout' => self::TIMEOUT_SECONDS,
            'max_duration' => self::MAX_DURATION_SECONDS,
        ]);
        $status = $response->getStatusCode();
        $body = json_decode($response->getContent(false), true);
        if (!is_array($body) || !in_array($status, [200, 300], true)) {
            throw new TransportException(sprintf('JPL SBDB answered HTTP %d for "%s"', $status, $sstr));
        }

        return match (true) {
            isset($body['object']) => ['code' => 'match', 'body' => $body],
            $status === 300 || isset($body['list']) => ['code' => 'list', 'body' => $body],
            default => ['code' => 'notfound', 'body' => $body],
        };
    }

    /**
     * @param array<string, mixed> $object
     *
     * @return array<string, mixed>
     */
    private static function fromObject(array $object): array
    {
        if (str_starts_with(strtolower((string) ($object['kind'] ?? '')), 'c')) {
            return ['match' => null, 'rejected' => ['reason' => 'comet', 'fullname' => $object['fullname'] ?? null]];
        }
        $orbitClass = $object['orbit_class'] ?? null;

        return ['match' => [
            'spkid' => isset($object['spkid']) ? (string) $object['spkid'] : null,
            'des' => $object['des'] ?? null,
            'fullname' => $object['fullname'] ?? null,
            'shortname' => $object['shortname'] ?? null,
            'kind' => $object['kind'] ?? null,
            'neo' => isset($object['neo']) ? (bool) $object['neo'] : null,
            'pha' => isset($object['pha']) ? (bool) $object['pha'] : null,
            'orbit_class' => is_array($orbitClass) ? ['code' => $orbitClass['code'] ?? null, 'name' => $orbitClass['name'] ?? null] : null,
        ]];
    }

    /**
     * @param array<string, mixed> $body
     *
     * @return array<string, mixed>
     */
    private static function fromList(array $body): array
    {
        $list = is_array($body['list'] ?? null) ? $body['list'] : [];
        $candidates = [];
        foreach ($list as $entry) {
            if (!is_array($entry) || !isset($entry['pdes']) || self::isCometDesignation((string) $entry['pdes'])) {
                continue;
            }
            $candidates[] = ['pdes' => (string) $entry['pdes'], 'name' => $entry['name'] ?? null];
        }
        if ($candidates === []) {
            return ['match' => null];
        }
        // SBDB's own count can exceed the list it sends; take the comets we
        // dropped off that count rather than recounting what we were handed.
        $total = max(count($candidates), (is_numeric($body['count'] ?? null) ? (int) $body['count'] : count($list)) - (count($list) - count($candidates)));

        return ['match' => null, 'candidates' => array_slice($candidates, 0, self::MAX_CANDIDATES), 'count' => $total];
    }

    /**
     * Periodic / numbered-periodic / interstellar-numbered comets ("1P",
     * "73P-B") and every `X/` prefixed designation ("C/2020 F3", "P/2010 A2").
     * "A/2017 U1" is deliberately kept: that prefix marks an asteroid on a
     * comet-like orbit.
     */
    private static function isCometDesignation(string $pdes): bool
    {
        return (bool) preg_match('/^\d+[PDI](-[A-Z]+)?$/', $pdes) || (bool) preg_match('/^[PCDXI]\//', $pdes);
    }
}
