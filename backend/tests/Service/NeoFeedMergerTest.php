<?php

namespace App\Tests\Service;

use App\Service\NeoFeedMerger;
use PHPUnit\Framework\TestCase;

final class NeoFeedMergerTest extends TestCase
{
    private const START = '2026-09-17';
    private const END = '2026-09-18';

    private static function jpl(string $designation, string $at, float $au, array $overrides = []): array
    {
        return $overrides + [
            'designation' => $designation,
            'number' => null,
            'name' => '('.$designation.')',
            'orbit_id' => '3',
            'date' => substr($at, 0, 10),
            'approach_at' => $at,
            'dist_au' => $au,
            'dist_min_au' => $au * 0.99,
            'dist_max_au' => $au * 1.01,
            'v_rel_kms' => 10.0,
            'v_inf_kms' => 9.9,
            'time_uncertainty' => '< 00:01',
            'h' => 25.0,
            'diameter_km' => null,
            'diameter_sigma_km' => null,
            'is_pha' => false,
        ];
    }

    private static function neows(string $designation, string $at, float $au, array $overrides = []): array
    {
        return $overrides + [
            'neows_id' => '3000001',
            'designation' => $designation,
            'number' => null,
            'name' => '('.$designation.')',
            'date' => substr($at, 0, 10),
            'approach_at' => $at,
            'dist_au' => $au,
            'dist_km' => $au * NeoFeedMerger::AU_KM,
            'v_rel_kms' => 10.0,
            'orbiting_body' => 'Earth',
            'h' => 25.0,
            'diameter_min_km' => 0.02,
            'diameter_max_km' => 0.05,
            'is_pha' => false,
            'is_sentry' => false,
        ];
    }

    private static function esaRow(string $designation, string $date, float $km, array $overrides = []): array
    {
        return $overrides + [
            'designation' => $designation,
            'number' => null,
            'name' => '('.$designation.')',
            'date' => $date,
            'dist_km' => $km,
            'dist_au' => round($km / NeoFeedMerger::AU_KM, 6),
            'dist_ld' => 1.0,
            'diameter_m' => 30.0,
            'diameter_estimated' => true,
            'h' => 25.1,
            'max_brightness_mag' => 18.0,
            'v_rel_kms' => 10.1,
            'cai_index' => 1.0,
        ];
    }

    private static function esa(array $approaches): array
    {
        return ['last_update' => '2026-09-17T14:17Z', 'from' => '2026-08-17', 'to' => '2027-09-16', 'approaches' => $approaches];
    }

    private function merge(?array $jpl, ?array $neows, ?array $esa, ?array $sentry = [], ?array $esaRisk = ['last_update' => null, 'objects' => []]): array
    {
        $result = (new NeoFeedMerger())->merge(self::START, self::END, $jpl, $neows, $esa, $sentry, $esaRisk);
        $result['by_designation'] = array_column($result['objects'], null, 'designation');

        return $result;
    }

    public function testObjectSeenByAllThreeSources(): void
    {
        $result = $this->merge(
            [self::jpl('2026 RN4', '2026-09-17T07:36Z', 0.0414556954074886, ['dist_min_au' => 0.0411751208569384, 'dist_max_au' => 0.0417362638020628])],
            [self::neows('2026 RN4', '2026-09-17T07:36Z', 0.0414556954074886)],
            self::esa([self::esaRow('2026 RN4', '2026-09-17', 6200297)]),
        );

        $object = $result['by_designation']['2026 RN4'];
        self::assertSame(['jpl_cad', 'nasa_neows', 'esa_neocc'], $object['sources']);
        self::assertSame('2026-09-17T07:36Z', $object['close_approach']['datetime']);
        self::assertSame(36000.0, $object['close_approach']['relative_velocity_kmh']);
        self::assertSame(['min' => 0.02, 'max' => 0.05], $object['estimated_diameter_km']);

        $comparison = $object['comparison'];
        self::assertSame('found', $comparison['jpl_cad']['status']);
        self::assertSame(['status' => 'found', 'mismatches' => []], $comparison['nasa_neows']);

        $esa = $comparison['esa_neocc'];
        self::assertSame('found', $esa['status']);
        // 0.0414556954 au = 6 201 684 km → ESA is ~1 387 km closer, inside JPL's ±~42 000 km.
        self::assertEqualsWithDelta(-1386.8, $esa['distance_diff_km'], 0.1);
        self::assertTrue($esa['within_jpl_uncertainty']);
        self::assertSame(0, $esa['date_diff_days']);
        self::assertSame([], $esa['mismatches']);
        self::assertSame(0.1, $esa['h_diff']);

        self::assertSame(1, $result['comparison']['esa_neocc']['found']);
        self::assertSame(0, $result['comparison']['esa_neocc']['outside_jpl_uncertainty']);
    }

