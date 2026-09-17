<?php

namespace App\Service;

use Psr\Cache\CacheItemPoolInterface;
use Symfony\Component\DependencyInjection\Attribute\Autowire;

/**
 * Append-only JSON Lines journal of the NEO source comparison
 * (var/log/neo-comparison.jsonl), kept in every environment including prod.
 *
 * One line holds every source's raw values for every object of a date range,
 * plus the computed comparison — but a line is only written when those
 * values changed since the last line for the same range, so hourly refreshes
 * of an unchanged feed don't bloat the file.
 */
final class NeoComparisonLog
{
    public function __construct(
        #[Autowire('%kernel.logs_dir%/neo-comparison.jsonl')]
        private readonly string $path,
        #[Autowire(service: 'cache.app')]
        private readonly CacheItemPoolInterface $cache,
    ) {
    }

    /**
     * @param array<string, mixed> $entry dist_max_au, sources, source_updates, summary, objects
     *
     * @return bool whether a line was written
     */
    public function record(string $startDate, string $endDate, array $entry): bool
    {
        $fingerprint = md5(json_encode([$entry['sources'], $entry['objects']], JSON_THROW_ON_ERROR));
        $item = $this->cache->getItem('neo_comparison_fingerprint_'.$startDate.'_'.$endDate);
        if ($item->isHit() && $item->get() === $fingerprint) {
            return false;
        }

        $line = json_encode(
            ['logged_at' => gmdate('Y-m-d\TH:i:s\Z'), 'start_date' => $startDate, 'end_date' => $endDate] + $entry,
            JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION,
        );
        if (!is_dir(dirname($this->path))) {
            mkdir(dirname($this->path), 0775, true);
        }
        if (file_put_contents($this->path, $line."\n", FILE_APPEND | LOCK_EX) === false) {
            throw new \RuntimeException('cannot write '.$this->path);
        }

        // A range stops being refreshed a few days after it's past.
        $item->set($fingerprint)->expiresAfter(8 * 86400);
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
