<?php

declare(strict_types=1);

namespace Ims\Agent;

use Ims\Agent\Backup\BackupRunner;

/**
 * One cron cycle of the cPanel agent:
 *   heartbeat + metrics -> config sync -> signed commands -> due backups -> outbox flush
 * Only the allow-listed, non-destructive command set is ever executed.
 */
final class Agent
{
    private const CPANEL_ONLY = 'Automatic updates are not available for the cPanel agent; upload the new release manually (see UPDATE.md)';

    /** @var Config */
    private $config;
    /** @var Logger */
    private $log;
    /** @var array<string,string|null> */
    private $identity;
    /** @var CoreClient */
    private $client;
    /** @var Outbox */
    private $outbox;

    public function __construct(Config $config, Logger $log, array $identity)
    {
        $this->config = $config;
        $this->log = $log;
        $this->identity = $identity;
        $this->client = new CoreClient($identity);
        $this->outbox = new Outbox($config->statePath('outbox'));
    }

    public function runCycle(): void
    {
        $started = time();
        $cache = $this->loadConfigCache();

        // 1. Heartbeat + metrics (also tells us the current config version).
        $remoteVersion = null;
        try {
            $res = $this->client->request('POST', '/api/v1/agent/reports', ['reports' => [
                ['type' => 'heartbeat', 'data' => $this->heartbeat()],
                ['type' => 'metrics', 'data' => Metrics::collect($this->backupDir($cache))],
            ]]);
            $remoteVersion = isset($res['configVersion']) ? (int) $res['configVersion'] : null;
        } catch (\Throwable $e) {
            $this->log->warn('Core unreachable, continuing offline', ['error' => $e->getMessage()]);
        }

        // 2. Configuration.
        if ($remoteVersion !== null && $remoteVersion !== (int) ($cache['configVersion'] ?? -1)) {
            $cache = $this->refreshConfig() ?? $cache;
        }

        // 3. Commands.
        if ($remoteVersion !== null) {
            $cache = $this->processCommands($cache);
        }

        // 4. Scheduled backups.
        $runner = new BackupRunner($this->config, $this->log, $this->outbox, $this->identity);
        $runner->runDue($cache, $started);

        // 5. Deliver queued reports.
        $this->outbox->flush($this->client, $this->log);
    }

    /** @return array<string,mixed> */
    private function heartbeat(): array
    {
        return [
            'agentVersion' => IMS_AGENT_VERSION,
            'hostname' => substr((string) (gethostname() ?: 'shared-host'), 0, 255),
            'os' => substr(php_uname('s') . ' ' . php_uname('r') . ' (PHP ' . PHP_VERSION . ')', 0, 255),
            'arch' => substr(php_uname('m'), 0, 32),
        ];
    }

    /** @return array<string,mixed> */
    private function loadConfigCache(): array
    {
        $cache = Fs::readJson($this->config->statePath('config-cache.json'), []);
        return is_array($cache) ? $cache : [];
    }

    /** @return array<string,mixed>|null */
    private function refreshConfig(): ?array
    {
        try {
            $cfg = $this->client->request('GET', '/api/v1/agent/config');
            if (!isset($cfg['configVersion'], $cfg['jobs']) || !is_array($cfg['jobs'])) {
                throw new \RuntimeException('Invalid configuration received');
            }
            if (!empty($cfg['secrets'])) {
                Protocol::openConfigSecrets((string) $this->identity['nodeSecret'], $cfg['secrets']);
            }
            Fs::writeJson($this->config->statePath('config-cache.json'), $cfg);
            $this->log->info('Configuration updated', ['configVersion' => $cfg['configVersion'], 'jobs' => count($cfg['jobs'])]);
            return $cfg;
        } catch (\Throwable $e) {
            $this->log->warn('Configuration refresh failed', ['error' => $e->getMessage()]);
            return null;
        }
    }

