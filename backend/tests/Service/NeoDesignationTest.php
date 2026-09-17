<?php

namespace App\Tests\Service;

use App\Service\NeoDesignation;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class NeoDesignationTest extends TestCase
{
    #[DataProvider('names')]
    public function testFromName(string $name, string $designation, ?string $number): void
    {
        self::assertSame($designation, NeoDesignation::fromName($name));
        self::assertSame($number, NeoDesignation::numberFromName($name));
    }

    public static function names(): iterable
    {
        yield 'provisional only' => ['(2014 SU1)', '2014 SU1', null];
        yield 'numbered' => ['495615 (2015 PQ291)', '2015 PQ291', '495615'];
        yield 'named' => ['99942 Apophis (2004 MN4)', '2004 MN4', '99942'];
        yield 'CAD padding' => ['       (2026 RB39)', '2026 RB39', null];
        yield 'no parentheses' => ['433 Eros', '433 Eros', '433'];
        yield 'bare designation is not a number' => ['2014 SU1', '2014 SU1', null];
        yield 'short designation' => ['1950 DA', '1950 DA', null];
    }

    public function testExpandCompact(): void
    {
        self::assertSame('2026 RB39', NeoDesignation::expandCompact('2026RB39'));
        self::assertSame('1999 FA', NeoDesignation::expandCompact('1999FA'));
        self::assertSame('Zoozve', NeoDesignation::expandCompact('Zoozve'));
    }

    public function testMatchKeys(): void
    {
        self::assertSame(['n:99942', 'd:2004MN4'], NeoDesignation::matchKeys('99942', '2004 MN4'));
        self::assertSame(['d:2026RB39'], NeoDesignation::matchKeys(null, '2026 RB39'));
        self::assertSame(['n:524522'], NeoDesignation::matchKeys('524522', null));
    }
}
