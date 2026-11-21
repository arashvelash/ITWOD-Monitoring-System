import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CoreClient } from '../src/core-client';
import { writeJson } from '../src/fs-utils';
import { createLogger } from '../src/logger';

const log = createLogger('outbox');
const MAX_FILES = 5000;
const BATCH = 100;

export interface Report {
  type: 'backup.report' | 'command.result' | 'heartbeat' | 'metrics' | 'command.ack';
  data: unknown;
}

/**
 * Durable queue for reports that must reach Core (backup results, command
 * results). Reports are written to disk first and deleted only after Core
 * acknowledged them, so nothing is lost while Core is unreachable.
 */
export class OutboxService {
  private flushing: Promise<void> | null = null;

  constructor(
    private readonly dir: string,
    private readonly client: () => CoreClient | null,
  ) {}

  async add(report: Report): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const files = await this.files();
    if (files.length >= MAX_FILES) {
      log.warn('Outbox full, dropping oldest report', { file: files[0] });
      await rm(join(this.dir, files[0]!), { force: true });
    }
    const name = `${Date.now().toString().padStart(15, '0')}-${randomBytes(4).toString('hex')}.json`;
    await writeJson(join(this.dir, name), report);
  }

  async size(): Promise<number> {
    return (await this.files()).length;
  }

  /** Sends queued reports in order; safe to call concurrently. */
  flush(): Promise<void> {
    this.flushing ??= this.doFlush().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    const client = this.client();
    if (!client) return;
    for (;;) {
      const files = (await this.files()).slice(0, BATCH);
      if (!files.length) return;
      const reports: Report[] = [];
      const names: string[] = [];
      for (const f of files) {
        try {
          reports.push(JSON.parse(await readFile(join(this.dir, f), 'utf8')) as Report);
          names.push(f);
        } catch {
          await rm(join(this.dir, f), { force: true });
        }
      }
      if (!reports.length) continue;
      let res: { results: { index: number; ok: boolean }[] };
      try {
        res = await client.request('POST', '/api/v1/agent/reports', { reports });
      } catch (err) {
        log.debug('Outbox flush deferred', { error: (err as Error).message });
        return;
      }
      for (const r of res.results) {
        // Rejected reports can never succeed (validation error); drop them instead of retrying forever.
        if (!r.ok) log.warn('Core rejected a queued report', { file: names[r.index] });
        await rm(join(this.dir, names[r.index]!), { force: true });
      }
    }
  }

  private async files(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return [];
    }
  }
}
