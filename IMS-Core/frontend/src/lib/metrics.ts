import type { MetricsSnapshot } from './types';

export function memoryPercent(m: MetricsSnapshot | null | undefined): number | null {
  const t = m?.memory?.totalBytes;
  const u = m?.memory?.usedBytes;
  return t && u !== undefined ? (u / t) * 100 : null;
}

export function maxDiskPercent(m: MetricsSnapshot | null | undefined): number | null {
  const disks = m?.disks ?? [];
  if (!disks.length) return null;
  return Math.max(...disks.map((d) => (d.totalBytes ? (d.usedBytes / d.totalBytes) * 100 : 0)));
}

export function diskPercent(d: { totalBytes: number; usedBytes: number }): number {
  return d.totalBytes ? (d.usedBytes / d.totalBytes) * 100 : 0;
}

const UNIT_MS: Record<string, number> = { second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000 };

/** Parses Postgres-style interval strings returned by the API ("5 minutes", "2 hours"). */
export function bucketMs(bucket: string): number {
  const m = /^(\d+)\s+(second|minute|hour|day)s?$/.exec(bucket.trim());
  return m ? Number(m[1]) * UNIT_MS[m[2]!]! : 60_000;
}

/**
 * Inserts empty points where the agent did not report for more than two
 * buckets, so charts show an honest gap instead of interpolating across an outage.
 */
export function withGaps<T extends { collectedAt: string }>(points: T[], bucket: number, empty: (at: string) => T): T[] {
  const out: T[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (i > 0) {
      const prev = new Date(points[i - 1]!.collectedAt).getTime();
      const cur = new Date(p.collectedAt).getTime();
      if (cur - prev > bucket * 2) out.push(empty(new Date(prev + bucket).toISOString()));
    }
    out.push(p);
  }
  return out;
}

export function formatRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec === null || bytesPerSec === undefined) return '—';
  const bits = bytesPerSec * 8;
  if (bits < 1_000) return `${bits.toFixed(0)} bit/s`;
  if (bits < 1_000_000) return `${(bits / 1_000).toFixed(1)} kbit/s`;
  if (bits < 1_000_000_000) return `${(bits / 1_000_000).toFixed(1)} Mbit/s`;
  return `${(bits / 1_000_000_000).toFixed(2)} Gbit/s`;
}

export function toneFor(percent: number | null, warn = 75, crit = 90): 'success' | 'warning' | 'destructive' | 'default' {
  if (percent === null) return 'default';
  if (percent >= crit) return 'destructive';
  if (percent >= warn) return 'warning';
  return 'success';
}
