<?php

namespace App\Service;

use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Contracts\HttpClient\HttpClientInterface;
use Symfony\Contracts\HttpClient\ResponseInterface;

/**
 * ESA's NEO Coordination Centre (neo.ssa.esa.int) — keyless. ESA computes its
 * own orbits from the same Minor Planet Center observations as JPL, which
 * makes it the independent point of comparison for JPL's figures.
 *
 * Its lists are fixed-width text tables with "|" separators, preceded by a
 * "Last Update:" line and three header lines. Like JplCadClient, request
 * methods send immediately and return a parsing closure.
 */
final class EsaNeoccClient
{
    /** ESA's close-approach lists stop here (largest distance seen on 2026-09-17: 0.049755 au over a year). */
    public const MAX_DIST_AU = 0.05;

    public function __construct(
        private readonly HttpClientInterface $httpClient,
        #[Autowire(env: 'ESA_NEOCC_BASE_URL')]
        private readonly string $baseUrl,
    ) {
    }

    /**
     * Past (~1 month) and upcoming (~1 year) close approaches under 0.05 au.
     * `from`/`to` bound the dates the two lists cover; approach dates carry no
     * time of day.
     *
     * @return \Closure(): array{last_update: ?string, from: ?string, to: ?string, approaches: list<array<string, mixed>>}
     */
    public function requestCloseApproaches(): \Closure
    {
        $recent = $this->download('esa_recent_close_app');
        $upcoming = $this->download('esa_upcoming_close_app');

        return static function () use ($recent, $upcoming): array {
            HttpResponses::settle($recent, $upcoming);
            $recentTable = self::parseTable($recent->getContent());
            $upcomingTable = self::parseTable($upcoming->getContent());

            $approaches = [];
            foreach ([...$recentTable['rows'], ...$upcomingTable['rows']] as $fields) {
                $approach = self::normalizeApproach($fields);
                // Today's approaches can appear in both lists.
                $approaches[implode('|', NeoDesignation::matchKeys($approach['number'], $approach['designation'])).'|'.$approach['date']] = $approach;
            }
            $approaches = array_values($approaches);
            $dates = array_column($approaches, 'date');

            return [
                'last_update' => $upcomingTable['last_update'] ?? $recentTable['last_update'],
                'from' => $dates === [] ? null : min($dates),
                'to' => $dates === [] ? null : max($dates),
                'approaches' => $approaches,
            ];
        };
    }

    /**
     * ESA's impact-risk list — its counterpart to JPL Sentry.
     *
     * @return \Closure(): array{last_update: ?string, objects: list<array<string, mixed>>}
     */
    public function requestRiskList(): \Closure
    {
        $response = $this->download('esa_risk_list');

        return static function () use ($response): array {
            $table = self::parseTable($response->getContent());

            return [
                'last_update' => $table['last_update'],
                'objects' => array_map(static function (array $fields) {
                    if (count($fields) < 11) {
                        throw new \UnexpectedValueException('ESA risk list row with '.count($fields).' columns');
                    }

                    return self::identify($fields[0]) + [
                        'diameter_m' => self::number($fields[1]),
                        'diameter_estimated' => $fields[2] === '*',
                        'max_impact_at' => $fields[3],
                        'impact_probability_max' => self::number($fields[4]),
                        'palermo_max' => self::number($fields[5]),
                        'torino_max' => (int) $fields[6],
                        'v_impact_kms' => self::number($fields[7]),
                        'range' => $fields[8],
                        'impact_probability' => self::number($fields[9]),
                        'palermo_cum' => self::number($fields[10]),
                    ];
                }, $table['rows']),
            ];
        };
    }

    private function download(string $file): ResponseInterface
    {
        return $this->httpClient->request('GET', $this->baseUrl.'/download', ['query' => ['file' => $file]]);
    }

    /**
     * @return array{last_update: ?string, rows: list<list<string>>}
     */
    public static function parseTable(string $text): array
    {
        $lines = preg_split('/\R/', $text);
        if (!preg_match('/^Last Update:\s*(.+?)\s*$/', $lines[0] ?? '', $matches)) {
            throw new \UnexpectedValueException('ESA table without "Last Update" line: '.substr($text, 0, 120));
        }
        $lastUpdate = \DateTimeImmutable::createFromFormat('Y-m-d H:i T', $matches[1]);

        // The last header line is a format template ("AAAAAAAAAAAA …").
        $bodyStart = null;
        foreach ($lines as $i => $line) {
            if (str_starts_with($line, 'AAAA')) {
                $bodyStart = $i + 1;
                break;
            }
        }
        if ($bodyStart === null) {
            throw new \UnexpectedValueException('ESA table without header template line');
        }

        $rows = [];
        foreach (array_slice($lines, $bodyStart) as $line) {
            if (trim($line) === '') {
                continue;
            }
            $rows[] = array_map('trim', explode('|', rtrim(rtrim($line), '|')));
        }

        return ['last_update' => $lastUpdate ? $lastUpdate->format('Y-m-d\TH:i\Z') : null, 'rows' => $rows];
    }

    /** @param list<string> $fields */
    private static function normalizeApproach(array $fields): array
    {
        if (count($fields) < 11) {
            throw new \UnexpectedValueException('ESA close-approach row with '.count($fields).' columns');
        }

        return self::identify($fields[0]) + [
            'date' => $fields[1],
            'dist_km' => self::number($fields[2]),
            'dist_au' => self::number($fields[3]),
            'dist_ld' => self::number($fields[4]),
            'diameter_m' => self::number($fields[5]),
            'diameter_estimated' => $fields[6] === '*',
            'h' => self::number($fields[7]),
            'max_brightness_mag' => self::number($fields[8]),
            'v_rel_kms' => self::number($fields[9]),
            'cai_index' => self::number($fields[10]),
        ];
    }

    /**
     * "2026RB39" (unnumbered), "524522 Zoozve" or "893859 2016VO1" (numbered).
     *
     * @return array{designation: ?string, number: ?string, name: string}
     */
    private static function identify(string $object): array
    {
        $tokens = preg_split('/\s+/', trim($object));
        if (count($tokens) === 1 && ctype_digit($tokens[0])) {
            return ['designation' => null, 'number' => $tokens[0], 'name' => $tokens[0]];
        }
        if (ctype_digit($tokens[0])) {
            $rest = implode(' ', array_slice($tokens, 1));
            $isDesignation = (bool) preg_match('/^\d{4}[A-Z]{2}\d*$/', $rest);

            return [
                'designation' => $isDesignation ? NeoDesignation::expandCompact($rest) : null,
                'number' => $tokens[0],
                'name' => $isDesignation ? sprintf('%s (%s)', $tokens[0], NeoDesignation::expandCompact($rest)) : $tokens[0].' '.$rest,
            ];
        }
        $designation = NeoDesignation::expandCompact(implode(' ', $tokens));

        return ['designation' => $designation, 'number' => null, 'name' => '('.$designation.')'];
    }

    private static function number(string $field): ?float
    {
        return is_numeric($field) ? (float) $field : null;
    }
}
