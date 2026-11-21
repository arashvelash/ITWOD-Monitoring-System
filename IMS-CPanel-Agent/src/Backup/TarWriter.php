<?php

declare(strict_types=1);

namespace Ims\Agent\Backup;

/**
 * Streaming POSIX ustar writer (GNU LongLink for long names) that writes
 * straight into a gzip stream, so archives are built with constant memory and
 * without shell access (exec/proc_open are often disabled on shared hosting).
 */
final class TarWriter
{
    /** @var resource */
    private $gz;
    /** @var int */
    public $files = 0;
    /** @var int */
    public $bytes = 0;

    /** @param resource $gz handle from gzopen() */
    public function __construct($gz)
    {
        $this->gz = $gz;
    }

    public function addFile(string $path, string $name): void
    {
        $size = filesize($path);
        $in = @fopen($path, 'rb');
        if ($size === false || $in === false) {
            throw new \RuntimeException("Cannot read {$path}");
        }
        try {
            $this->header($name, (int) $size, '0', fileperms($path) & 0777, (int) filemtime($path));
            $written = 0;
            while (!feof($in) && $written < $size) {
                $buf = fread($in, (int) min(1048576, $size - $written));
                if ($buf === false || $buf === '') {
                    break;
                }
                gzwrite($this->gz, $buf);
                $written += strlen($buf);
            }
            if ($written < $size) {
                // File shrank while reading: pad so the archive stays structurally valid.
                gzwrite($this->gz, str_repeat("\0", (int) ($size - $written)));
            }
            $this->pad((int) $size);
            $this->files++;
            $this->bytes += (int) $size;
        } finally {
            fclose($in);
        }
    }

    public function addDirectory(string $path, string $name): void
    {
        $this->header(rtrim($name, '/') . '/', 0, '5', fileperms($path) & 0777, (int) filemtime($path));
    }

    public function addSymlink(string $path, string $name): void
    {
        $target = (string) readlink($path);
        if (strlen($target) > 100) {
            return; // unsupported long link target: skip rather than produce a broken entry
        }
        $this->header($name, 0, '2', 0777, (int) @lstat($path)['mtime'], $target);
    }

    public function close(): void
    {
        gzwrite($this->gz, str_repeat("\0", 1024));
    }

    private function header(string $name, int $size, string $type, int $mode, int $mtime, string $link = ''): void
    {
        if (strlen($name) > 100) {
            // GNU long name extension: a pseudo entry carrying the real name.
            $this->rawHeader('././@LongLink', strlen($name) + 1, 'L', 0644, 0, '');
            gzwrite($this->gz, $name . "\0");
            $this->pad(strlen($name) + 1);
            $name = substr($name, 0, 100);
        }
        $this->rawHeader($name, $size, $type, $mode, $mtime, $link);
    }

    private function rawHeader(string $name, int $size, string $type, int $mode, int $mtime, string $link): void
    {
        $h = str_pad($name, 100, "\0")
            . sprintf('%07o', $mode) . "\0"
            . sprintf('%07o', 0) . "\0"
            . sprintf('%07o', 0) . "\0"
            . sprintf('%011o', $size) . "\0"
            . sprintf('%011o', max(0, $mtime)) . "\0"
            . '        '
            . $type
            . str_pad($link, 100, "\0")
            . "ustar  \0" // GNU magic + version (required for ././@LongLink entries)
            . str_pad('', 32, "\0")
            . str_pad('', 32, "\0")
            . str_repeat("\0", 8) . str_repeat("\0", 8)
            . str_repeat("\0", 155)
            . str_repeat("\0", 12);
        $sum = 0;
        for ($i = 0; $i < 512; $i++) {
            $sum += ord($h[$i]);
        }
        $h = substr_replace($h, sprintf('%06o', $sum) . "\0 ", 148, 8);
        gzwrite($this->gz, $h);
    }

    private function pad(int $size): void
    {
        $rem = $size % 512;
        if ($rem !== 0) {
            gzwrite($this->gz, str_repeat("\0", 512 - $rem));
        }
    }
}
