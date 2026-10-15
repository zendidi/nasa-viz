<?php

namespace App\Tests\Service;

use App\Service\NeoOrbitComparisonLog;
use PHPUnit\Framework\TestCase;
use Symfony\Component\Cache\Adapter\ArrayAdapter;

final class NeoOrbitComparisonLogTest extends TestCase
{
    private string $path;

    protected function setUp(): void
    {
        $this->path = sys_get_temp_dir().'/nasa-viz-test-'.bin2hex(random_bytes(4)).'/neo-orbit-comparison.jsonl';
    }

    protected function tearDown(): void
    {
        @unlink($this->path);
        @rmdir(dirname($this->path));
    }

    private static function entry(float $aAu): array
    {
        return [
            'sources' => ['sbdb' => 'ok', 'esa' => 'ok', 'ssocard' => 'not_found'],
            'orbits' => ['sbdb' => ['a_au' => $aAu], 'esa' => ['a_au' => 0.9226], 'ssocard' => null],
            'comparison' => ['compared' => ['sbdb', 'esa'], 'spread' => ['a_au' => abs($aAu - 0.9226)], 'worst' => ['field' => 'a_au', 'relative' => 0.001]],
        ];
    }

    public function testOnlyWritesWhenValuesChange(): void
    {
        $log = new NeoOrbitComparisonLog($this->path, new ArrayAdapter());

        self::assertTrue($log->record('99942', self::entry(0.9224)));
        self::assertFalse($log->record('99942', self::entry(0.9224)), 'unchanged');
        self::assertTrue($log->record('99942', self::entry(0.9225)), 'orbit refined');
        self::assertTrue($log->record('2004 MN4', self::entry(0.9224)), 'other object');

        $entries = iterator_to_array($log->read(), false);
        self::assertCount(3, $entries);
        self::assertSame('99942', $entries[0]['designation']);
        self::assertSame(0.9225, $entries[1]['orbits']['sbdb']['a_au']);
        self::assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/', $entries[0]['logged_at']);
    }

    public function testReadSkipsOldAndTruncatedLines(): void
    {
        mkdir(dirname($this->path));
        file_put_contents($this->path, implode("\n", [
            json_encode(['logged_at' => '2020-01-01T00:00:00Z', 'designation' => '99942']),
            json_encode(['logged_at' => gmdate('Y-m-d\TH:i:s\Z'), 'designation' => '99942']),
            '{"logged_at": "20',
        ])."\n");
        $log = new NeoOrbitComparisonLog($this->path, new ArrayAdapter());

        self::assertCount(1, iterator_to_array($log->read(new \DateTimeImmutable('-30 days')), false));
    }

    public function testGetPathReturnsConfiguredFile(): void
    {
        $log = new NeoOrbitComparisonLog($this->path, new ArrayAdapter());

        self::assertSame($this->path, $log->getPath());
    }
}
