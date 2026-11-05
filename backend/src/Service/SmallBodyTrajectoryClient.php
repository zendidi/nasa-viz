<?php

namespace App\Service;

use Symfony\Component\HttpClient\Exception\TransportException;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;

/**
 * The tracked-object trajectory tool (lot 2 of docs/briefs/lot2-outil-trajectoire.md):
 * three tables, all on the same fixed range of six calendar years.
 *
 * - trajectory: one DAILY geocentric table of the whole range, for any
 *   asteroid, plus the CAD close approaches when it is a NEO;
 * - precision: one calendar year of a NEO at an HOURLY step, plus 5-minute
 *   segments around its very close passes of that year;
 * - sun: the Sun's daily geocentric table over the same range, so a client can
 *   go heliocentric and place "the Earth at the object's instant".
 *
 * Stateless, like SmallBodyPositionsClient, whose approach rules it reuses
 * (splitApproaches, fineSegmentWindows): the caller resolves the object (SBDB),
 * owns the cache and the clock. Keyless: Horizons and CAD.
 */
final class SmallBodyTrajectoryClient
{
    public const DAILY_STEP_SECONDS = 86400;
    public const HOURLY_STEP_SECONDS = 3600;

    /**
     * The precision table spills this far over each end of its year, so that a
     * client interpolating (Catmull-Rom wants a point on each side) stays
     * continuous where two years meet. Two rows each side; measured 2026-11-05:
     * a normal year is then 8 765 rows (8 760 + 4 + the closing one).
     */
    public const PRECISION_OVERLAP_SECONDS = 7200;

    /** Years kept behind / ahead of the anchor year Y: the range is [Y-1, Y+5) = 6 calendar years. */
    public const YEARS_BEFORE = 1;
    public const YEARS_AFTER = 4;

    /** A table that never changes for a given orbit solution lives this long (30 days). */
    public const TTL_SECONDS = 2592000;
    /** Without an `orbit_id` a changed solution would go unnoticed, so the entry is short. */
    public const TTL_UNKNOWN_ORBIT_SECONDS = 86400;
    public const TTL_NULL_SECONDS = 3600;

    public function __construct(
        private readonly HorizonsClient $horizons,
        private readonly JplCadClient $cad,
    ) {
    }

    /**
     * The common range: 1 January of Y-1 00:00 UTC to 1 January of Y+5 00:00
     * UTC, Y the current UTC year. It always covers -1 / +4 years around now
     * and moves only on 1 January, so a cached table is shared by everyone for
     * a whole year. Daily and end-inclusive: 2 192 rows for 2025 → 2031 (a
     * leap year adds its 29 February, hence not a constant to hard-code).
     *
     * @return array{start: \DateTimeImmutable, end: \DateTimeImmutable}
     */
    public static function trajectoryRange(\DateTimeImmutable $now): array
    {
        $year = self::anchorYear($now);
        $utc = new \DateTimeZone('UTC');

        return [
            'start' => new \DateTimeImmutable(sprintf('%04d-01-01 00:00:00', $year - self::YEARS_BEFORE), $utc),
            'end' => new \DateTimeImmutable(sprintf('%04d-01-01 00:00:00', $year + self::YEARS_AFTER + 1), $utc),
        ];
    }

    /** Y, the current UTC year: the "anchor" the range and the cache keys hang on. */
    public static function anchorYear(\DateTimeImmutable $now): int
    {
        return (int) $now->setTimezone(new \DateTimeZone('UTC'))->format('Y');
    }

    /** Whether a precision `year` is inside [Y-1, Y+4], the years the range covers. */
    public static function isYearInRange(int $year, \DateTimeImmutable $now): bool
    {
        $anchor = self::anchorYear($now);

        return $year >= $anchor - self::YEARS_BEFORE && $year <= $anchor + self::YEARS_AFTER;
    }

