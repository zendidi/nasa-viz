<?php

namespace App\Tests\Service;

use App\Service\MoonClient;
use PHPUnit\Framework\TestCase;

/**
 * The sampling arithmetic, which is the whole of MoonClient's judgement and the
 * only part that can be wrong without anyone noticing: a step too coarse puts a
 * moon on the wrong side of its planet, a window that doesn't bracket "now"
 * places it where it never was, and both look like plausible pictures.
 */
final class MoonClientTest extends TestCase
{
    /** Every moon of every planet, as the catalogue lists them. */
    private static function allMoons(): array
    {
        $ids = [];
        foreach (['mars', 'jupiter', 'saturn', 'uranus', 'neptune'] as $planet) {
            foreach (MoonClient::forPlanet($planet) as $id) {
                $ids[] = [$id, $planet];
            }
        }

        return $ids;
    }

    public function testTheCatalogueHoldsAtMostNineMoonsPerPlanet(): void
    {
        // The user's rule: all of them when there are 9 or fewer, else the 9
        // largest. Mars is the only planet here with fewer than 9.
        self::assertCount(2, MoonClient::forPlanet('mars'));
        foreach (['jupiter', 'saturn', 'uranus', 'neptune'] as $planet) {
            self::assertCount(9, MoonClient::forPlanet($planet), $planet);
        }
        // Mercury and Venus have none, and that is not a failure to report.
        self::assertSame([], MoonClient::forPlanet('mercury'));
        self::assertSame([], MoonClient::forPlanet('venus'));
        // The Earth's Moon is computed client-side and must never appear here.
        self::assertSame([], MoonClient::forPlanet('earth'));
    }

    public function testEveryWindowBracketsNowWithHalfOfItLeft(): void
    {
        // The bucket is half the window precisely so a table handed out is never
        // about to expire. Checked at several instants, because a bucketing bug
        // typically only shows at one edge of the cycle.
        foreach (['now', '+7 hours', '+3 days', '+40 days', '+200 days'] as $when) {
            $now = new \DateTimeImmutable($when, new \DateTimeZone('UTC'));
            foreach (self::allMoons() as [$id]) {
                $start = MoonClient::windowStart($id, $now)->getTimestamp();
                $window = MoonClient::windowSeconds($id);
                self::assertGreaterThanOrEqual($start, $now->getTimestamp(), "$id at $when starts after now");
                self::assertLessThanOrEqual(
                    $start + intdiv($window, 2),
                    $now->getTimestamp(),
                    "$id at $when is past the first half of its window",
                );
            }
        }
    }

    public function testTheStepIsFineEnoughToInterpolate(): void
    {
        // A 45th of the period is the figure docs/planetes-et-lunes.md §3c
        // settles on; anything much coarser is what put Io on the wrong side of
        // Jupiter. Rounding is to whole minutes, so allow one minute of slack.
        foreach (self::allMoons() as [$id]) {
            $step = MoonClient::stepSeconds($id);
            self::assertGreaterThanOrEqual(60, $step, "$id step is under a minute");
            // Argument order is (expected bound, actual): the window must not
            // exceed what the budget allows, plus a minute for the rounding.
            self::assertLessThanOrEqual(
                $step * (MoonClient::SAMPLE_BUDGET - 1) + 60,
                MoonClient::windowSeconds($id),
                "$id window is longer than its budget allows",
            );
        }
    }

    public function testNoTableExceedsTheSampleBudgetOrTheYearCap(): void
    {
        foreach (self::allMoons() as [$id]) {
            self::assertLessThanOrEqual(MoonClient::SAMPLE_BUDGET, MoonClient::sampleCount($id), $id);
            self::assertGreaterThanOrEqual(2, MoonClient::sampleCount($id), "$id has too few samples to interpolate");
            self::assertLessThanOrEqual(365 * 86400, MoonClient::windowSeconds($id), "$id window outruns a year");
        }
    }

    public function testOnlyTheFourSlowestLackAFullOrbit(): void
    {
        // The year cap costs these four their drawn loop — a known, accepted
        // consequence. If this list ever grows, the cap or the budget moved and
        // somebody should have said so.
        $without = [];
        foreach (self::allMoons() as [$id]) {
            if (!MoonClient::coversFullOrbit($id)) {
                $without[] = $id;
            }
        }
        self::assertSame(['pasiphae', 'phoebe', 'sycorax', 'halimede'], $without);

        // Where a loop is drawn, it is drawn from samples the table really has.
        foreach (self::allMoons() as [$id]) {
            if (MoonClient::coversFullOrbit($id)) {
                self::assertLessThanOrEqual(MoonClient::sampleCount($id), MoonClient::orbitSampleCount($id), $id);
                self::assertGreaterThanOrEqual(3, MoonClient::orbitSampleCount($id), "$id loop has too few points");
            }
        }
    }

    public function testDescribeCarriesWhatAClientNeedsToDrawTheBody(): void
    {
        $ganymede = MoonClient::describe('ganymede');
        self::assertSame('jupiter', $ganymede['planet']);
        self::assertSame('Ganymede', $ganymede['name']);
        self::assertGreaterThan(2000.0, $ganymede['radius_km']);
        self::assertGreaterThan(1_000_000, $ganymede['orbit_km']);

        self::assertTrue(MoonClient::isKnown('phobos'));
        self::assertFalse(MoonClient::isKnown('moon'));
    }
}
