<?php

declare(strict_types=1);

namespace Ims\Agent\Backup;

use Ims\Agent\Config;
use Ims\Agent\Fs;
use Ims\Agent\Logger;
use Ims\Agent\Outbox;
use Ims\Agent\Protocol;

/**
 * Evaluates schedules on each cron cycle and executes backups:
 *   dump / archive -> (encrypt) -> checksum -> store -> retention -> report
 * Reports are queued in the outbox so results survive network outages.
 */
final class BackupRunner
{
    /** Scheduled slots older than this are skipped instead of caught up. */
    private const CATCH_UP_SECONDS = 3600;

    /** @var Config */
    private $config;
    /** @var Logger */
    private $log;
    /** @var Outbox */
    private $outbox;
    /** @var array<string,string|null> */
    private $identity;

    public function __construct(Config $config, Logger $log, Outbox $outbox, array $identity)
    {
        $this->config = $config;
        $this->log = $log;
        $this->outbox = $outbox;
        $this->identity = $identity;
    }

    /** @param array<string,mixed> $cache */
    public function runDue(array $cache, int $now): void
    {
        $stateFile = $this->config->statePath('schedule-state.json');
        $state = Fs::readJson($stateFile, []);
        $state = is_array($state) ? $state : [];
        $nowDt = new \DateTimeImmutable('@' . $now);
        $due = [];

        foreach ($cache['jobs'] ?? [] as $job) {
            if (!is_array($job) || empty($job['enabled']) || empty($job['id'])) {
                continue;
            }
            $id = (string) $job['id'];
            if (!isset($state[$id])) {
                $state[$id] = $now; // first sight: no back-fill
                continue;
            }
            try {
                $cron = new CronExpression((string) $job['schedule']);
                $slot = $cron->latestSlot(new \DateTimeImmutable('@' . (int) $state[$id]), $nowDt, (string) ($job['timezone'] ?? 'UTC'));
            } catch (\Throwable $e) {
                $this->log->warn('Invalid schedule', ['job' => $job['name'] ?? $id, 'error' => $e->getMessage()]);
                continue;
            }
            if ($slot === null) {
                continue;
            }
            $state[$id] = $slot->getTimestamp();
            if ($now - $slot->getTimestamp() > self::CATCH_UP_SECONDS) {
                $this->log->warn('Skipping a missed slot older than the catch-up window', ['job' => $job['name'] ?? $id]);
                continue;
            }
            $due[] = $job;
        }
        $known = array_flip(array_map(static function ($j) {
            return (string) ($j['id'] ?? '');
        }, $cache['jobs'] ?? []));
        $state = array_intersect_key($state, $known);
        Fs::writeJson($stateFile, $state);

        foreach ($due as $job) {
            $this->execute($cache, $job, self::uuid(), 'SCHEDULED');
        }
    }

    /** @param array<string,mixed> $cache */
    public function runJobById(array $cache, string $jobId, string $runId, string $trigger): string
    {
        foreach ($cache['jobs'] ?? [] as $job) {
            if (($job['id'] ?? '') === $jobId) {
                return $this->execute($cache, $job, $runId, $trigger);
            }
        }
        throw new \RuntimeException('Unknown backup job');
    }

