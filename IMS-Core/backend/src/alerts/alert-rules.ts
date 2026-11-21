import type { AlertSeverity, AlertType } from '@prisma/client';

/**
 * Pure alert evaluation for one metrics sample. Hysteresis margins prevent
 * alerts from flapping when a value hovers around its threshold.
 */
export interface Thresholds {
  cpuPercent: number;
  cpuSustainMinutes: number;
  memoryPercent: number;
  diskPercent: number;
}

export interface MetricsSample {
  cpu?: { percent?: number };
  memory?: { totalBytes?: number; usedBytes?: number };
  disks?: { mount: string; totalBytes: number; usedBytes: number }[];
  services?: { name: string; active: boolean; state?: string }[];
}

export interface AlertSpec {
  type: AlertType;
  severity: AlertSeverity;
  fingerprint: string;
  title: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface Evaluation {
  open: AlertSpec[];
  resolve: string[];
}

const HYSTERESIS = { cpu: 5, memory: 5, disk: 2 };

export const fingerprints = {
  cpu: (serverId: string) => `CPU_HIGH:${serverId}`,
  memory: (serverId: string) => `MEMORY_HIGH:${serverId}`,
  disk: (serverId: string, mount: string) => `DISK_HIGH:${serverId}:${mount}`,
  service: (serverId: string, name: string) => `SERVICE_DOWN:${serverId}:${name}`,
  offline: (serverId: string) => `NODE_OFFLINE:${serverId}`,
  backupFailed: (jobId: string) => `BACKUP_FAILED:${jobId}`,
  backupMissed: (jobId: string) => `BACKUP_MISSED:${jobId}`,
  agentUpdate: (serverId: string) => `AGENT_UPDATE_FAILED:${serverId}`,
};

export function memoryPercent(s: MetricsSample): number | null {
  const t = s.memory?.totalBytes;
  return t ? ((s.memory?.usedBytes ?? 0) / t) * 100 : null;
}

export function diskPercent(d: { totalBytes: number; usedBytes: number }): number {
  return d.totalBytes ? (d.usedBytes / d.totalBytes) * 100 : 0;
}

/**
 * @param recentCpu CPU samples (percent) of the last `cpuSustainMinutes`, including the current one.
 * @param openFingerprints fingerprints of currently open alerts for this server (for resolution of vanished items).
 */
export function evaluateSample(serverId: string, serverName: string, s: MetricsSample, t: Thresholds, recentCpu: number[], openFingerprints: string[] = []): Evaluation {
  const open: AlertSpec[] = [];
  const resolve: string[] = [];

  const cpu = s.cpu?.percent;
  if (cpu !== undefined) {
    const sustained = recentCpu.length >= 2 && recentCpu.every((v) => v >= t.cpuPercent);
    if (sustained) {
      open.push({
        type: 'CPU_HIGH',
        severity: cpu >= 98 ? 'CRITICAL' : 'WARNING',
        fingerprint: fingerprints.cpu(serverId),
        title: `High CPU on ${serverName}`,
        message: `CPU usage has been above ${t.cpuPercent}% for ${t.cpuSustainMinutes} minutes (now ${cpu.toFixed(0)}%).`,
        details: { cpu },
      });
    } else if (cpu < t.cpuPercent - HYSTERESIS.cpu) {
      resolve.push(fingerprints.cpu(serverId));
    }
  }

  const mem = memoryPercent(s);
  if (mem !== null) {
    if (mem >= t.memoryPercent) {
      open.push({
        type: 'MEMORY_HIGH',
        severity: mem >= 97 ? 'CRITICAL' : 'WARNING',
        fingerprint: fingerprints.memory(serverId),
        title: `High memory usage on ${serverName}`,
        message: `Memory usage is ${mem.toFixed(0)}% (threshold ${t.memoryPercent}%).`,
        details: { memoryPercent: mem },
      });
    } else if (mem < t.memoryPercent - HYSTERESIS.memory) {
      resolve.push(fingerprints.memory(serverId));
    }
  }

  const seenMounts = new Set<string>();
  for (const d of s.disks ?? []) {
    seenMounts.add(d.mount);
    const pct = diskPercent(d);
    const fp = fingerprints.disk(serverId, d.mount);
    if (pct >= t.diskPercent) {
      open.push({
        type: 'DISK_HIGH',
        severity: pct >= 95 ? 'CRITICAL' : 'WARNING',
        fingerprint: fp,
        title: `Disk ${d.mount} almost full on ${serverName}`,
        message: `${d.mount} is ${pct.toFixed(0)}% full (threshold ${t.diskPercent}%).`,
        details: { mount: d.mount, percent: pct, totalBytes: d.totalBytes, usedBytes: d.usedBytes },
      });
    } else if (pct < t.diskPercent - HYSTERESIS.disk) {
      resolve.push(fp);
    }
  }

  const seenServices = new Set<string>();
  for (const svc of s.services ?? []) {
    seenServices.add(svc.name);
    const fp = fingerprints.service(serverId, svc.name);
    if (!svc.active) {
      open.push({
        type: 'SERVICE_DOWN',
        severity: 'CRITICAL',
        fingerprint: fp,
        title: `Service ${svc.name} is down on ${serverName}`,
        message: `systemd reports ${svc.name} as ${svc.state ?? 'inactive'}.`,
        details: { service: svc.name, state: svc.state },
      });
    } else {
      resolve.push(fp);
    }
  }

  // Mounts / services that disappeared from the report (unmounted, no longer watched) are resolved.
  for (const fp of openFingerprints) {
    const disk = fp.startsWith(`DISK_HIGH:${serverId}:`) ? fp.slice(`DISK_HIGH:${serverId}:`.length) : null;
    if (disk !== null && s.disks && !seenMounts.has(disk)) resolve.push(fp);
    const svc = fp.startsWith(`SERVICE_DOWN:${serverId}:`) ? fp.slice(`SERVICE_DOWN:${serverId}:`.length) : null;
    if (svc !== null && s.services && !seenServices.has(svc)) resolve.push(fp);
  }

  return { open, resolve };
}

/** Offline threshold per agent type: cPanel agents only report every 5 minutes from cron. */
export function offlineThresholdSec(type: 'UBUNTU' | 'CPANEL', configured: number): number {
  return type === 'CPANEL' ? Math.max(configured, 17 * 60) : configured;
}
