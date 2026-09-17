<?php

namespace App\Tests\Service;

use App\Service\NasaApiClient;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class NasaApiClientTest extends TestCase
{
    #[DataProvider('names')]
    public function testDesignationFromName(string $name, string $expected): void
    {
        self::assertSame($expected, NasaApiClient::designationFromName($name));
    }

    public static function names(): iterable
    {
        yield 'provisional only' => ['(2014 SU1)', '2014 SU1'];
        yield 'numbered' => ['495615 (2015 PQ291)', '2015 PQ291'];
        yield 'named' => ['99942 Apophis (2004 MN4)', '2004 MN4'];
        yield 'no parentheses' => ['433 Eros', '433 Eros'];
    }
}
