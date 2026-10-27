<?php

namespace App\Controller;

use Psr\Log\LoggerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;

/**
 * Proxy for space data consumed by the web viewer and the Unity VR client.
 * Every response is normalized JSON (see backend/API.md) so upstream (NASA,
 * JPL, ESA, IMCCE, wheretheiss.at) changes never leak into clients, and every route is cached
 * so both clients together stay well under NASA's free-tier rate limit.
 *
 * The routes are split by domain (NeoController, SolarSystemController,
 * SmallBodyController, SpaceDataController for the rest); what they share is
 * how an upstream failure is told to the client.
 */
abstract class ProxyController
{
    public function __construct(
        protected readonly LoggerInterface $logger,
    ) {
    }

    /**
     * `source` names who failed, in words a viewer recognises ("JPL Horizons"),
     * so a panel can say "JPL est en panne" rather than a generic failure.
     */
    protected function upstreamError(string $route, string $source, ExceptionInterface $e): JsonResponse
    {
        $this->logger->error(sprintf('NASA proxy upstream failure on %s (%s): %s', $route, $source, $e->getMessage()));

        return new JsonResponse(['error' => 'upstream data source unavailable, please retry shortly', 'source' => $source], 502);
    }
}
