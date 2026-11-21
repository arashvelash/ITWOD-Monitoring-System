<?php

declare(strict_types=1);

namespace Ims\Agent;

/**
 * JSON-lines logger with size-based rotation. Secret-looking keys are redacted.
 */
final class Logger
{
    private const MAX_BYTES = 5 * 1024 * 1024;
    private const SENSITIVE = '/(secret|password|token|key|signature|authorization)/i';

    /** @var string */
    private $file;
    /** @var bool */
    private $echo;

    public function __construct(string $file, bool $echo = false)
    {
        $this->file = $file;
        $this->echo = $echo;
    }

    public function info(string $msg, array $ctx = []): void
    {
        $this->write('info', $msg, $ctx);
    }

    public function warn(string $msg, array $ctx = []): void
    {
        $this->write('warn', $msg, $ctx);
    }

    public function error(string $msg, array $ctx = []): void
    {
        $this->write('error', $msg, $ctx);
    }

    private function write(string $level, string $msg, array $ctx): void
    {
        $line = json_encode(['ts' => gmdate('c'), 'level' => $level, 'msg' => $msg] + self::redact($ctx), JSON_UNESCAPED_SLASHES) . "\n";
        if ($this->echo) {
            fwrite($level === 'info' ? STDOUT : STDERR, $line);
        }
        $dir = dirname($this->file);
        if (!is_dir($dir)) {
            @mkdir($dir, 0700, true);
        }
        if (is_file($this->file) && filesize($this->file) > self::MAX_BYTES) {
            @rename($this->file, $this->file . '.1');
        }
        @file_put_contents($this->file, $line, FILE_APPEND | LOCK_EX);
        @chmod($this->file, 0600);
    }

    private static function redact(array $ctx): array
    {
        $out = [];
        foreach ($ctx as $k => $v) {
            if (is_string($k) && preg_match(self::SENSITIVE, $k)) {
                $out[$k] = '[redacted]';
            } elseif (is_array($v)) {
                $out[$k] = self::redact($v);
            } else {
                $out[$k] = $v;
            }
        }
        return $out;
    }
}
