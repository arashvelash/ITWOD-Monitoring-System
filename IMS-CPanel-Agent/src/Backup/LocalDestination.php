<?php

declare(strict_types=1);

namespace Ims\Agent\Backup;

/** Stores archives in <backupDir>/<jobId>/ inside the hosting account. */
final class LocalDestination implements Destination
{
    /** @var string */
    private $dir;
    /** @var string */
    private $slug;

    public function __construct(string $backupDir, string $jobId, string $slug)
    {
        if (!preg_match('/^[0-9a-f-]{36}$/', $jobId)) {
            throw new \InvalidArgumentException('Invalid job id');
        }
        Naming::assertSlug($slug);
        $this->dir = rtrim($backupDir, '/') . '/' . $jobId;
        $this->slug = $slug;
    }

    public function prepare(): void
    {
        if (!is_dir($this->dir) && !mkdir($this->dir, 0700, true) && !is_dir($this->dir)) {
            throw new \RuntimeException("Cannot create {$this->dir}");
        }
        $htaccess = dirname($this->dir) . '/.htaccess';
        if (!is_file($htaccess)) {
            @file_put_contents($htaccess, "Require all denied\nDeny from all\n");
        }
    }

    public function store(string $file, string $name): string
    {
        $target = $this->path($name);
        if (!rename($file, $target)) {
            throw new \RuntimeException('Cannot move archive into the backup directory');
        }
        @chmod($target, 0600);
        return 'local:' . $target;
    }

    public function list(): array
    {
        $out = [];
        foreach (scandir($this->dir) ?: [] as $name) {
            if (preg_match(Naming::pattern($this->slug), $name) && is_file($this->dir . '/' . $name)) {
                $out[] = $name;
            }
        }
        return $out;
    }

    public function remove(string $name): void
    {
        $path = $this->path($name);
        if (is_file($path)) {
            unlink($path);
        }
    }

    public function workDir(): string
    {
        return $this->dir;
    }

    private function path(string $name): string
    {
        if (!preg_match(Naming::pattern($this->slug), $name)) {
            throw new \RuntimeException("Refusing to touch non-IMS file {$name}");
        }
        return $this->dir . '/' . $name;
    }
}
