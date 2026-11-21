<?php

declare(strict_types=1);

namespace Ims\Agent;

/**
 * Durable report queue: reports are written to disk first and removed only
 * after Core acknowledged them.
 */
final class Outbox
{
    private const MAX_FILES = 2000;

    /** @var string */
    private $dir;

    public function __construct(string $dir)
    {
        $this->dir = $dir;
        if (!is_dir($dir)) {
            @mkdir($dir, 0700, true);
        }
    }

    /** @param mixed $data */
    public function add(string $type, $data): void
    {
        $files = $this->files();
        if (count($files) >= self::MAX_FILES) {
            @unlink($this->dir . '/' . $files[0]);
        }
        $name = sprintf('%015d-%s.json', (int) (microtime(true) * 1000), bin2hex(random_bytes(4)));
        Fs::writeJson($this->dir . '/' . $name, ['type' => $type, 'data' => $data]);
    }

    public function flush(CoreClient $client, Logger $log): void
    {
        for ($round = 0; $round < 20; $round++) {
            $files = array_slice($this->files(), 0, 100);
            if (!$files) {
                return;
            }
            $reports = [];
            $names = [];
            foreach ($files as $f) {
                $r = Fs::readJson($this->dir . '/' . $f);
                if (is_array($r) && isset($r['type'])) {
                    $reports[] = $r;
                    $names[] = $f;
                } else {
                    @unlink($this->dir . '/' . $f);
                }
            }
            if (!$reports) {
                continue;
            }
            try {
                $res = $client->request('POST', '/api/v1/agent/reports', ['reports' => $reports]);
            } catch (\Throwable $e) {
                $log->warn('Outbox flush deferred', ['error' => $e->getMessage()]);
                return;
            }
            foreach ($res['results'] ?? [] as $r) {
                if (empty($r['ok'])) {
                    $log->warn('Core rejected a queued report', ['file' => $names[$r['index']] ?? '?']);
                }
                if (isset($names[$r['index']])) {
                    @unlink($this->dir . '/' . $names[$r['index']]);
                }
            }
        }
    }

    /** @return string[] */
    private function files(): array
    {
        $list = glob($this->dir . '/*.json') ?: [];
        $names = array_map('basename', $list);
        sort($names);
        return $names;
    }
}
