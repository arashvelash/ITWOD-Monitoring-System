import { randomUUID } from 'node:crypto';
import { archiveName } from '../modules/backup/naming';
import { runPipeline } from '../modules/backup/pipeline';
import { selectForDeletion } from '../modules/backup/retention';
import { openSource, type BackupSource } from '../modules/backup/sources';
import { parseKey } from '../modules/crypto/archive-encryption';
import { freeSpace, LocalDestination } from '../modules/destinations/local';
import { S3Destination } from '../modules/destinations/s3';
import type { Destination } from '../modules/destinations/types';
import { createLogger } from '../src/logger';
import type { AgentPaths } from '../src/paths';
import type { ConfigService, JobConfig, JobSecrets } from './config.service';

const log = createLogger('backup');
const MIN_FREE_DURING_WRITE = 512 * 1024 ** 2;

export type Trigger = 'SCHEDULED' | 'MANUAL' | 'TELEGRAM';

export interface BackupReportData {
  runId: string;
  jobId: string;
  trigger: Trigger;
  status: 'RUNNING' | 'SUCCESS' | 'FAILED';
  startedAt: string;
  finishedAt?: string;
  sizeBytes?: number;
  checksumSha256?: string;
  fileName?: string;
  location?: string;
  encrypted?: boolean;
  error?: string;
  logTail?: string;
}

export function createDestination(job: JobConfig, secrets: JobSecrets, backupDir: string): Destination {
  if (job.destination.type === 'S3') {
    return new S3Destination(
      {
        bucket: job.destination.bucket ?? '',
        region: job.destination.region,
        endpoint: job.destination.endpoint,
        prefix: job.destination.prefix,
        forcePathStyle: job.destination.forcePathStyle,
        accessKeyId: secrets.s3AccessKeyId ?? '',
        secretAccessKey: secrets.s3SecretAccessKey ?? '',
      },
      job.slug,
    );
  }
  return new LocalDestination(backupDir, job.id, job.slug);
}

/**
 * Executes backup jobs one at a time (predictable, low resource usage) and
 * reports every run to Core through the durable outbox.
 */
export class BackupService {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly active = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    private readonly paths: AgentPaths,
    private readonly report: (data: BackupReportData) => Promise<void>,
    private readonly sourceFactory: typeof openSource = openSource,
  ) {}

  runScheduled(job: JobConfig, scheduledFor: Date): Promise<'SUCCESS' | 'FAILED' | 'SKIPPED'> {
    log.info('Scheduled backup due', { job: job.name, scheduledFor: scheduledFor.toISOString() });
    return this.run(job, { runId: randomUUID(), trigger: 'SCHEDULED' });
  }

  async run(job: JobConfig, opts: { runId: string; trigger: Trigger }): Promise<'SUCCESS' | 'FAILED' | 'SKIPPED'> {
    if (this.active.has(job.id)) {
      log.warn('Backup already queued or running, skipping', { job: job.name });
      if (opts.trigger !== 'SCHEDULED') {
        const now = new Date().toISOString();
        await this.report({ runId: opts.runId, jobId: job.id, trigger: opts.trigger, status: 'FAILED', startedAt: now, finishedAt: now, error: 'Another run of this job is already in progress' });
      }
      return 'SKIPPED';
    }
    this.active.add(job.id);
    const result = this.chain.then(() => this.execute(job, opts.runId, opts.trigger)).finally(() => this.active.delete(job.id));
    this.chain = result.catch(() => undefined);
    return result;
  }

  async waitForIdle(timeoutMs: number): Promise<void> {
    await Promise.race([this.chain, new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  private async execute(job: JobConfig, runId: string, trigger: Trigger): Promise<'SUCCESS' | 'FAILED'> {
    const started = new Date();
    const base = { runId, jobId: job.id, trigger, startedAt: started.toISOString() };
    const notes: string[] = [];
    await this.report({ ...base, status: 'RUNNING' });
    log.info('Backup started', { job: job.name, runId, type: job.type });

    let source: BackupSource | undefined;
    let upload: Awaited<ReturnType<Destination['open']>> | undefined;
    let destination: Destination | undefined;
    let fileName: string | undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`Backup exceeded the ${job.timeoutMinutes} minute timeout`)), job.timeoutMinutes * 60_000);
    let diskWatch: NodeJS.Timeout | undefined;

    try {
      const secrets = this.config.secretsFor(job.id);
      const encrypted = job.encryption.enabled;
      if (encrypted && !secrets.encryptionKey) throw new Error('Encryption is enabled but no key was provided by Core');
      destination = createDestination(job, secrets, this.paths.backupDir);
      await destination.preflight();

      if (destination instanceof LocalDestination) {
        const dir = destination.dir;
        diskWatch = setInterval(() => {
          void freeSpace(dir).then(({ freeBytes }) => {
            if (freeBytes < MIN_FREE_DURING_WRITE) controller.abort(new Error('Aborted: free disk space dropped below 512 MiB'));
          });
        }, 15_000);
        diskWatch.unref();
      }

      source = await this.sourceFactory(job, secrets, this.paths.backupDir);
      fileName = archiveName(job.slug, source.kind, encrypted, started);
      upload = await destination.open(fileName);
      const result = await runPipeline(source.stream, upload.stream, {
        compressionLevel: job.compressionLevel,
        encryptionKey: encrypted ? parseKey(secrets.encryptionKey!) : undefined,
        signal: controller.signal,
      });
      await source.done;
      const location = await upload.commit();
      upload = undefined;

      notes.push(...(await this.applyRetention(job, destination)));
      const tail = [source.stderrTail().trim(), ...notes].filter(Boolean).join('\n').slice(-8000);
      await this.report({ ...base, status: 'SUCCESS', finishedAt: new Date().toISOString(), sizeBytes: result.sizeBytes, checksumSha256: result.sha256, fileName, location, encrypted, ...(tail ? { logTail: tail } : {}) });
      log.info('Backup finished', { job: job.name, runId, sizeBytes: result.sizeBytes });
      return 'SUCCESS';
    } catch (err) {
      const reason = controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason.message : (err as Error).message;
      source?.kill();
      await upload?.abort().catch(() => undefined);
      // A remote object may already be complete if the producer failed at the very end.
      // The name is unique to this run, so removing it can never touch another archive.
      if (destination && fileName) await destination.remove(fileName).catch(() => undefined);
      const tail = [source?.stderrTail().trim(), ...notes].filter(Boolean).join('\n').slice(-8000);
      log.error('Backup failed', { job: job.name, runId, error: reason });
      await this.report({ ...base, status: 'FAILED', finishedAt: new Date().toISOString(), error: reason.slice(0, 2000), ...(tail ? { logTail: tail } : {}) });
      return 'FAILED';
    } finally {
      clearTimeout(timeout);
      clearInterval(diskWatch);
      await source?.cleanup().catch(() => undefined);
    }
  }

  /** Removes only this job's own expired IMS archives. Failures never fail the backup. */
  private async applyRetention(job: JobConfig, destination: Destination): Promise<string[]> {
    try {
      const entries = await destination.list();
      const doomed = selectForDeletion(job.slug, entries, { count: job.retention.count, days: job.retention.days });
      for (const e of doomed) await destination.remove(e.name);
      return doomed.length ? [`retention: removed ${doomed.length} old archive(s): ${doomed.map((d) => d.name).join(', ')}`] : [];
    } catch (err) {
      log.warn('Retention failed', { job: job.name, error: (err as Error).message });
      return [`retention skipped: ${(err as Error).message}`];
    }
  }
}
