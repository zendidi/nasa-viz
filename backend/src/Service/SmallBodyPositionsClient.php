<?php

namespace App\Service;

use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;

/**
 * Precise geocentric position tables for a handful of tracked asteroids
 * (any non-comet small body; only the NEO-specific parts are gated on `neo`).
 * All keyless: Horizons for the tables, JPL CAD for the close approaches.
 *
 * Per object, on the planets' window:
 * - a base table, hourly for a NEO and daily for anything else;
 * - NEO only: the close approaches (CAD), and a 5-minute segment around each
 *   very close one.
 *
 * Stateless. The caller resolves the objects (SBDB), owns the cache and the
 * window; this class only orders the upstream calls so that every Horizons
 * request of a phase is in flight at once (fetch() sends a batch before
 * reading it) and CAD travels while the base batch is computed.
 */
final class SmallBodyPositionsClient
{
    /**
     * A NEO's base table is hourly because the category is the one that can
     * pass close and we do not want to guess when; anything else is daily.
     * Measured 2026-10-27 (docs/suivi-asteroides.md): a daily table
     * interpolated with Catmull-Rom is off by ~14 km for any asteroid
     * 180 million km away or more, but by 34 290 km at 40 000 km of
     * distance — and an hourly one by 61 km at 40 000 km.
     */
    public const NEO_STEP_SECONDS = 3600;
    public const OTHER_STEP_SECONDS = 86400;

    /**
     * An approach closer than this gets a fine segment. The hourly table holds
     * to ~100 000 km and gives up below: 2026 TP128 at 7 500 km (2026-10-15)
     * is 2 442 km off, a third of its distance; the 5-minute table brings it to
     * 16 km (10-minute: 106 km). 0.0005 au is ~75 000 km.
     */
    public const FINE_APPROACH_AU = 0.0005;
    public const FINE_STEP_SECONDS = 300;
    /** A segment spans the approach ± this. */
    public const FINE_HALF_SPAN_SECONDS = 43200;
    /** Segments per object; the closest approaches win when there are more. */
    public const MAX_FINE_SEGMENTS = 10;

    public const AU_KM = 149597870.7;

    public function __construct(
        private readonly HorizonsClient $horizons,
        private readonly JplCadClient $cad,
    ) {
    }

    /**
     * @param list<array{spkid: string, des: ?string, fullname: ?string, neo: bool}> $bodies
     * @param \DateTimeImmutable $start the tables' start (SolarSystemClient::positionsStart)
     * @param \DateTimeImmutable $end the tables' end (SolarSystemClient::windowEnd)
     *
     * @return array<int|string, array<string, mixed>|null> by SPK-ID (PHP turns the numeric strings into int keys); null = Horizons has no table.
     *   `close_approaches` is null for a NEO whose CAD call failed — the caller must not cache that.
     *
     * @throws ExceptionInterface when Horizons is unreachable
     */
    public function getPositions(array $bodies, \DateTimeImmutable $start, \DateTimeImmutable $end): array
    {
        // CAD first, so it is computed while Horizons works on the base tables.
        $cad = [];
        foreach ($bodies as $body) {
            if ($body['neo']) {
                $cad[$body['spkid']] = $this->cad->requestObjectApproaches($body['spkid'], $start);
            }
        }

        $requests = [];
        foreach ($bodies as $body) {
            $requests[$body['spkid']] = [
                'spkid' => $body['spkid'],
                'start' => $start,
                'stop' => $end,
                'step' => $body['neo'] ? '1h' : '1d',
            ];
        }
        $tables = $this->horizons->getSmallBodyTables($requests);

        $objects = [];
        $segmentRequests = [];
        foreach ($bodies as $body) {
            $spkid = $body['spkid'];
            $table = $tables[$spkid] ?? null;
            if (null === $table) {
                $objects[$spkid] = null;
                continue;
            }

            $approaches = [];
            $next = null;
            if ($body['neo']) {
                try {
                    [$approaches, $next] = self::splitApproaches(($cad[$spkid])(), $start, $end);
                } catch (ExceptionInterface|\UnexpectedValueException) {
                    $approaches = null; // the object is still served, minus its approaches
                }
            }

            $objects[$spkid] = [
                'spkid' => $spkid,
                'des' => $body['des'],
                'fullname' => $body['fullname'],
                'neo' => $body['neo'],
                'table' => [
                    'start' => $table['start'],
                    'step_seconds' => $body['neo'] ? self::NEO_STEP_SECONDS : self::OTHER_STEP_SECONDS,
                    'positions' => $table['positions'],
                ],
                'segments' => [],
                'close_approaches' => $body['neo'] ? $approaches : [],
                'next_close_approach_after_window' => $next,
            ];

            foreach (self::fineSegmentWindows($approaches ?? []) as $i => [$segStart, $segStop]) {
                $segmentRequests[$spkid.'#'.$i] = ['spkid' => $spkid, 'start' => $segStart, 'stop' => $segStop, 'step' => sprintf('%dm', intdiv(self::FINE_STEP_SECONDS, 60))];
            }
        }

        if ($segmentRequests !== []) {
            foreach ($this->horizons->getSmallBodyTables($segmentRequests) as $key => $segment) {
                if (null !== $segment) {
                    $objects[explode('#', $key)[0]]['segments'][] = [
                        'start' => $segment['start'],
                        'step_seconds' => self::FINE_STEP_SECONDS,
                        'positions' => $segment['positions'],
                    ];
                }
            }
        }

        return $objects;
    }

