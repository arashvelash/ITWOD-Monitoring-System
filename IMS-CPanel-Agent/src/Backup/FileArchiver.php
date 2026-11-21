<?php

declare(strict_types=1);

namespace Ims\Agent\Backup;

/**
 * Builds a .tar.gz of the configured paths. Only paths inside the account's
 * home directory are accepted; the agent directory and the backup directory
 * are always excluded.
 */
final class FileArchiver
{
    /**
     * @param string[] $paths absolute source paths
     * @param string[] $excludes glob patterns (matched against relative path and base name)
     * @return array{files:int, bytes:int, skipped:int}
     */
    public static function create(array $paths, array $excludes, string $home, array $alwaysExclude, string $target, int $level): array
    {
        $homeReal = realpath($home);
        if ($homeReal === false) {
            throw new \RuntimeException('Home directory not found');
        }
        $excludedRoots = array_filter(array_map('realpath', $alwaysExclude));

        $gz = gzopen($target, 'wb' . max(1, min(9, $level)));
        if ($gz === false) {
            throw new \RuntimeException("Cannot create {$target}");
        }
        $tar = new TarWriter($gz);
        $skipped = 0;
        try {
            foreach ($paths as $p) {
                $real = realpath($p);
                if ($real === false) {
                    throw new \RuntimeException("Source path does not exist: {$p}");
                }
                if ($real !== $homeReal && strpos($real, $homeReal . DIRECTORY_SEPARATOR) !== 0) {
                    throw new \RuntimeException("Refusing to archive a path outside the home directory: {$p}");
                }
                $skipped += self::walk($tar, $real, $homeReal, $excludes, $excludedRoots);
            }
            $tar->close();
        } finally {
            gzclose($gz);
        }
        return ['files' => $tar->files, 'bytes' => $tar->bytes, 'skipped' => $skipped];
    }

    /** @param string[] $excludes @param string[] $excludedRoots */
    private static function walk(TarWriter $tar, string $path, string $home, array $excludes, array $excludedRoots): int
    {
        $skipped = 0;
        // Tar member names always use "/" regardless of the host OS.
        $name = str_replace('\\', '/', ltrim(substr($path, strlen($home)), '/\\')) ?: basename($home);
        foreach ($excludedRoots as $root) {
            if ($path === $root || strpos($path, $root . DIRECTORY_SEPARATOR) === 0) {
                return 0;
            }
        }
        foreach ($excludes as $pattern) {
            if (fnmatch($pattern, $name) || fnmatch($pattern, basename($path))) {
                return 0;
            }
        }
        if (is_link($path)) {
            $tar->addSymlink($path, $name);
            return 0;
        }
        if (is_dir($path)) {
            $tar->addDirectory($path, $name);
            $entries = @scandir($path);
            if ($entries === false) {
                return 1;
            }
            foreach ($entries as $e) {
                if ($e === '.' || $e === '..') {
                    continue;
                }
                $skipped += self::walk($tar, $path . DIRECTORY_SEPARATOR . $e, $home, $excludes, $excludedRoots);
            }
            return $skipped;
        }
        if (is_file($path)) {
            try {
                $tar->addFile($path, $name);
            } catch (\Throwable $e) {
                return 1;
            }
        }
        return $skipped;
    }
}
