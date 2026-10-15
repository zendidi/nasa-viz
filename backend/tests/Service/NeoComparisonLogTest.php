<?php

namespace App\Tests\Service;

use App\Service\NeoComparisonLog;
use PHPUnit\Framework\TestCase;
use Symfony\Component\Cache\Adapter\ArrayAdapter;

final class NeoComparisonLogTest extends TestCase
{
    private string $path;

    protected function setUp(): void
    {
        $this->path = sys_get_temp_dir().'/nasa-viz-test-'.bin2hex(random_bytes(4)).'/neo-comparison.jsonl';
    }

    protected function tearDown(): void
    {
        @unlink($this->path);
        @rmdir(dirname($this->path));
    }

    private static function entry(float $distance): array
    {
        return [
            'dist_max_au' => ['jpl_cad' => 0.5],
            'sources' => ['jpl_cad' => 'ok'],
            'source_updates' => ['esa_neocc' => '2026-09-17T14:17Z'],
            'summary' => ['total' => 1],
            'objects' => [['designation' => '2026 RN4', 'jpl_cad' => ['dist_au' => $distance]]],
        ];
    }

    public function testOnlyWritesWhenValuesChange(): void
    {
        $log = new NeoComparisonLog($this->path, new ArrayAdapter());

        self::assertTrue($log->record('2026-09-17', '2026-09-18', self::entry(0.0414)));
        self::assertFalse($log->record('2026-09-17', '2026-09-18', self::entry(0.0414)), 'unchanged');
        self::assertTrue($log->record('2026-09-17', '2026-09-18', self::entry(0.0415)), 'orbit refined');
        self::assertTrue($log->record('2026-09-18', '2026-09-19', self::entry(0.0415)), 'other range');

        $entries = iterator_to_array($log->read(), false);
        self::assertCount(3, $entries);
        self::assertSame('2026-09-17', $entries[0]['start_date']);
        self::assertSame(0.0415, $entries[1]['objects'][0]['jpl_cad']['dist_au']);
        self::assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/', $entries[0]['logged_at']);
    }

    public function testReadSkipsOldAndTruncatedLines(): void
    {
        mkdir(dirname($this->path));
        file_put_contents($this->path, implode("\n", [
            json_encode(['logged_at' => '2020-01-01T00:00:00Z', 'objects' => []]),
            json_encode(['logged_at' => gmdate('Y-m-d\TH:i:s\Z'), 'objects' => []]),
            '{"logged_at": "20',
        ])."\n");
        $log = new NeoComparisonLog($this->path, new ArrayAdapter());

        self::assertCount(1, iterator_to_array($log->read(new \DateTimeImmutable('-30 days')), false));
    }
}