    /**
     * CAD rows (TDB) → this route's approaches, split at the window's end.
     * Rows before the window's start are dropped; the first at or after the
     * end is the one "next" approach.
     *
     * @param list<array{jd: float, dist_au: float, dist_min_au: float, dist_max_au: float, v_rel_kms: float, t_sigma: string}> $rows
     *
     * @return array{0: list<array<string, mixed>>, 1: array<string, mixed>|null}
     */
    public static function splitApproaches(array $rows, \DateTimeImmutable $start, \DateTimeImmutable $end): array
    {
        $inWindow = [];
        $next = null;
        foreach ($rows as $row) {
            $approach = [
                'time' => JplCadClient::tdbJulianDateToUnixUtc($row['jd']),
                'dist_km' => $row['dist_au'] * self::AU_KM,
                'dist_min_km' => $row['dist_min_au'] * self::AU_KM,
                'dist_max_km' => $row['dist_max_au'] * self::AU_KM,
                'v_rel_km_s' => $row['v_rel_kms'],
                't_sigma' => $row['t_sigma'],
            ];
            if ($approach['time'] < $start->getTimestamp()) {
                continue;
            }
            if ($approach['time'] >= $end->getTimestamp()) {
                if (null === $next || $approach['time'] < $next['time']) {
                    $next = $approach;
                }
                continue;
            }
            $inWindow[] = $approach;
        }
        usort($inWindow, static fn (array $a, array $b) => $a['time'] <=> $b['time']);

        return [$inWindow, $next];
    }

    /**
     * Start and stop of the fine tables: approach ± 12 h, the start floored to a
     * 5-minute boundary (UTC) and the stop rounded up to one, so the rows land
     * on round times. Only approaches under FINE_APPROACH_AU; at most
     * MAX_FINE_SEGMENTS, the closest, returned in time order.
     *
     * @param list<array<string, mixed>> $approaches as returned by splitApproaches()
     *
     * @return list<array{\DateTimeImmutable, \DateTimeImmutable}>
     */
    public static function fineSegmentWindows(array $approaches): array
    {
        $close = array_values(array_filter($approaches, static fn (array $a) => $a['dist_km'] < self::FINE_APPROACH_AU * self::AU_KM));
        usort($close, static fn (array $a, array $b) => $a['dist_km'] <=> $b['dist_km']);
        $close = array_slice($close, 0, self::MAX_FINE_SEGMENTS);
        usort($close, static fn (array $a, array $b) => $a['time'] <=> $b['time']);

        $utc = new \DateTimeZone('UTC');
        $step = self::FINE_STEP_SECONDS;

        return array_map(static fn (array $a) => [
            (new \DateTimeImmutable('@'.(intdiv($a['time'] - self::FINE_HALF_SPAN_SECONDS, $step) * $step)))->setTimezone($utc),
            (new \DateTimeImmutable('@'.((int) ceil(($a['time'] + self::FINE_HALF_SPAN_SECONDS) / $step) * $step)))->setTimezone($utc),
        ], $close);
    }
}
