<?php

namespace App\Tests\Controller;

use App\Controller\SpaceDataController;
use PHPUnit\Framework\TestCase;

/**
 * Only the pure, static caching decision — SpaceDataController's routes
 * themselves need a kernel (cache pool, routing, HTTP client), which nothing
 * else in this backend sets up for a test; this project's controllers keep
 * their one piece of judgement callable without any of that, exactly so it
 * stays testable on its own (see SmallBodyDetailsClient::compareOrbits for
 * the same pattern on the service side).
 */
final class SpaceDataControllerTest extends TestCase
{
    public function testUnavailableLoadBearingSourceIsNotCacheable(): void
    {
        foreach (['sbdb', 'ssocard', 'sentry'] as $loadBearing) {
            $sources = ['sbdb' => 'ok', 'ssocard' => 'ok', 'sentry' => 'not_found', 'esa' => 'ok'];
            $sources[$loadBearing] = 'unavailable';

            self::assertFalse(SpaceDataController::isCacheable(['sources' => $sources]), $loadBearing);
        }
    }

    public function testEsaUnavailableIsStillCacheable(): void
    {
        // The whole point of excluding ESA from the check: a sheet otherwise
        // complete shouldn't be refetched (JPL included) on every call just
        // because the bonus comparison source is down.
        $details = ['sources' => ['sbdb' => 'ok', 'ssocard' => 'ok', 'sentry' => 'not_found', 'esa' => 'unavailable']];

        self::assertTrue(SpaceDataController::isCacheable($details));
    }

    public function testEverythingOkIsCacheable(): void
    {
        $details = ['sources' => ['sbdb' => 'ok', 'ssocard' => 'ok', 'sentry' => 'ok', 'esa' => 'ok']];

        self::assertTrue(SpaceDataController::isCacheable($details));
    }
}
