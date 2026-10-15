<?php

namespace App\Service;

use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpClient\Exception\TransportException;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;
use Symfony\Contracts\HttpClient\HttpClientInterface;

/**
 * Astronomy Picture of the Day, read from science.nasa.gov rather than from
 * api.nasa.gov — and the reason matters.
 *
 * NASA moved APOD from `apod.nasa.gov` to `science.nasa.gov/apod` during
 * 2026 August-September, with a "update your bookmarks by end of September"
 * deadline (nasa/apod-api#172). On 2026-09-30 the old host was repointed to the
 * platform that serves science.nasa.gov and now presents a certificate valid
 * only for `*.go-vip.co`, so every image URL the legacy API returns is refused
 * by any client that validates certificates. The legacy JSON API broke the same
 * day (nasa/apod-api#180: "upstream connect error or disconnect/reset before
 * headers", reproduced by others with DEMO_KEY).
 *
 * Reading the new home instead buys three things beyond working again:
 *
 * - **No API key.** This is the WordPress REST API of a public site, so APOD
 *   stops spending the shared `DEMO_KEY` budget (30 requests/hour across every
 *   developer). NeoWs becomes its only consumer — see CLAUDE.md.
 * - **Valid certificates**, so the browser will actually load the image.
 * - **Sizes we choose.** The asset host resizes on demand, so the panel
 *   downloads 59 kB instead of the 155 kB the page itself asks for.
 *
 * The cost, stated plainly: this is a website's REST API, not a documented
 * contract like the one it replaces. NASA can change it without notice. That is
 * survivable only because this class is the single place that knows its shape —
 * `/api/apod` keeps returning exactly what it returned before, so neither the
 * web viewer nor Unity changes a line. That is what the proxy in
 * ARCHITECTURE.md is for.
 */
final class ApodClient
{
    private const PATH = '/wp-json/wp/v2/image-article';

    /** Only what normalize() reads: the full record is ~21 kB, this is ~16. */
    private const FIELDS = 'slug,date,title,content,featured_image_url,link';

    /**
     * `image-article` is not an APOD-only post type — measured 2026-09-30, a page
     * of it held 22 APOD entries out of 40 — so the newest few are fetched and
     * filtered rather than trusting the first row to be the picture of the day.
     */
    private const LIST_SIZE = 6;
    private const SLUG_PREFIX = 'apod-';

    /** Panel thumbnail and "see in high resolution", mirroring the old url/hdurl pair. */
    private const PANEL_WIDTH = 960;
    private const HD_WIDTH = 2400;

    /**
     * Well under PHP's `max_execution_time` (30 s in the launcher's php.ini).
     * Without an explicit budget the client inherits `default_socket_timeout`
     * (60 s), which is *longer* than the execution wall — so a hung upstream
     * produced an uncatchable fatal instead of the exception the caller handles.
     * That is exactly how 2026-09-30 surfaced as a JSON parse error in the
     * browser; see docs/agent/gotchas.md.
     */
    private const TIMEOUT_SECONDS = 8;
    private const MAX_DURATION_SECONDS = 18;

    public function __construct(
        private readonly HttpClientInterface $httpClient,
        #[Autowire(env: 'SCIENCE_NASA_BASE_URL')]
        private readonly string $baseUrl,
    ) {
    }

    /**
     * Same shape the legacy client returned, deliberately unchanged.
     *
     * @return array{title: string, date: string, explanation: string, media_type: string, url: string, hd_url: ?string}
     *
     * @throws ExceptionInterface
     */
    public function getApod(): array
    {
        try {
            $rows = $this->httpClient->request('GET', $this->baseUrl.self::PATH, [
                'query' => [
                    'per_page' => self::LIST_SIZE,
                    'orderby' => 'date',
                    'order' => 'desc',
                    '_fields' => self::FIELDS,
                ],
                'timeout' => self::TIMEOUT_SECONDS,
                'max_duration' => self::MAX_DURATION_SECONDS,
            ])->toArray();
        } catch (ExceptionInterface $e) {
            throw new TransportException('Unable to fetch APOD: '.$e->getMessage(), previous: $e);
        }

        foreach ($rows as $row) {
            if (\is_array($row) && str_starts_with((string) ($row['slug'] ?? ''), self::SLUG_PREFIX)) {
                return self::normalize($row);
            }
        }

        // Not a transport failure, but the caller handles this identically: the
        // route answers 502 rather than letting a missing key surface as a PHP
        // warning. Every field below is read defensively for the same reason.
        throw new TransportException(sprintf(
            'No APOD entry among the %d newest science.nasa.gov image articles',
            self::LIST_SIZE,
        ));
    }

