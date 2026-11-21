<?php

declare(strict_types=1);

/**
 * Tiny dependency-free test harness (shared hosting has no PHPUnit).
 */
final class T
{
    /** @var int */
    public static $passed = 0;
    /** @var string[] */
    public static $failures = [];
    /** @var string */
    private static $current = '';

    public static function test(string $name, callable $fn): void
    {
        self::$current = $name;
        try {
            $fn();
            self::$passed++;
            echo "  \u{2713} {$name}\n";
        } catch (\Throwable $e) {
            self::$failures[] = "{$name}: " . $e->getMessage();
            echo "  \u{2717} {$name}\n    " . $e->getMessage() . "\n";
        }
    }

    /** @param mixed $expected @param mixed $actual */
    public static function eq($expected, $actual, string $msg = ''): void
    {
        if ($expected !== $actual) {
            throw new \RuntimeException(($msg ? "{$msg}: " : '') . 'expected ' . var_export($expected, true) . ', got ' . var_export($actual, true));
        }
    }

    public static function true(bool $cond, string $msg = 'assertion failed'): void
    {
        if (!$cond) {
            throw new \RuntimeException($msg);
        }
    }

    public static function throws(callable $fn, string $msg = 'expected an exception'): void
    {
        try {
            $fn();
        } catch (\Throwable $e) {
            return;
        }
        throw new \RuntimeException($msg);
    }

    public static function vectors(): array
    {
        return json_decode((string) file_get_contents(__DIR__ . '/vectors/protocol-v1.json'), true);
    }

    /** @var string[] */
    private static $tempDirs = [];

    public static function tempDir(): string
    {
        $dir = sys_get_temp_dir() . '/ims-php-test-' . bin2hex(random_bytes(4));
        mkdir($dir, 0700, true);
        if (!self::$tempDirs) {
            register_shutdown_function([self::class, 'cleanupTempDirs']);
        }
        self::$tempDirs[] = $dir;
        return $dir;
    }

    /** Removes every directory handed out by tempDir() when the test run ends. */
    public static function cleanupTempDirs(): void
    {
        foreach (self::$tempDirs as $dir) {
            if (!is_dir($dir)) {
                continue;
            }
            $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
            foreach ($it as $f) {
                $f->isDir() && !$f->isLink() ? @rmdir($f->getPathname()) : @unlink($f->getPathname());
            }
            @rmdir($dir);
        }
        self::$tempDirs = [];
    }
}