    public function testEsaDistanceOutsideJplUncertaintyIsFlagged(): void
    {
        $result = $this->merge(
            [self::jpl('2026 NT2', '2026-09-17T05:07Z', 0.0413304639733313, ['dist_min_au' => 0.0413275196638549, 'dist_max_au' => 0.0413334082827044])],
            [],
            self::esa([self::esaRow('2026 NT2', '2026-09-17', 6190000)]),
        );

        $esa = $result['by_designation']['2026 NT2']['comparison']['esa_neocc'];
        self::assertFalse($esa['within_jpl_uncertainty']);
        self::assertSame('dist_km', $esa['mismatches'][0]['field']);
        self::assertSame(1, $result['comparison']['esa_neocc']['outside_jpl_uncertainty']);
    }

    public function testAbsenceIsExplainedByCoverage(): void
    {
        $result = $this->merge(
            [
                // Far: beyond ESA's 0.05 au lists → not covered, not missing.
                self::jpl('2021 LC', '2026-09-17T03:25Z', 0.284743887059297),
                // Close, mid-day, absent from NeoWs and ESA → past NeoWs's catalogue, unexplained for ESA.
                self::jpl('2026 RD38', '2026-09-17T12:21Z', 0.039),
                // 40 min before the range ends → another day split may have excluded it.
                self::jpl('2019 RJ39', '2026-09-18T23:20Z', 0.03),
                // Just inside ESA's cap.
                self::jpl('2020 AB1', '2026-09-17T15:00Z', 0.0495),
            ],
            [self::neows('2021 LC', '2026-09-17T03:25Z', 0.284743887059297), self::neows('2020 AB1', '2026-09-17T15:00Z', 0.0495)],
            self::esa([]),
        );
        $objects = $result['by_designation'];

        self::assertSame(['status' => 'not_covered'], $objects['2021 LC']['comparison']['esa_neocc']);
        self::assertSame(['status' => 'missing', 'reason' => 'catalogue_cutoff'], $objects['2026 RD38']['comparison']['nasa_neows']);
        self::assertSame(['status' => 'missing', 'reason' => 'unknown'], $objects['2026 RD38']['comparison']['esa_neocc']);
        self::assertSame(['status' => 'missing', 'reason' => 'date_boundary'], $objects['2019 RJ39']['comparison']['nasa_neows']);
        self::assertSame(['status' => 'missing', 'reason' => 'distance_boundary'], $objects['2020 AB1']['comparison']['esa_neocc']);
        self::assertSame(['total' => 4, 'found' => 2, 'missing' => 2, 'not_covered' => 0, 'unavailable' => 0, 'mismatched' => 0], ['total' => $result['comparison']['total']] + $result['comparison']['nasa_neows']);
    }

    /**
     * NeoWs's catalogue stops at 2019 designations (measured 2026-10-15), so the
     * cut is on the designation year, not on the approach date — and only for
     * NeoWs: ESA keeps up with 2026 discoveries.
     */
    public function testNeowsAbsenceAfterItsCatalogueCutoffIsExplained(): void
    {
        $result = $this->merge(
            [
                self::jpl('2020 AA', '2026-09-17T10:00Z', 0.03),
                self::jpl('2019 YZ9', '2026-09-17T11:00Z', 0.03),
                self::jpl('Apophis', '2026-09-17T12:00Z', 0.03),
            ],
            [],
            self::esa([]),
        );
        $objects = $result['by_designation'];

        self::assertSame(['status' => 'missing', 'reason' => 'catalogue_cutoff'], $objects['2020 AA']['comparison']['nasa_neows']);
        self::assertSame(['status' => 'missing', 'reason' => 'unknown'], $objects['2020 AA']['comparison']['esa_neocc']);
        // Last year NeoWs still carries: its absence stays unexplained.
        self::assertSame(['status' => 'missing', 'reason' => 'unknown'], $objects['2019 YZ9']['comparison']['nasa_neows']);
        // No provisional year to read: no guess either.
        self::assertSame(['status' => 'missing', 'reason' => 'unknown'], $objects['Apophis']['comparison']['nasa_neows']);
    }

