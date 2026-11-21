import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { BackupService, type BackupReportData } from '../services/backup.service';
import type { ConfigService, JobConfig } from '../services/config.service';
import { ArchiveDecryptor } from '../modules/crypto/archive-encryption';
import type { BackupSource } from '../modules/backup/sources';
import { tempPaths } from './helpers';
import { pipeline } from 'node:stream/promises';

const JOB_ID = '11111111-2222-4333-8444-555555555555';
const KEY = randomBytes(32).toString('base64');

function job(over: Partial<JobConfig> = {}): JobConfig {
  return {
    id: JOB_ID,
    name: 'Site files',
    slug: 'site-files',
    type: 'FILES',
    enabled: true,
    schedule: '0 3 * * *',
    timezone: 'UTC',
    timeoutMinutes: 5,
    compressionLevel: 6,
    source: { paths: ['/var/www'] },
    destination: { type: 'LOCAL' },
    retention: { count: 2, days: null },
    encryption: { enabled: true },
    ...over,
  };
}

function fakeSource(payload: Buffer, fail = false): () => Promise<BackupSource> {
  return async () => {
    // Mirrors sources.ts: the exit promise always has a handler attached.
    const done = fail ? Promise.reject(new Error('tar exited with code 2: boom')) : Promise.resolve();
    done.catch(() => undefined);
    return {
    kind: 'tar.gz',
    stream: Readable.from([payload]),
    done,
    stderrTail: () => (fail ? 'tar: fatal error' : ''),
    kill: () => undefined,
    cleanup: async () => undefined,
    } as BackupSource;
  };
}

function setup(sourceFactory: () => Promise<BackupSource>) {
  const { paths } = tempPaths();
  const reports: BackupReportData[] = [];
  const config = { secretsFor: () => ({ encryptionKey: KEY }) } as unknown as ConfigService;
  const svc = new BackupService(config, paths, async (d) => void reports.push(d), sourceFactory as never);
  return { svc, reports, dir: join(paths.backupDir, JOB_ID) };
}

async function decrypt(buf: Buffer): Promise<Buffer> {
  const out: Buffer[] = [];
  await pipeline(Readable.from([buf]), new ArchiveDecryptor(Buffer.from(KEY, 'base64')), async function* (s) {
    for await (const c of s) out.push(c as Buffer);
  });
  return Buffer.concat(out);
}

describe('BackupService', () => {
  it('writes an encrypted, compressed archive and reports RUNNING then SUCCESS', async () => {
    const payload = randomBytes(200_000);
    const { svc, reports, dir } = setup(fakeSource(payload));
    const status = await svc.run(job(), { runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', trigger: 'MANUAL' });
    expect(status).toBe('SUCCESS');
    expect(reports.map((r) => r.status)).toEqual(['RUNNING', 'SUCCESS']);
    const done = reports[1]!;
    expect(done.fileName).toMatch(/^ims-site-files-\d{8}T\d{6}Z\.tar\.gz\.enc$/);
    expect(done.location).toContain(done.fileName);
    expect(done.checksumSha256).toMatch(/^[0-9a-f]{64}$/);

    const files = readdirSync(dir);
    expect(files).toEqual([done.fileName]);
    const stored = readFileSync(join(dir, done.fileName!));
    expect(stored.length).toBe(done.sizeBytes);
    expect(gunzipSync(await decrypt(stored))).toEqual(payload);
  });

  it('fails cleanly when the producer fails and leaves no partial files', async () => {
    const { svc, reports, dir } = setup(fakeSource(Buffer.from('partial data'), true));
    const status = await svc.run(job(), { runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', trigger: 'MANUAL' });
    expect(status).toBe('FAILED');
    expect(reports.at(-1)).toMatchObject({ status: 'FAILED', error: expect.stringContaining('tar exited') });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses to run without the encryption key', async () => {
    const { paths } = tempPaths();
    const reports: BackupReportData[] = [];
    const svc = new BackupService({ secretsFor: () => ({}) } as unknown as ConfigService, paths, async (d) => void reports.push(d), fakeSource(Buffer.from('x')) as never);
    expect(await svc.run(job(), { runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', trigger: 'MANUAL' })).toBe('FAILED');
    expect(reports.at(-1)?.error).toMatch(/no key/);
  });

  it('applies retention to its own archives only', async () => {
    const { svc, dir } = setup(fakeSource(Buffer.from('data')));
    for (let i = 0; i < 3; i++) {
      await svc.run(job(), { runId: `dddddddd-dddd-4ddd-8ddd-00000000000${i}`, trigger: 'MANUAL' });
      await new Promise((r) => setTimeout(r, 1100)); // archive names have second resolution
    }
    expect(readdirSync(dir)).toHaveLength(2);
  }, 20_000);
});
