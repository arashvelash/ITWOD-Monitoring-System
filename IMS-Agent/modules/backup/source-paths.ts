import { posix } from 'node:path';

/** Same deny-list as Core; enforced again on the agent (defence in depth). */
const DENIED = ['/proc', '/sys', '/dev', '/run', '/var/run', '/lost+found'];

export function assertSafeSourcePath(p: string, backupDir: string): string {
  if (typeof p !== 'string' || !p.startsWith('/') || /[\0\n\r]/.test(p) || p.split('/').includes('..')) {
    throw new Error(`Refusing unsafe source path: ${JSON.stringify(p)}`);
  }
  const n = posix.normalize(p).replace(/\/+$/, '') || '/';
  const backupRoot = posix.normalize(backupDir).replace(/\/+$/, '');
  if (n === '/') throw new Error('Refusing to archive the filesystem root');
  if ([...DENIED, backupRoot].some((d) => n === d || n.startsWith(`${d}/`))) throw new Error(`Refusing to archive ${n}`);
  return n;
}

/**
 * Builds GNU tar arguments. Paths are passed relative to `/` after `--` so no
 * value can ever be interpreted as a tar option.
 */
export function tarArgs(paths: string[], excludes: string[], backupDir: string): string[] {
  const safe = paths.map((p) => assertSafeSourcePath(p, backupDir));
  for (const e of excludes) {
    if (!e || e.startsWith('-') || /[\0\n\r]/.test(e)) throw new Error(`Refusing unsafe exclude pattern: ${JSON.stringify(e)}`);
  }
  return [
    '--create',
    '--file=-',
    '--warning=no-file-changed',
    '--warning=no-file-removed',
    '--ignore-failed-read',
    // Member names are relative to "/", so the exclude must be relative too.
    `--exclude=${backupDir.replace(/^\/+/, '')}`,
    ...excludes.map((e) => `--exclude=${e}`),
    '--directory=/',
    '--',
    ...safe.map((p) => p.slice(1)),
  ];
}