    public function testObjectsOnlyInOtherSourcesAreKeptAndFlagged(): void
    {
        $result = $this->merge(
            [],
            [self::neows('2019 ZZ9', '2026-09-18T11:00Z', 0.12)],
            self::esa([self::esaRow('2026 RF15', '2026-09-18', 2124165, ['h' => 25.6])]),
        );
        $objects = $result['by_designation'];

        self::assertSame(['nasa_neows'], $objects['2019 ZZ9']['sources']);
        self::assertSame(['status' => 'missing', 'reason' => 'unknown'], $objects['2019 ZZ9']['comparison']['jpl_cad']);

        $esaOnly = $objects['2026 RF15'];
        self::assertSame(['esa_neocc'], $esaOnly['sources']);
        self::assertSame('missing', $esaOnly['comparison']['jpl_cad']['status']);
        self::assertNull($esaOnly['close_approach']['datetime']);
        self::assertSame(2124165.0, $esaOnly['close_approach']['miss_distance_km']);
        self::assertEquals(NeoFeedMerger::diameterRangeFromH(25.6), $esaOnly['estimated_diameter_km']);
        self::assertSame(2, $result['comparison']['jpl_cad']['missing']);
    }

    public function testNeowsValueMismatchesAreListed(): void
    {
        $result = $this->merge(
            [self::jpl('2026 NT2', '2026-09-17T05:07Z', 0.04133, ['is_pha' => true])],
            [self::neows('2026 NT2', '2026-09-17T05:12Z', 0.0415, ['is_pha' => false, 'is_sentry' => true])],
            self::esa([]),
        );

        $fields = array_column($result['by_designation']['2026 NT2']['comparison']['nasa_neows']['mismatches'], 'field');
        self::assertSame(['dist_au', 'approach_at', 'is_pha', 'is_sentry'], $fields);
        self::assertTrue($result['by_designation']['2026 NT2']['is_potentially_hazardous'], 'JPL is the reference');
        self::assertSame(1, $result['comparison']['nasa_neows']['mismatched']);
    }

    public function testNumberedObjectsMatchAcrossNamingStyles(): void
    {
        $result = $this->merge(
            [self::jpl('2002 VE68', '2026-09-17T08:00Z', 0.0402, ['number' => '524522', 'name' => '524522 Zoozve (2002 VE68)'])],
            [self::neows('2002 VE68', '2026-09-17T08:00Z', 0.0402, ['number' => '524522', 'name' => '524522 Zoozve (2002 VE68)'])],
            // ESA names it "524522 Zoozve", and puts the approach on the next day.
            self::esa([self::esaRow('', '2026-09-19', 6018473, ['designation' => null, 'number' => '524522', 'name' => '524522 Zoozve'])]),
            [['designation' => '2002 VE68', 'number' => '524522', 'name' => '524522 Zoozve (2002 VE68)']],
            ['last_update' => null, 'objects' => []],
        );

        self::assertCount(1, $result['objects']);
        $object = $result['objects'][0];
        self::assertSame('2002 VE68', $object['designation']);
        self::assertSame(2, $object['comparison']['esa_neocc']['date_diff_days']);
        self::assertTrue($object['is_sentry_object']);
        self::assertSame(['jpl_sentry' => true, 'esa_neocc' => false, 'agree' => false], $object['comparison']['impact_risk_lists']);
        self::assertSame(1, $result['comparison']['impact_risk_lists_disagree']);
    }

    public function testEsaRowOutsideRangeDoesNotCreateAnObject(): void
    {
        $result = $this->merge([], [], self::esa([self::esaRow('2026 SA', '2026-09-20', 1606141)]));

        self::assertSame([], $result['objects']);
    }

    public function testUnavailableSources(): void
    {
        $result = $this->merge([self::jpl('2026 RB39', '2026-09-17T02:29Z', 0.0025)], null, null, null, null);

        $comparison = $result['objects'][0]['comparison'];
        self::assertSame(['status' => 'unavailable'], $comparison['nasa_neows']);
        self::assertSame(['status' => 'unavailable'], $comparison['esa_neocc']);
        self::assertNull($comparison['impact_risk_lists']);
        self::assertSame(
            ['jpl_cad' => 'ok', 'nasa_neows' => 'unavailable', 'esa_neocc' => 'unavailable', 'jpl_sentry' => 'unavailable', 'esa_risk_list' => 'unavailable'],
            $result['sources'],
        );
        self::assertSame(1, $result['comparison']['esa_neocc']['unavailable']);
    }

