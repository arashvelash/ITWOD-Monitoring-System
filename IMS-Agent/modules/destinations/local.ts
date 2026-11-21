import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { archivePattern } from '../backup/naming';
import type { Destination, DestinationUpload, StoredArchive } from './types';

const GiB = 1024 ** 3;

export interface FreeSpace {
  freeBytes: number;
  totalBytes: number;
}

export async function freeSpace(path: string): Promise<FreeSpace> {
  const s = await statfs(path);
  return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
}

/** Minimum free space that must remain on the volume so a backup can never fill a production disk. */
export function minimumFreeBytes(totalBytes: number): number {
  return Math.max(1 * GiB, Math.floor(totalBytes * 0.05));
}

/**
 * Stores archives under <backupDir>/<jobId>/. Writes go to a ".partial" file
 * that is renamed on success, so incomplete archives are never mistaken for
 * valid ones.
 */
export class LocalDestination implements Destination {
  readonly dir: string;

  constructor(
    backupDir: string,
    jobId: string,
    private readonly slug: string,
  ) {
    if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new Error('Invalid job id');
    this.dir = join(backupDir, jobId);
  }

  describe(): string {
    return `local:${this.dir}`;
  }

  async preflight(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o750 });
    const { freeBytes, totalBytes } = await freeSpace(this.dir);
    if (freeBytes < minimumFreeBytes(totalBytes)) {
      throw new Error(`Not enough free disk space for a local backup (${Math.round(freeBytes / 1024 ** 2)} MiB free)`);
    }
  }

  async open(name: string): Promise<DestinationUpload> {
    const final = this.safePath(name);
    const partial = `${final}.partial`;
    const stream = createWriteStream(partial, { mode: 0o600 });
    return {
      stream,
      commit: async () => {
        await rename(partial, final);
        return `local:${final}`;
      },
      abort: async () => {
        stream.destroy();
        await rm(partial, { force: true });
      },
    };
  }

  async list(): Promise<StoredArchive[]> {
    const pattern = archivePattern(this.slug);
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: StoredArchive[] = [];
    for (const name of names.filter((n) => pattern.test(n))) {
      const s = await stat(join(this.dir, name)).catch(() => null);
      if (s?.isFile()) out.push({ name, sizeBytes: s.size });
    }
    return out;
  }

  async remove(name: string): Promise<void> {
    await rm(this.safePath(name), { force: true });
  }

  /** Resolves a file name inside the job directory and refuses anything else. */
  private safePath(name: string): string {
    if (!archivePattern(this.slug).test(name)) throw new Error(`Refusing to touch non-IMS file ${name}`);
    const p = resolve(this.dir, name);
    if (!p.startsWith(resolve(this.dir) + sep)) throw new Error('Path escapes the backup directory');
    return p;
  }
}