    /**
     * @param array<string,mixed> $cache
     * @return array<string,mixed>
     */
    private function processCommands(array $cache): array
    {
        try {
            $res = $this->client->request('GET', '/api/v1/agent/commands');
        } catch (\Throwable $e) {
            $this->log->warn('Cannot fetch commands', ['error' => $e->getMessage()]);
            return $cache;
        }
        $executedFile = $this->config->statePath('executed-commands.json');
        $executed = Fs::readJson($executedFile, []);
        $executed = is_array($executed) ? array_filter($executed, static function ($t) {
            return $t > time() - 86400;
        }) : [];

        foreach ($res['commands'] ?? [] as $cmd) {
            if (!is_array($cmd)) {
                continue;
            }
            $check = Protocol::verifyCommand((string) $this->identity['nodeSecret'], $cmd);
            if (!$check['ok']) {
                $this->log->warn('Rejected command', ['reason' => $check['reason']]);
                if (!in_array($check['reason'], ['invalid signature', 'malformed signature', 'malformed command'], true)) {
                    $this->outbox->add('command.result', ['commandId' => $cmd['id'], 'status' => 'FAILED', 'error' => 'Rejected by agent: ' . $check['reason']]);
                }
                continue;
            }
            if (isset($executed[$cmd['id']])) {
                continue;
            }
            $executed[$cmd['id']] = time();
            Fs::writeJson($executedFile, $executed);
            $this->outbox->add('command.ack', ['commandId' => $cmd['id']]);
            $this->log->info('Executing command', ['id' => $cmd['id'], 'type' => $check['type']]);

            try {
                $result = $this->execute((string) $check['type'], (array) $check['payload'], $cache);
                $this->outbox->add('command.result', ['commandId' => $cmd['id'], 'status' => 'SUCCEEDED', 'result' => $result]);
            } catch (\Throwable $e) {
                $this->outbox->add('command.result', ['commandId' => $cmd['id'], 'status' => 'FAILED', 'error' => substr($e->getMessage(), 0, 2000)]);
            }
        }
        return $cache;
    }

    /**
     * @param array<string,mixed> $payload
     * @param array<string,mixed> $cache passed by reference so config.sync refreshes it
     * @return array<string,mixed>
     */
    private function execute(string $type, array $payload, array &$cache): array
    {
        switch ($type) {
            case 'ping':
                return ['status' => 'ok', 'version' => IMS_AGENT_VERSION, 'php' => PHP_VERSION];
            case 'config.sync':
                $cache = $this->refreshConfig() ?? $cache;
                return ['configVersion' => $cache['configVersion'] ?? null];
            case 'monitor.collect':
                $this->outbox->add('metrics', Metrics::collect($this->backupDir($cache)));
                return ['sent' => true];
            case 'backup.run':
                $cache = $this->refreshConfig() ?? $cache;
                $jobId = (string) ($payload['jobId'] ?? '');
                $runId = (string) ($payload['runId'] ?? '');
                if (!preg_match('/^[0-9a-f-]{36}$/', $jobId) || !preg_match('/^[0-9a-f-]{36}$/', $runId)) {
                    throw new \InvalidArgumentException('Invalid job or run id');
                }
                $trigger = ($payload['trigger'] ?? '') === 'TELEGRAM' ? 'TELEGRAM' : 'MANUAL';
                $runner = new BackupRunner($this->config, $this->log, $this->outbox, $this->identity);
                $status = $runner->runJobById($cache, $jobId, $runId, $trigger);
                return ['runId' => $runId, 'status' => $status];
            case 'agent.update':
                throw new \RuntimeException(self::CPANEL_ONLY);
            default:
                throw new \RuntimeException('Unsupported command');
        }
    }

    /** @param array<string,mixed> $cache */
    private function backupDir(array $cache): string
    {
        $dir = (string) ($cache['backup']['localDirectory'] ?? '');
        if ($dir === '' || $dir[0] === '~') {
            return $this->config->defaultBackupDir;
        }
        return $dir;
    }
}
