<?php

namespace App\Tests\Service;

use App\Service\ApodClient;
use PHPUnit\Framework\TestCase;
use Symfony\Component\HttpClient\MockHttpClient;
use Symfony\Component\HttpClient\Response\MockResponse;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;

/**
 * The fixture is a real capture of
 * `science.nasa.gov/wp-json/wp/v2/image-article?per_page=6&orderby=date&order=desc`
 * taken on 2026-09-30, not a hand-written sample — which is the only reason the
 * en-dash trap below was caught before shipping rather than after.
 */
final class ApodClientTest extends TestCase
{
    private const FIXTURES = __DIR__.'/../Fixtures/';

    /** @param list<array<string, mixed>>|string $body */
    private function client(array|string $body, int $code = 200): ApodClient
    {
        return new ApodClient(
            new MockHttpClient(new MockResponse(\is_string($body) ? $body : json_encode($body), ['http_code' => $code])),
            'https://science.test',
        );
    }

    /** @return list<array<string, mixed>> */
    private function rows(): array
    {
        return json_decode(file_get_contents(self::FIXTURES.'science_apod_list.json'), true);
    }

    /** @return array<string, mixed> */
    private function rowOf(string $date): array
    {
        foreach ($this->rows() as $row) {
            if (str_starts_with($row['date'], $date)) {
                return $row;
            }
        }
        self::fail("no fixture row dated $date");
    }

    public function testReturnsTheSameShapeTheLegacyClientReturned(): void
    {
        $apod = $this->client($this->rows())->getApod();

        self::assertSame(
            ['title', 'date', 'explanation', 'media_type', 'url', 'hd_url'],
            array_keys($apod),
            'the route contract is consumed by the web viewer and Unity; it must not drift',
        );
        self::assertSame('Arp 78: Peculiar Galaxy in Aries', $apod['title']);
        self::assertSame('2026-09-30', $apod['date']);
    }

    public function testTakesTheNewestEntryOfTheList(): void
    {
        // The fixture is ordered newest first, and holds 09-30, 09-29 and 09-28.
        self::assertSame('2026-09-30', $this->client($this->rows())->getApod()['date']);
    }

    public function testSkipsArticlesThatAreNotApod(): void
    {
        // `image-article` is a shared post type: measured 2026-09-30, one page of
        // it held 22 APOD entries out of 40. Taking row zero would eventually
        // publish someone else's press photo as the picture of the day.
        $rows = array_merge([[
            'slug' => 'webb-telescope-spots-something-new',
            'date' => '2026-09-30T12:00:00',
            'title' => ['rendered' => 'Webb Telescope Spots Something New'],
            'content' => ['rendered' => 'Explanation: this is not an APOD entry.'],
            'featured_image_url' => 'https://assets.science.test/other.jpg',
        ]], $this->rows());

        self::assertSame('Arp 78: Peculiar Galaxy in Aries', $this->client($rows)->getApod()['title']);
    }

    /**
     * The en dash separating the date from the title arrives literally on one
     * entry and as `&#8211;` on the next — both spellings sat in the same
     * six-row response on 2026-09-30.
     */
    public function testStripsTheApodDatePrefixWhicheverDashSpellingArrives(): void
    {
        $litteral = $this->rowOf('2026-09-30');
        self::assertStringContainsString('–', $litteral['title']['rendered'], 'guard: this row carries a literal en dash');
        self::assertSame('Arp 78: Peculiar Galaxy in Aries', $this->client([$litteral])->getApod()['title']);

        $entite = $this->rowOf('2026-09-29');
        self::assertStringContainsString('&#8211;', $entite['title']['rendered'], 'guard: this row carries the HTML entity');
        self::assertSame('Sh2-188: The Shrimp Nebula', $this->client([$entite])->getApod()['title']);
    }

    /**
     * Cross-source check, and the strongest one available: for 2026-09-29 the
     * legacy api.nasa.gov response is still in this machine's server cache, and
     * it gave exactly this title and date. Same content stream, not a mirror.
     */
    public function testAgreesWithWhatTheLegacyApiReturnedForTheSameDay(): void
    {
        $apod = $this->client([$this->rowOf('2026-09-29')])->getApod();

        self::assertSame('Sh2-188: The Shrimp Nebula', $apod['title']);
        self::assertSame('2026-09-29', $apod['date']);
        self::assertStringStartsWith('What causes the swirl in the Shrimp Nebula?', $apod['explanation']);
    }

    public function testExplanationStartsAfterTheExplanationLabelAndDropsThePageFurniture(): void
    {
        $apod = $this->client($this->rows())->getApod();

        self::assertStringStartsWith('Peculiar spiral galaxy Arp 78', $apod['explanation']);
        self::assertStringEndsWith('spiky foreground Milky Way stars.', $apod['explanation']);
        self::assertStringNotContainsString('Explanation:', $apod['explanation']);
        self::assertStringNotContainsString('Discover the cosmos', $apod['explanation']);
        self::assertStringNotContainsString('Credit', $apod['explanation']);
        self::assertStringNotContainsString('Authors', $apod['explanation']);
    }

