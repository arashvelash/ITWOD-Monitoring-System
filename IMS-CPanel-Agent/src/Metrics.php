<?php

declare(strict_types=1);

namespace Ims\Agent;

/**
 * What a shared hosting account can observe without root:
 * load average, disk usage of the home directory and backup directory,
 * PHP runtime information.
 */
final class Metrics
{
    /** @return array<string,mixed> */
    public static function collect(string $backupDir): array
    {
        $home = getenv('HOME') ?: dirname(IMS_AGENT_ROOT);
        $sample = ['collectedAt' => gmdate('Y-m-d\TH:i:s.000\Z')];

        if (function_exists('sys_getloadavg')) {
            $load = @sys_getloadavg();
            if (is_array($load)) {
                $sample['cpu'] = ['load' => array_map(static function ($v) {
                    return round((float) $v, 2);
                }, $load)];
            }
        }

        $total = @disk_total_space($home);
        $free = @disk_free_space($home);
        if ($total && $free !== false) {
            $sample['disks'] = [['mount' => $home, 'fs' => 'account', 'totalBytes' => (int) $total, 'usedBytes' => (int) ($total - $free)]];
        }

        // /proc is often readable on CloudLinux/cPanel; open_basedir may forbid it.
        $uptime = @is_readable('/proc/uptime') ? @file_get_contents('/proc/uptime') : false;
        if (is_string($uptime) && preg_match('/^(\d+(?:\.\d+)?)/', $uptime, $m)) {
            $sample['uptimeSec'] = (int) round((float) $m[1]);
        }

        // Memory and CPU percentages are deliberately not reported: on shared
        // hosting they describe the whole server, which the account cannot act on.
        $sample['hosting'] = [
            'phpVersion' => PHP_VERSION,
            'backupDirBytes' => self::dirSize($backupDir, 20000),
            'memoryLimit' => ini_get('memory_limit'),
        ];
        return $sample;
    }

    /** Bounded directory size calculation (stops after $maxEntries files). */
    public static function dirSize(string $dir, int $maxEntries): ?int
    {
        if (!is_dir($dir)) {
            return 0;
        }
        $size = 0;
        $count = 0;
        try {
            $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS));
            foreach ($it as $file) {
                if (++$count > $maxEntries) {
                    return null;
                }
                if ($file->isFile()) {
                    $size += $file->getSize();
                }
            }
        } catch (\Throwable $e) {
            return null;
        }
        return $size;
    }
}