    /**
     * @param array<string, mixed> $row
     *
     * @return array{title: string, date: string, explanation: string, media_type: string, url: string, hd_url: ?string}
     *
     * @throws ExceptionInterface
     */
    private static function normalize(array $row): array
    {
        $image = (string) ($row['featured_image_url'] ?? '');
        if ($image === '') {
            throw new TransportException(sprintf('APOD entry "%s" carries no featured image', (string) ($row['slug'] ?? '?')));
        }

        // "2026-09-30T00:05:00" — the date is the picture's day, and the hour is
        // publication noise the contract never carried.
        $date = substr((string) ($row['date'] ?? ''), 0, 10);
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
            throw new TransportException(sprintf('APOD entry "%s" has no usable date', (string) ($row['slug'] ?? '?')));
        }

        return [
            'title' => self::titleOf($row),
            'date' => $date,
            'explanation' => self::explanationOf($row),
            // Always "image". The new source carries no reliable media type: the
            // `<video>` and "youtube" markers found in `content` on 2026-09-30
            // belong to the page's own furniture, not to the picture (2026-09-20
            // was flagged by them and is a photograph), and `source_asset_url`
            // is empty on all 22 entries measured. On a genuine video day the
            // featured image is the poster frame, so the panel shows a still and
            // a link instead of nothing. Noted in docs/agent/backlog.md.
            'media_type' => 'image',
            'url' => self::sized($image, self::PANEL_WIDTH),
            'hd_url' => self::sized($image, self::HD_WIDTH),
        ];
    }

    /**
     * "APOD: 2026 September 30 – Arp 78: Peculiar Galaxy in Aries" → the title
     * alone, which is what the contract has always held.
     *
     * The separator is an en dash, and it arrives either literally or as
     * `&#8211;` depending on the entry — both spellings sat in the same six-row
     * response on 2026-09-30, which is why the fixture is a real capture.
     *
     * @param array<string, mixed> $row
     */
    private static function titleOf(array $row): string
    {
        $title = self::plainText($row['title']['rendered'] ?? '');

        return preg_replace('/^APOD:\s*\d{4}\s+\p{L}+\s+\d{1,2}\s*[\x{2013}\x{2014}-]\s*/u', '', $title) ?? $title;
    }

    /**
     * The explanation out of the rendered page.
     *
     * It starts after "Explanation:" and ends at the earliest piece of standing
     * furniture that follows it. Cutting at the *earliest* marker is not
     * belt-and-braces: on 2026-09-30 the submissions banner was glued straight
     * onto the final word with no separator ("...Milky Way stars.APOD's email
     * for image submissions has changed"), so stopping at "Tomorrow's picture"
     * alone would have swallowed it.
     *
     * Apostrophes are curly once entities are decoded, hence the character class.
     *
     * @param array<string, mixed> $row
     */
    private static function explanationOf(array $row): string
    {
        $text = self::plainText($row['content']['rendered'] ?? '');

        $start = stripos($text, 'Explanation:');
        if ($start === false) {
            return '';
        }
        $text = trim(substr($text, $start + \strlen('Explanation:')));

        if (preg_match('/(Tomorrow[\x{2019}\']s picture|APOD[\x{2019}\']s email|Credit\s*&\s*Copyright|Credit:|Authors\s*&\s*editors)/u', $text, $m, PREG_OFFSET_CAPTURE)) {
            $text = substr($text, 0, $m[0][1]);
        }

        return trim($text);
    }

    /** Tags out, entities decoded, runs of whitespace collapsed. */
    private static function plainText(mixed $html): string
    {
        return trim((string) preg_replace('/\s+/u', ' ', html_entity_decode(strip_tags((string) $html), \ENT_QUOTES | \ENT_HTML5, 'UTF-8')));
    }

    /**
     * The asset host resizes on demand, so the stored query string is replaced
     * rather than extended — the URL arrives carrying the page's own
     * `?w=1772&h=1182&fit=clip&crop=faces,focalpoint`, and appending to that
     * would leave two widths for the server to choose between.
     */
    private static function sized(string $url, int $width): string
    {
        return strtok($url, '?').'?'.http_build_query(['w' => $width, 'fit' => 'clip']);
    }
}
