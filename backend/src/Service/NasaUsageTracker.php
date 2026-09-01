<?php

namespace App\Service;

use Psr\Cache\CacheItemPoolInterface;
use Symfony\Component\DependencyInjection\Attribute\Autowire;

/**
 * Counts real outbound calls to api.nasa.gov (NeoWs/APOD) so clients can show
 * how much of the free-tier daily quota (50/day on DEMO_KEY) has been spent.
 * wheretheiss.at (ISS position) isn't part of that quota and isn't tracked.
 */
final class NasaUsageTracker
{
    public function __construct(
        #[Autowire(service: 'cache.app')]
        private readonly CacheItemPoolInterface $cache,
    ) {
    }

    public function recordCall(): void
    {
        $item = $this->cache->getItem($this->cacheKey());
        $count = $item->isHit() ? $item->get() : 0;
        $item->set($count + 1);
        $item->expiresAfter($this->secondsUntilMidnightUtc());
        $this->cache->save($item);
    }

    public function getTodayCount(): int
    {
        $item = $this->cache->getItem($this->cacheKey());

        return $item->isHit() ? $item->get() : 0;
    }

    public function getToday(): string
    {
        return (new \DateTimeImmutable('today', new \DateTimeZone('UTC')))->format('Y-m-d');
    }

    private function cacheKey(): string
    {
        return 'nasa_api_calls_'.$this->getToday();
    }

    private function secondsUntilMidnightUtc(): int
    {
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));

        return max(1, $now->modify('tomorrow')->getTimestamp() - $now->getTimestamp());
    }
}