    /**
     * @param array<string,mixed> $cache
     * @param array<string,mixed> $job
     */
    private function execute(array $cache, array $job, string $runId, string $trigger): string
    {
        $started = time();
        $base = ['runId' => $runId, 'jobId' => $job['id'], 'trigger' => $trigger, 'startedAt' => gmdate('Y-m-d\TH:i:s\Z', $started)];
        $this->outbox->add('backup.report', $base + ['status' => 'RUNNING']);
        $this->log->info('Backup started', ['job' => $job['name'], 'runId' => $runId]);
        $tmpFiles = [];
        $notes = [];

        try {
            $secrets = $this->secretsFor($cache, (string) $job['id']);
            $encrypted = !empty($job['encryption']['enabled']);
            if ($encrypted && empty($secrets['encryptionKey'])) {
                throw new \RuntimeException('Encryption is enabled but no key was provided by Core');
            }
            $backupDir = $this->config->defaultBackupDir;
            $local = new LocalDestination($backupDir, (string) $job['id'], (string) $job['slug']);
            $local->prepare();
            $this->checkFreeSpace($local->workDir());
            $destination = ($job['destination']['type'] ?? 'LOCAL') === 'S3'
                ? new S3Destination([
                    'bucket' => $job['destination']['bucket'] ?? '',
                    'region' => $job['destination']['region'] ?? 'us-east-1',
                    'endpoint' => $job['destination']['endpoint'] ?? null,
                    'prefix' => $job['destination']['prefix'] ?? '',
                    'forcePathStyle' => $job['destination']['forcePathStyle'] ?? false,
                    'accessKeyId' => $secrets['s3AccessKeyId'] ?? '',
                    'secretAccessKey' => $secrets['s3SecretAccessKey'] ?? '',
                ], (string) $job['slug'])
                : $local;
            $destination->prepare();

            $kind = $job['type'] === 'FILES' ? 'tar.gz' : 'sql.gz';
            $name = Naming::archiveName((string) $job['slug'], $kind, $encrypted, new \DateTimeImmutable('@' . $started));
            $plain = $local->workDir() . '/.' . $runId . '.' . $kind . '.partial';
            $tmpFiles[] = $plain;
            $level = (int) ($job['compressionLevel'] ?? 6);

            if ($job['type'] === 'FILES') {
                $home = getenv('HOME') ?: dirname(IMS_AGENT_ROOT);
                $stats = FileArchiver::create((array) ($job['source']['paths'] ?? []), (array) ($job['source']['excludes'] ?? []), $home, [IMS_AGENT_ROOT, $backupDir], $plain, $level);
                $notes[] = "files: {$stats['files']}, bytes: {$stats['bytes']}, unreadable skipped: {$stats['skipped']}";
            } elseif ($job['type'] === 'MYSQL') {
                $s = $job['source'];
                $stats = MysqlDumper::dump((string) ($s['host'] ?? 'localhost'), (int) ($s['port'] ?? 3306), (string) $s['database'], (string) $s['username'], (string) ($secrets['dbPassword'] ?? ''), $plain, $level);
                $notes[] = "tables: {$stats['tables']}, rows: {$stats['rows']}";
            } else {
                throw new \RuntimeException('PostgreSQL backups are not supported on shared hosting');
            }

            $final = $plain;
            if ($encrypted) {
                $final = $local->workDir() . '/.' . $runId . '.enc.partial';
                $tmpFiles[] = $final;
                ArchiveEncryptor::encryptFile($plain, $final, (string) $secrets['encryptionKey']);
                @unlink($plain);
            }
            $size = (int) filesize($final);
            $sha = (string) hash_file('sha256', $final);
            $location = $destination->store($final, $name);

            $removed = Retention::selectForDeletion((string) $job['slug'], $destination->list(), (int) ($job['retention']['count'] ?? 7), isset($job['retention']['days']) ? (int) $job['retention']['days'] : null, time());
            foreach ($removed as $old) {
                $destination->remove($old);
            }
            if ($removed) {
                $notes[] = 'retention: removed ' . count($removed) . ' old archive(s)';
            }

            $this->outbox->add('backup.report', $base + [
                'status' => 'SUCCESS',
                'finishedAt' => gmdate('Y-m-d\TH:i:s\Z'),
                'sizeBytes' => $size,
                'checksumSha256' => $sha,
                'fileName' => $name,
                'location' => $location,
                'encrypted' => $encrypted,
                'logTail' => substr(implode("\n", $notes), -8000),
            ]);
            $this->log->info('Backup finished', ['job' => $job['name'], 'runId' => $runId, 'size' => $size]);
            return 'SUCCESS';
        } catch (\Throwable $e) {
            $this->log->error('Backup failed', ['job' => $job['name'] ?? '', 'runId' => $runId, 'error' => $e->getMessage()]);
            $this->outbox->add('backup.report', $base + [
                'status' => 'FAILED',
                'finishedAt' => gmdate('Y-m-d\TH:i:s\Z'),
                'error' => substr($e->getMessage(), 0, 2000),
                'logTail' => substr(implode("\n", $notes), -8000),
            ]);
            return 'FAILED';
        } finally {
            foreach ($tmpFiles as $f) {
                if (is_file($f)) {
                    @unlink($f);
                }
            }
        }
    }

    /**
     * @param array<string,mixed> $cache
     * @return array<string,string>
     */
    private function secretsFor(array $cache, string $jobId): array
    {
        if (empty($cache['secrets'])) {
            return [];
        }
        $all = Protocol::openConfigSecrets((string) $this->identity['nodeSecret'], $cache['secrets']);
        return isset($all[$jobId]) && is_array($all[$jobId]) ? $all[$jobId] : [];
    }

    private function checkFreeSpace(string $dir): void
    {
        $free = @disk_free_space($dir);
        if ($free !== false && $free < 512 * 1024 * 1024) {
            throw new \RuntimeException('Not enough free disk space for a backup (less than 512 MiB)');
        }
    }

    private static function uuid(): string
    {
        $b = random_bytes(16);
        $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
        $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
    }
}
