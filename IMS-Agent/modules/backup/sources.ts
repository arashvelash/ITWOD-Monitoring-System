import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { JobConfig, JobSecrets } from '../../services/config.service';
import type { ArchiveKind } from './naming';
import { tarArgs } from './source-paths';

export interface BackupSource {
  kind: ArchiveKind;
  /** Uncompressed archive / dump stream. */
  stream: Readable;
  /** Resolves when the producer exited successfully; rejects otherwise. */
  done: Promise<void>;
  /** Last lines of stderr (diagnostics for the run log). */
  stderrTail(): string;
  kill(): void;
  cleanup(): Promise<void>;
}

const MAX_STDERR = 8 * 1024;

/** Tracks a producer process: exit status and the tail of its stderr. */
function watch(child: ChildProcess, okExitCodes: number[], name: string, cleanup: () => Promise<void>): { done: Promise<void>; tail: () => string } {
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString('utf8')).slice(-MAX_STDERR);
  });
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (err) => reject(new Error(`${name} could not be started: ${err.message}`)));
    child.on('close', (code, signal) => {
      void cleanup();
      if (signal) return reject(new Error(`${name} was terminated (${signal})`));
      if (code !== null && okExitCodes.includes(code)) return resolve();
      reject(new Error(`${name} exited with code ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
  // Avoid unhandled rejections if the pipeline fails first.
  done.catch(() => undefined);
  return { done, tail: () => stderr };
}

const SAFE_ENV = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };

/** GNU tar exit code 1 means "some files changed while being read" – the archive is still valid. */
function filesSource(job: JobConfig, backupDir: string): BackupSource {
  const args = tarArgs(job.source.paths ?? [], job.source.excludes ?? [], backupDir);
  const child = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'], env: SAFE_ENV });
  const w = watch(child, [0, 1], 'tar', async () => undefined);
  return { kind: 'tar.gz', stream: child.stdout!, done: w.done, stderrTail: w.tail, kill: () => child.kill('SIGTERM'), cleanup: async () => undefined };
}

async function mysqlSource(job: JobConfig, secrets: JobSecrets): Promise<BackupSource> {
  const s = job.source;
  // Credentials go into a private option file, never into argv (visible in `ps`).
  const optionFile = join(tmpdir(), `ims-my-${randomBytes(8).toString('hex')}.cnf`);
  const quote = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const lines = ['[client]', `user=${quote(s.username ?? '')}`, `host=${quote(s.host ?? 'localhost')}`];
  if (s.port) lines.push(`port=${s.port}`);
  if (secrets.dbPassword) lines.push(`password=${quote(secrets.dbPassword)}`);
  await writeFile(optionFile, lines.join('\n') + '\n', { mode: 0o600 });
  const cleanup = () => rm(optionFile, { force: true });
  const args = [`--defaults-extra-file=${optionFile}`, '--single-transaction', '--quick', '--routines', '--triggers', '--events', '--hex-blob', '--no-tablespaces', '--default-character-set=utf8mb4', '--', s.database ?? ''];
  const child = spawn('mysqldump', args, { stdio: ['ignore', 'pipe', 'pipe'], env: SAFE_ENV });
  const w = watch(child, [0], 'mysqldump', cleanup);
  return { kind: 'sql.gz', stream: child.stdout!, done: w.done, stderrTail: w.tail, kill: () => child.kill('SIGTERM'), cleanup };
}

function postgresSource(job: JobConfig, secrets: JobSecrets): BackupSource {
  const s = job.source;
  const args = [`--host=${s.host ?? 'localhost'}`, `--port=${s.port ?? 5432}`, `--username=${s.username ?? ''}`, '--no-password', '--format=plain', '--no-owner', `--dbname=${s.database ?? ''}`];
  const child = spawn('pg_dump', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...SAFE_ENV, ...(secrets.dbPassword ? { PGPASSWORD: secrets.dbPassword } : {}) } });
  const w = watch(child, [0], 'pg_dump', async () => undefined);
  return { kind: 'sql.gz', stream: child.stdout!, done: w.done, stderrTail: w.tail, kill: () => child.kill('SIGTERM'), cleanup: async () => undefined };
}

export async function openSource(job: JobConfig, secrets: JobSecrets, backupDir: string): Promise<BackupSource> {
  switch (job.type) {
    case 'FILES':
      return filesSource(job, backupDir);
    case 'MYSQL':
      return mysqlSource(job, secrets);
    case 'POSTGRES':
      return postgresSource(job, secrets);
    default:
      throw new Error(`Unsupported backup type ${(job as JobConfig).type}`);
  }
}