    /**
     * On 2026-09-30 the submissions banner was glued onto the final word with no
     * separator ("...Milky Way stars.APOD's email for image submissions has
     * changed"), so cutting at "Tomorrow's picture" alone would have kept it.
     * Worth pinning: the legacy API's own `explanation` field *did* carry these
     * banners — 912 characters against 762 here for 2026-09-29 — so this is not
     * merely parity with the old source, it is cleaner than it.
     */
    public function testDropsTheSubmissionsAndMigrationBannersGluedOntoTheText(): void
    {
        $explanation = $this->client($this->rows())->getApod()['explanation'];

        self::assertStringNotContainsString('email for image submissions', $explanation);
        self::assertStringNotContainsString('APOD Submissions', $explanation);
        self::assertStringNotContainsString('science.nasa.gov/apod', $explanation);
        self::assertStringNotContainsString('Tomorrow', $explanation);
    }

    public function testAsksTheAssetHostForItsOwnSizesInsteadOfThePagesOwn(): void
    {
        $apod = $this->client($this->rows())->getApod();

        // The stored URL arrives with ?w=1772&h=1182&fit=clip&crop=... — appending
        // would leave the server two widths to choose between, so it is replaced.
        self::assertStringEndsWith('?w=960&fit=clip', $apod['url']);
        self::assertStringEndsWith('?w=2400&fit=clip', $apod['hd_url']);
        self::assertStringNotContainsString('w=1772', $apod['url']);
        self::assertStringNotContainsString('crop=', $apod['url']);
        self::assertSame(strtok($apod['url'], '?'), strtok($apod['hd_url'], '?'), 'both sizes are the same photograph');
        self::assertStringStartsWith('https://assets.science.nasa.gov/', $apod['url']);
    }

    public function testAlwaysReportsAnImageBecauseTheSourceCarriesNoMediaType(): void
    {
        // The `<video>` and "youtube" markers in `content` belong to the page's
        // furniture: 2026-09-20 was flagged by them and is a photograph, and
        // `source_asset_url` was empty on all 22 entries measured on 2026-09-30.
        // A video day therefore shows its poster frame, which beats showing
        // nothing. See docs/agent/backlog.md.
        self::assertSame('image', $this->client($this->rows())->getApod()['media_type']);
    }

    /**
     * Every failure below must arrive as a transport exception, never as a PHP
     * warning. That is the whole lesson of 2026-09-30: the legacy client read
     * `$data['title']` unguarded, the warning escaped both catch blocks, and the
     * browser got a response body that did not parse. The controller catches
     * this interface and answers 502.
     */
    public function testEveryMalformedAnswerRaisesACatchableTransportFailure(): void
    {
        $cas = [
            'liste vide' => [[], 200],
            'aucune entree APOD' => [[[
                'slug' => 'not-an-apod',
                'date' => '2026-09-30T00:00:00',
                'title' => ['rendered' => 'Something else'],
                'content' => ['rendered' => ''],
                'featured_image_url' => 'https://assets.science.test/x.jpg',
            ]], 200],
            'image absente' => [[['slug' => 'apod-x', 'date' => '2026-09-30T00:00:00', 'title' => ['rendered' => 'X'], 'content' => ['rendered' => ''], 'featured_image_url' => '']], 200],
            'champ image manquant' => [[['slug' => 'apod-x', 'date' => '2026-09-30T00:00:00', 'title' => ['rendered' => 'X'], 'content' => ['rendered' => '']]], 200],
            'date illisible' => [[['slug' => 'apod-x', 'date' => 'pas une date', 'featured_image_url' => 'https://a.test/x.jpg']], 200],
            'date manquante' => [[['slug' => 'apod-x', 'featured_image_url' => 'https://a.test/x.jpg']], 200],
            'corps non JSON' => ['<html>maintenance</html>', 200],
            'corps vide' => ['', 200],
            'HTTP 500' => ['{}', 500],
            'HTTP 429' => ['{}', 429],
        ];

        $leves = [];
        foreach ($cas as $nom => [$body, $code]) {
            try {
                $this->client($body, $code)->getApod();
            } catch (ExceptionInterface) {
                $leves[] = $nom;
            }
        }

        // Asserted as a list rather than case by case so a failure names exactly
        // which malformed answer slipped through instead of stopping at the first.
        self::assertSame(array_keys($cas), $leves);
    }

    public function testTitleSurvivesAnEntryWhoseTitleHasNoApodPrefix(): void
    {
        // Defensive: if NASA ever drops the "APOD: <date> –" prefix, the title
        // must pass through rather than being mangled by a half-matching regex.
        $apod = $this->client([[
            'slug' => 'apod-2026-september-30-something',
            'date' => '2026-09-30T00:05:00',
            'title' => ['rendered' => 'A Bare Title'],
            'content' => ['rendered' => 'Explanation: text. Tomorrow&#8217;s picture: more'],
            'featured_image_url' => 'https://assets.science.test/x.jpg',
        ]])->getApod();

        self::assertSame('A Bare Title', $apod['title']);
        self::assertSame('text.', $apod['explanation']);
    }
}
