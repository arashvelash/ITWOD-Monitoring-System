import { statfs } from 'node:fs/promises';

/** Local block-device filesystems worth monitoring. Network filesystems are skipped: statfs on a hung NFS mount blocks. */
const LOCAL_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'jfs', 'reiserfs', 'vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk']);
const IGNORED_PREFIXES = ['/proc', '/sys', '/dev', '/run', '/snap', '/var/lib/docker', '/var/snap'];
const MAX_DISKS = 32;

export interface MountEntry {
  device: string;
  mount: string;
  fs: string;
}

export interface DiskUsage {
  mount: string;
  fs: string;
  totalBytes: number;
  usedBytes: number;
}

/** `\040` style escapes used by the kernel for spaces, tabs and backslashes. */
function unescapeMount(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/** Parses /proc/mounts, keeping one entry per device (bind mounts are reported once). */
export function parseProcMounts(text: string): MountEntry[] {
  const byDevice = new Map<string, MountEntry>();
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [device, rawMount, fs] = parts;
    const mount = unescapeMount(rawMount);
    if (!LOCAL_FS.has(fs)) continue;
    if (IGNORED_PREFIXES.some((p) => mount === p || mount.startsWith(p + '/'))) continue;
    const existing = byDevice.get(device);
    // Prefer the shortest mount path for a device ("/" over "/var/lib/foo").
    if (!existing || mount.length < existing.mount.length) byDevice.set(device, { device, mount, fs });
  }
  return [...byDevice.values()].sort((a, b) => a.mount.localeCompare(b.mount)).slice(0, MAX_DISKS);
}

export interface StatfsLike {
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
}

/**
 * Usage as `df` reports it: blocks reserved for root count neither as used
 * nor as available, so the percentage matches `df -h` "Use%".
 */
export function usageFromStatfs(mount: string, fs: string, s: StatfsLike): DiskUsage | null {
  const used = (s.blocks - s.bfree) * s.bsize;
  const size = used + s.bavail * s.bsize;
  if (!(size > 0)) return null;
  return { mount, fs, totalBytes: size, usedBytes: Math.max(0, used) };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function collectDisks(mounts: MountEntry[], stat: (path: string) => Promise<StatfsLike> = (p) => statfs(p)): Promise<DiskUsage[]> {
  const results = await Promise.all(
    mounts.map(async (m) => {
      try {
        return usageFromStatfs(m.mount, m.fs, await withTimeout(stat(m.mount), 2_000));
      } catch {
        return null;
      }
    }),
  );
  return results.filter((d): d is DiskUsage => d !== null);
}
