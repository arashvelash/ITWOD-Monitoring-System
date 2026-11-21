<?php

declare(strict_types=1);

namespace Ims\Agent;

final class Fs
{
    /** Writes via temp file + rename so readers never see partial content. */
    public static function writeAtomic(string $path, string $data, int $mode = 0600): void
    {
        $dir = dirname($path);
        if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) {
            throw new \RuntimeException("Cannot create {$dir}");
        }
        $tmp = $path . '.' . bin2hex(random_bytes(6)) . '.tmp';
        if (file_put_contents($tmp, $data, LOCK_EX) === false) {
            throw new \RuntimeException("Cannot write {$tmp}");
        }
        chmod($tmp, $mode);
        if (!rename($tmp, $path)) {
            @unlink($tmp);
            throw new \RuntimeException("Cannot replace {$path}");
        }
    }

    /** @return mixed */
    public static function readJson(string $path, $default = null)
    {
        if (!is_file($path)) {
            return $default;
        }
        $data = json_decode((string) file_get_contents($path), true);
        return $data === null ? $default : $data;
    }

    /** @param mixed $value */
    public static function writeJson(string $path, $value): void
    {
        self::writeAtomic($path, json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
    }
}