    /**
     * What a precision table asks Horizons for: 1 January of `year` minus 2 h
     * to 1 January of `year`+1 plus 2 h. `yearStart` / `yearEnd` are the
     * calendar year itself (the approaches belong to [yearStart, yearEnd)).
     *
     * @return array{start: \DateTimeImmutable, stop: \DateTimeImmutable, yearStart: \DateTimeImmutable, yearEnd: \DateTimeImmutable}
     */
    public static function precisionWindow(int $year): array
    {
        $utc = new \DateTimeZone('UTC');
        $yearStart = new \DateTimeImmutable(sprintf('%04d-01-01 00:00:00', $year), $utc);
        $yearEnd = new \DateTimeImmutable(sprintf('%04d-01-01 00:00:00', $year + 1), $utc);

        return [
            'start' => $yearStart->modify(sprintf('-%d seconds', self::PRECISION_OVERLAP_SECONDS)),
            'stop' => $yearEnd->modify(sprintf('+%d seconds', self::PRECISION_OVERLAP_SECONDS)),
            'yearStart' => $yearStart,
            'yearEnd' => $yearEnd,
        ];
    }

    /**
     * The cache key of an object's table. `$what` is 'trajectory' (anchored on
     * Y) or 'precision' (on the table's own year). The `orbit_id` is in the
     * key: an asteroid's table is NOT immutable, its orbit solution moves with
     * the observations (SBDB, measured 2026-11-05: 2026 TP128 has orbit_id 1
     * from 2026-10-23, Ida's is from 2026-06-05), so a new solution must land
     * on a new key rather than wait out the TTL.
     */
    public static function cacheKey(string $what, string $spkid, int $year, ?string $orbitId): string
    {
        return sprintf('small_body_%s_%s_%d_%s_%s', $what, $spkid, $year, $orbitId ?? 'noorbit', HorizonsClient::TIME_SCALE);
    }

    public static function sunCacheKey(int $anchorYear): string
    {
        return sprintf('small_body_trajectory_sun_%d_%s', $anchorYear, HorizonsClient::TIME_SCALE);
    }

    /** 30 days; a day when the orbit solution is unknown; an hour for a null object. */
    public static function ttlSeconds(?string $orbitId, bool $isNull): int
    {
        return match (true) {
            $isNull => self::TTL_NULL_SECONDS,
            null === $orbitId => self::TTL_UNKNOWN_ORBIT_SECONDS,
            default => self::TTL_SECONDS,
        };
    }

    /**
     * @param array{spkid: string, des: ?string, fullname: ?string, neo: bool, orbit_id: ?string} $body
     * @param array{start: \DateTimeImmutable, end: \DateTimeImmutable} $range as returned by trajectoryRange()
     *
     * @return array<string, mixed>|null null = Horizons has no table. `close_approaches` is null for a
     *   NEO whose CAD call failed — the caller must not cache that.
     *
     * @throws ExceptionInterface when Horizons is unreachable
     */
    public function getTrajectory(array $body, array $range): ?array
    {
        // CAD first, so it is computed while Horizons works on the table.
        $cad = $body['neo'] ? $this->cad->requestObjectApproaches($body['spkid'], $range['start']) : null;

        $table = $this->horizons->getSmallBodyTables([$body['spkid'] => [
            'spkid' => $body['spkid'],
            'start' => $range['start'],
            'stop' => $range['end'],
            'step' => '1d',
        ]])[$body['spkid']] ?? null;
        if (null === $table) {
            return null;
        }

        $approaches = [];
        $next = null;
        if (null !== $cad) {
            try {
                [$approaches, $next] = SmallBodyPositionsClient::splitApproaches($cad(), $range['start'], $range['end']);
            } catch (ExceptionInterface|\UnexpectedValueException) {
                $approaches = null; // the object is still served, minus its approaches
            }
        }

        return [
            'spkid' => $body['spkid'],
            'des' => $body['des'],
            'fullname' => $body['fullname'],
            'neo' => $body['neo'],
            'orbit_id' => $body['orbit_id'],
            'table' => ['start' => $table['start'], 'step_seconds' => self::DAILY_STEP_SECONDS, 'positions' => $table['positions']],
            'close_approaches' => $approaches,
            'next_close_approach_after_range' => $next,
        ];
    }

