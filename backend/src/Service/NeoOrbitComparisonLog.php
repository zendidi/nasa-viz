<?php

namespace App\Service;

use Psr\Cache\CacheItemPoolInterface;
use Symfony\Component\DependencyInjection\Attribute\Autowire;

/**
 * Append-only JSON Lines journal of the NEO orbit comparison
 * (var/log/neo-orbit-comparison.jsonl), kept in every environment including
 * prod. A sibling of NeoComparisonLog, not a reuse of it: that journal is one
 * line per close-approach DATE RANGE, this one is one line per OBJECT — a
 * single file mixing both shapes would break whichever reader expects the
 * other one, so each granularity gets its own file and its own fingerprint
 * key (there, "range"; here, "designation").
 */
final class NeoOrbitComparisonLog
{
    public function __construct(
        #[Autowire('%kernel.logs_dir%/neo-orbit-comparison.jsonl')]
        private readonly string $path,
        #[Autowire(service: 'cache.app')]
        private readonly CacheItemPoolInterface $cache,
    ) {
    }

    /**
     * @param array<string, mixed> $entry sources, orbits, comparison
     *
     * @return bool whether a line was written
     */
    public function record(string $designation, array $entry): bool
    {
        $fingerprint = md5(json_encode([$entry['sources'], $entry['orbits']], JSON_THROW_ON_ERROR));
        $item = $this->cache->getItem('neo_orbit_comparison_fingerprint_'.md5($designation));
        if ($item->isHit() && $item->get() === $fingerprint) {
            return false;
        }

        $line = json_encode(
            ['logged_at' => gmdate('Y-m-d\TH:i:s\Z'), 'designation' => $designation] + $entry,
            JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION,
        );
        if (!is_dir(dirname($this->path))) {
            mkdir(dirname($this->path), 0775, true);
        }
        if (file_put_contents($this->path, $line."\n", FILE_APPEND | LOCK_EX) === false) {
            throw new \RuntimeException('cannot write '.$this->path);
        }

        // Orbits are refit over months, not hours — a week is plenty to avoid
        // rewriting an unchanged line on every /api/neo/details cache miss.
        $item->set($fingerprint)->expiresAfter(7 * 86400);
        $this->cache->save($item);

        return true;
    }

    /**
     * Entries logged since $since (all when null), oldest first.
     *
     * @return \Generator<array<string, mixed>>
     */
    public function read(?\DateTimeImmutable $since = null): \Generator
    {
        if (!is_file($this->path)) {
            return;
        }
        $handle = fopen($this->path, 'r');
        try {
            while (($line = fgets($handle)) !== false) {
                if (trim($line) === '') {
                    continue;
                }
                $entry = json_decode($line, true);
                if (!is_array($entry)) {
                    continue; // a truncated last line (crash mid-write) shouldn't block the report
                }
                if ($since !== null && new \DateTimeImmutable($entry['logged_at']) < $since) {
                    continue;
                }
                yield $entry;
            }
        } finally {
            fclose($handle);
        }
    }

    public function getPath(): string
    {
        return $this->path;
    }
}
