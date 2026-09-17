<?php

namespace App\Service;

use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;
use Symfony\Contracts\HttpClient\ResponseInterface;

final class HttpResponses
{
    /**
     * Reads the status of every response before any is parsed. Symfony
     * HttpClient throws from the destructor of a 3xx-5xx response whose status
     * was never read — so when one of several parallel responses fails to
     * parse, the others would otherwise throw later, outside the caller's
     * error handling. Rethrows the first transport failure, after all were read.
     *
     * @throws ExceptionInterface
     */
    public static function settle(ResponseInterface ...$responses): void
    {
        $failure = null;
        foreach ($responses as $response) {
            try {
                $response->getStatusCode();
            } catch (ExceptionInterface $e) {
                $failure ??= $e;
            }
        }
        if ($failure !== null) {
            throw $failure;
        }
    }
}