    /**
     * @param array{spkid: string, des: ?string, fullname: ?string, neo: bool, orbit_id: ?string} $body
     *
     * @return array<string, mixed>|null null = Horizons has no table. `segments` is null for a NEO whose
     *   CAD call failed — the caller must not cache that. A non-NEO has no precise table
     *   (`table: null`, `segments: []`) and costs no upstream call at all.
     *
     * @throws ExceptionInterface when Horizons is unreachable
     */
    public function getPrecision(array $body, int $year): ?array
    {
        $object = [
            'spkid' => $body['spkid'],
            'des' => $body['des'],
            'fullname' => $body['fullname'],
            'neo' => $body['neo'],
            'orbit_id' => $body['orbit_id'],
            'year' => $year,
            'table' => null,
            'segments' => [],
        ];
        if (!$body['neo']) {
            return $object;
        }

        $window = self::precisionWindow($year);
        $cad = $this->cad->requestObjectApproaches($body['spkid'], $window['yearStart']);

        $table = $this->horizons->getSmallBodyTables([$body['spkid'] => [
            'spkid' => $body['spkid'],
            'start' => $window['start'],
            'stop' => $window['stop'],
            'step' => '1h',
        ]])[$body['spkid']] ?? null;
        if (null === $table) {
            return null;
        }
        $object['table'] = ['start' => $table['start'], 'step_seconds' => self::HOURLY_STEP_SECONDS, 'positions' => $table['positions']];

        try {
            // Approaches whose instant falls in the calendar year; a segment (±12 h) may
            // spill over the neighbouring year, which is intended.
            [$approaches] = SmallBodyPositionsClient::splitApproaches($cad(), $window['yearStart'], $window['yearEnd']);
        } catch (ExceptionInterface|\UnexpectedValueException) {
            $object['segments'] = null;

            return $object;
        }

        $requests = [];
        foreach (SmallBodyPositionsClient::fineSegmentWindows($approaches) as $i => [$segStart, $segStop]) {
            $requests[$body['spkid'].'#'.$i] = ['spkid' => $body['spkid'], 'start' => $segStart, 'stop' => $segStop, 'step' => sprintf('%dm', intdiv(SmallBodyPositionsClient::FINE_STEP_SECONDS, 60))];
        }
        if ([] !== $requests) {
            foreach ($this->horizons->getSmallBodyTables($requests) as $segment) {
                if (null !== $segment) {
                    $object['segments'][] = ['start' => $segment['start'], 'step_seconds' => SmallBodyPositionsClient::FINE_STEP_SECONDS, 'positions' => $segment['positions']];
                }
            }
        }

        return $object;
    }

    /**
     * The Sun's daily geocentric table over the range (Horizons major body 10,
     * centre 500@399, UT/ICRF like the planets').
     *
     * @param array{start: \DateTimeImmutable, end: \DateTimeImmutable} $range
     *
     * @return array{start: int, step_seconds: int, positions: list<array{int, int, int}>}
     *
     * @throws ExceptionInterface when Horizons is unreachable or has no table (nothing to serve)
     */
    public function getSun(array $range): array
    {
        $table = $this->horizons->getMajorBodyVectors(['sun' => '10'], $range['start'], $range['end'], '1d')['sun'] ?? null;
        if (null === $table) {
            throw new TransportException('Horizons returned no table for the Sun');
        }

        return ['start' => $table['start'], 'step_seconds' => self::DAILY_STEP_SECONDS, 'positions' => $table['positions']];
    }
}
