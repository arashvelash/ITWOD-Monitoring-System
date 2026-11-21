import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { CpuSampler } from './cpu';
import { collectDisks, parseProcMounts, type StatfsLike } from './disk';
import { osMemory, parseMeminfo } from './memory';
import { netRate, parseNetDev, type NetCounters } from './network';
import { checkServices, type ExecFileFn } from './services';

/** Metrics sample sent to Core (docs/PROTOCOL.md §6). */
export interface MetricsSample {
  collectedAt: string;
  cpu?: { percent?: number; cores?: number; load?: number[] };
  memory?: { totalBytes: number; usedBytes: number; availableBytes: number };
  swap?: { totalBytes: number; usedBytes: number };
  disks?: { mount: string; fs: string; totalBytes: number; usedBytes: number }[];
  network?: { rxBytesPerSec: number; txBytesPerSec: number };
  uptimeSec?: number;
  services?: { name: string; active: boolean; state: string }[];
}

export interface CollectorDeps {
  readText?: (path: string) => Promise<string>;
  statfs?: (path: string) => Promise<StatfsLike>;
  exec?: ExecFileFn;
  cpu?: CpuSampler;
  now?: () => number;
}

/**
 * Collects one sample from /proc, statfs and systemd. Every section is
 * best-effort: a failing source is omitted instead of failing the sample.
 * Nothing here spawns a shell; only `systemctl is-active` is executed.
 */
export class MetricsCollector {
  private readonly readText: (path: string) => Promise<string>;
  private readonly cpu: CpuSampler;
  private readonly now: () => number;
  private prevNet?: NetCounters;

  constructor(private readonly deps: CollectorDeps = {}) {
    this.readText = deps.readText ?? ((p) => readFile(p, 'utf8'));
    this.cpu = deps.cpu ?? new CpuSampler();
    this.now = deps.now ?? Date.now;
  }

  async collect(services: readonly string[]): Promise<MetricsSample> {
    const [cpuPercent, mem, disks, net, svc] = await Promise.all([
      this.cpu.sample().catch(() => null),
      this.memory(),
      this.disks(),
      this.network(),
      checkServices(services, this.deps.exec),
    ]);
    const load = os.loadavg().map((v) => Math.round(v * 100) / 100);
    const sample: MetricsSample = {
      collectedAt: new Date(this.now()).toISOString(),
      cpu: { ...(cpuPercent !== null ? { percent: cpuPercent } : {}), cores: Math.max(1, os.cpus().length), load },
      memory: { totalBytes: mem.totalBytes, usedBytes: mem.usedBytes, availableBytes: mem.availableBytes },
      swap: { totalBytes: mem.swapTotalBytes, usedBytes: mem.swapUsedBytes },
      uptimeSec: Math.round(os.uptime()),
    };
    if (disks) sample.disks = disks;
    if (net) sample.network = net;
    if (svc) sample.services = svc;
    return sample;
  }

  private async memory() {
    try {
      return parseMeminfo(await this.readText('/proc/meminfo')) ?? osMemory();
    } catch {
      return osMemory();
    }
  }

  private async disks() {
    try {
      const mounts = parseProcMounts(await this.readText('/proc/mounts'));
      return await collectDisks(mounts, this.deps.statfs);
    } catch {
      return undefined;
    }
  }

  private async network() {
    try {
      const next = parseNetDev(await this.readText('/proc/net/dev'), this.now());
      if (!next) return undefined;
      const prev = this.prevNet;
      this.prevNet = next;
      return prev ? (netRate(prev, next) ?? undefined) : undefined;
    } catch {
      return undefined;
    }
  }
}
