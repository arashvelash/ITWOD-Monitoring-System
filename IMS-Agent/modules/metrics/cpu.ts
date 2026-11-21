import os from 'node:os';

export interface CpuTimes {
  idle: number;
  total: number;
}

/** Aggregated CPU times over all cores (milliseconds since boot). */
export function readCpuTimes(cpus: os.CpuInfo[] = os.cpus()): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** Busy percentage between two snapshots; null when the counters did not advance or were reset. */
export function cpuPercentBetween(prev: CpuTimes, next: CpuTimes): number | null {
  const total = next.total - prev.total;
  const idle = next.idle - prev.idle;
  if (total <= 0 || idle < 0) return null;
  return clampPercent(((total - idle) / total) * 100);
}

export function clampPercent(v: number): number {
  return Math.min(100, Math.max(0, Math.round(v * 10) / 10));
}

/**
 * Keeps the previous snapshot so every sample reports the average usage since
 * the last one (no sleeping inside the collector). The very first call primes
 * the sampler with a short 250 ms window.
 */
export class CpuSampler {
  private prev?: CpuTimes;

  constructor(private readonly read: () => CpuTimes = () => readCpuTimes()) {}

  async sample(): Promise<number | null> {
    if (!this.prev) {
      this.prev = this.read();
      await new Promise((r) => setTimeout(r, 250));
    }
    const next = this.read();
    const pct = cpuPercentBetween(this.prev, next);
    this.prev = next;
    return pct;
  }
}
