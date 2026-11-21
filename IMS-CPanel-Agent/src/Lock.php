<?php

declare(strict_types=1);

namespace Ims\Agent;

/** Prevents overlapping cron runs (a long backup must not be started twice). */
final class Lock
{
    /** @var resource|null */
    private $handle;

    public function acquire(string $file): bool
    {
        $handle = fopen($file, 'c');
        if ($handle === false) {
            return false;
        }
        if (!flock($handle, LOCK_EX | LOCK_NB)) {
            fclose($handle);
            return false;
        }
        ftruncate($handle, 0);
        fwrite($handle, (string) getmypid());
        $this->handle = $handle;
        return true;
    }

    public function release(): void
    {
        if ($this->handle) {
            flock($this->handle, LOCK_UN);
            fclose($this->handle);
            $this->handle = null;
        }
    }

    public function __destruct()
    {
        $this->release();
    }
}
