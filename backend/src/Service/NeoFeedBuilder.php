<?php

namespace App\Service;

use Psr\Cache\CacheItemPoolInterface;
use Psr\Log\LoggerInterface;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpClient\Exception\TransportException;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;

/**
 * Builds the /api/neo feed from all NEO sources: starts every request first
 * (so they run concurrently), then collects each one independently — a
 * source that fails is reported "unavailable" instead of failing the feed —
 * merges them and journals the comparison.
 */
final class NeoFeedBuilder
{
    /** ESA refreshes its lists a few times a day. */
    private const ESA_CLOSE_APPROACHES_TTL = 6 * 3600;

    private const RISK_LISTS_TTL = 86400;

    public function __construct(
        private readonly JplCadClient $jpl,
        private readonly NasaApiClient $nasa,
        private readonly EsaNeoccClient $esa,
        private readonly NeoFeedMerger $merger,
        private readonly NeoComparisonLog $comparisonLog,
        #[Autowire(service: 'cache.app')]
        private readonly CacheItemPoolInterface $cache,
        private readonly LoggerInterface $logger,
    ) {
    }

    /**
     * @throws ExceptionInterface when no close-approach source answered at all
     */
    public function build(string $startDate, string $endDate): array
    {
        $utc = new \DateTimeZone('UTC');
        $pending = [
            'jpl_cad' => $this->jpl->requestApproaches(new \DateTimeImmutable($startDate, $utc), new \DateTimeImmutable($endDate, $utc)),
            'nasa_neows' => $this->nasa->requestNeoApproaches($startDate, $endDate),
            'esa_neocc' => $this->cachedOrRequest('esa_neocc_close_approaches', self::ESA_CLOSE_APPROACHES_TTL, $this->esa->requestCloseApproaches(...)),
            'jpl_sentry' => $this->cachedOrRequest('jpl_sentry_list', self::RISK_LISTS_TTL, $this->jpl->requestSentryList(...)),
            'esa_risk_list' => $this->cachedOrRequest('esa_neocc_risk_list', self::RISK_LISTS_TTL, $this->esa->requestRiskList(...)),
        ];

        $results = [];
        foreach ($pending as $source => $resolve) {
            try {
                $results[$source] = $resolve();
            } catch (ExceptionInterface|\UnexpectedValueException $e) {
                $this->logger->warning(sprintf('NEO source %s unavailable: %s', $source, $e->getMessage()));
                $results[$source] = null;
            }
        }
        if ($results['jpl_cad'] === null && $results['nasa_neows'] === null && $results['esa_neocc'] === null) {
            throw new TransportException('no NEO close-approach source answered');
        }

        $merged = $this->merger->merge(
            $startDate,
            $endDate,
            $results['jpl_cad'],
            $results['nasa_neows'],
            $results['esa_neocc'],
            $results['jpl_sentry'],
            $results['esa_risk_list'],
        );

        try {
            $this->comparisonLog->record($startDate, $endDate, [
                'dist_max_au' => ['jpl_cad' => JplCadClient::DIST_MAX_AU, 'esa_neocc' => EsaNeoccClient::MAX_DIST_AU],
                'sources' => $merged['sources'],
                'source_updates' => [
                    'esa_neocc' => $results['esa_neocc']['last_update'] ?? null,
                    'esa_neocc_coverage' => isset($results['esa_neocc']) ? [$results['esa_neocc']['from'], $results['esa_neocc']['to']] : null,
                    'esa_risk_list' => $results['esa_risk_list']['last_update'] ?? null,
                ],
                'summary' => $merged['comparison'],
                'objects' => $merged['log_objects'],
            ]);
        } catch (\JsonException|\RuntimeException $e) {
            // The journal must never take the feed down with it.
            $this->logger->error('NEO comparison journal not written: '.$e->getMessage());
        }

        return [
            'start_date' => $startDate,
            'end_date' => $endDate,
            'count' => count($merged['objects']),
            'sources' => $merged['sources'],
            'comparison' => $merged['comparison'],
            'objects' => $merged['objects'],
        ];
    }

    /**
     * Reference lists change slowly: served from cache when fresh, otherwise
     * requested now (alongside the other sources) and cached once parsed.
     *
     * @param callable(): \Closure $request
     */
    private function cachedOrRequest(string $key, int $ttl, callable $request): \Closure
    {
        $item = $this->cache->getItem($key);
        if ($item->isHit()) {
            $value = $item->get();

            return static fn () => $value;
        }
        $resolve = $request();

        return function () use ($item, $ttl, $resolve) {
            $value = $resolve();
            $item->set($value)->expiresAfter($ttl);
            $this->cache->save($item);

            return $value;
        };
    }
}
