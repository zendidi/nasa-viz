<?php

namespace App\Service;

use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Contracts\Cache\CacheInterface;
use Symfony\Contracts\Cache\ItemInterface;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;

/**
 * The two cached feeds that sit on a shared quota or a slow merge -- /api/neo
 * and /api/apod -- with their key, their TTL and their computation in ONE
 * place, so the routes and `app:cache:warm` cannot drift apart: a warm that
 * wrote a different key than the route reads would fill a cache nobody uses.
 *
 * `$refresh` is Symfony cache contracts' `$beta = INF`: the stored value is
 * treated as expired and recomputed now, then stored again with a fresh TTL.
 * The warm command uses it to renew an entry *before* it lapses, so no visitor
 * ever pays for the recompute; the routes keep the plain get(). If the
 * recompute throws, the previous value is left in place.
 */
final class CachedFeeds
{
    /** Normal TTL of a feed; a degraded one (a source down, e.g. NeoWs quota spent) is retried sooner. */
    public const NEO_TTL = 3600;
    public const NEO_DEGRADED_TTL = 600;

    public const APOD_TTL = 86400;

    public function __construct(
        #[Autowire(service: 'cache.app')]
        private readonly CacheInterface $cache,
        private readonly NeoFeedBuilder $neoBuilder,
        private readonly ApodClient $apodClient,
    ) {
    }

    /**
     * The range /api/neo serves when the caller names none: today and tomorrow.
     *
     * @return array{string, string} start_date, end_date
     */
    public static function defaultNeoRange(): array
    {
        $today = new \DateTimeImmutable('today');

        return [$today->format('Y-m-d'), $today->modify('+1 day')->format('Y-m-d')];
    }

    /** Key changed with the multi-source feed shape, so no old NeoWs-only entry is served. */
    public static function neoKey(string $startDate, string $endDate): string
    {
        return 'neo_feed_'.$startDate.'_'.$endDate;
    }

    public static function apodKey(): string
    {
        return 'apod_'.(new \DateTimeImmutable('today'))->format('Y-m-d');
    }

    /**
     * @return array<string, mixed>
     *
     * @throws ExceptionInterface when no close-approach source answered at all
     */
    public function neoFeed(string $startDate, string $endDate, bool $refresh = false): array
    {
        return $this->cache->get(self::neoKey($startDate, $endDate), function (ItemInterface $item) use ($startDate, $endDate) {
            $feed = $this->neoBuilder->build($startDate, $endDate);
            // A degraded feed (a source down, e.g. NeoWs quota spent) is retried sooner.
            $item->expiresAfter(in_array('unavailable', $feed['sources'], true) ? self::NEO_DEGRADED_TTL : self::NEO_TTL);

            return $feed;
        }, $refresh ? \INF : null);
    }

    /**
     * @return array{title: string, date: string, explanation: string, media_type: string, url: string, hd_url: ?string}
     *
     * @throws ExceptionInterface
     */
    public function apod(bool $refresh = false): array
    {
        return $this->cache->get(self::apodKey(), function (ItemInterface $item) {
            $item->expiresAfter(self::APOD_TTL);

            return $this->apodClient->getApod();
        }, $refresh ? \INF : null);
    }
}