    public function testLogKeepsEveryRawValue(): void
    {
        $jpl = self::jpl('2026 RN4', '2026-09-17T07:36Z', 0.0414);
        $esaRow = self::esaRow('2026 RN4', '2026-09-17', 6200297);
        $result = $this->merge([$jpl], null, self::esa([$esaRow]));

        $log = $result['log_objects'][0];
        self::assertSame($jpl, $log['jpl_cad']);
        self::assertNull($log['nasa_neows']);
        self::assertSame($esaRow, $log['esa_neocc']);
        self::assertSame($result['objects'][0]['comparison'], $log['comparison']);
    }

    public function testObjectsAreSortedByApproachTime(): void
    {
        $result = $this->merge(
            [self::jpl('B', '2026-09-18T01:00Z', 0.1), self::jpl('A', '2026-09-17T01:00Z', 0.2)],
            [],
            self::esa([]),
        );

        self::assertSame(['A', 'B'], array_column($result['objects'], 'designation'));
    }

    /**
     * Real case, feed 2026-09-21 → 2026-09-22: NeoWs returned `719194 (2018
     * PL23)` twice for one approach — same time, distances 12 cm apart. The
     * second row used to land in a group of its own: 32 objects for 31
     * designations, the asteroid drawn twice, and a ghost carrying
     * `jpl_cad: missing, reason: unknown` in the comparison journal.
     */
    public function testSourceListingOneApproachTwiceYieldsOneObject(): void
    {
        $named = ['number' => '719194', 'name' => '719194 (2018 PL23)'];
        $result = $this->merge(
            [self::jpl('2018 PL23', '2026-09-17T02:11Z', 0.17566, $named)],
            [
                self::neows('2018 PL23', '2026-09-17T02:11Z', 0.175660000008, $named),
                self::neows('2018 PL23', '2026-09-17T02:11Z', 0.175659999998, $named),
            ],
            self::esa([]),
        );

        self::assertCount(1, $result['objects']);
        self::assertCount(1, $result['log_objects']);
        $object = $result['objects'][0];
        self::assertSame(['jpl_cad', 'nasa_neows'], $object['sources']);
        self::assertSame([], $object['comparison']['nasa_neows']['mismatches']);
        self::assertSame(1, $result['comparison']['total']);
        self::assertSame(0, $result['comparison']['jpl_cad']['missing']);
    }

    /** The duplicate is dropped even when the source stands alone — no JPL row to anchor it. */
    public function testDuplicateIsDroppedWithoutAReferenceSource(): void
    {
        $result = $this->merge(
            [],
            [self::neows('2018 PL23', '2026-09-17T02:11Z', 0.17566), self::neows('2018 PL23', '2026-09-17T02:11Z', 0.17566)],
            self::esa([self::esaRow('2026 RN4', '2026-09-17', 6200297), self::esaRow('2026 RN4', '2026-09-17', 6200298)]),
        );

        self::assertSame(['2018 PL23', '2026 RN4'], array_column($result['objects'], 'designation'));
    }

    /**
     * The other side of the same coin: an object really approaching twice inside
     * the range stays two objects, and each source's row joins the approach it
     * belongs to rather than the first free slot.
     */
    public function testTwoGenuineApproachesOfOneObjectStayApart(): void
    {
        $result = $this->merge(
            [self::jpl('2026 XX1', '2026-09-17T04:00Z', 0.02), self::jpl('2026 XX1', '2026-09-18T20:00Z', 0.03)],
            // Second approach first: pairing must go by time, not by arrival order.
            [self::neows('2026 XX1', '2026-09-18T20:00Z', 0.03), self::neows('2026 XX1', '2026-09-17T04:00Z', 0.02)],
            self::esa([]),
        );

        self::assertCount(2, $result['objects']);
        foreach ($result['objects'] as $object) {
            self::assertSame(['jpl_cad', 'nasa_neows'], $object['sources']);
            self::assertSame([], $object['comparison']['nasa_neows']['mismatches'], 'each NeoWs row joined its own approach');
        }
        self::assertSame(['2026-09-17T04:00Z', '2026-09-18T20:00Z'], array_column(array_column($result['objects'], 'close_approach'), 'datetime'));
    }
}
