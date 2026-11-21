import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AlertSeverity, AlertStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { RedisLockService } from '../redis/redis-lock.service';
import { DomainEvents } from '../events/domain-events.service';
import type { AuthUser } from '../common/types/request';
import { previousRun } from '../backups/backup.schemas';
import { AlertSpec, fingerprints } from './alert-rules';

export interface AlertTarget {
  serverId?: string | null;
  jobId?: string | null;
}

/**
 * Alert lifecycle: open (de-duplicated by fingerprint) → acknowledge → resolve.
 * Notifications are emitted only on state changes, never on repeats.
 */
@Injectable()
export class AlertsService implements OnModuleInit {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly locks: RedisLockService,
    private readonly events: DomainEvents,
  ) {}

  onModuleInit(): void {
    this.events.on('backup.finished', async ({ run, job, server }) => {
      if (run.status === 'FAILED') {
        await this.open(
          {
            type: 'BACKUP_FAILED',
            severity: 'WARNING',
            fingerprint: fingerprints.backupFailed(job.id),
            title: `Backup "${job.name}" failed on ${server.name}`,
            message: run.errorMessage ?? 'The backup run failed.',
            details: { runId: run.id },
          },
          { serverId: server.id, jobId: job.id },
        );
      } else if (run.status === 'SUCCESS') {
        await this.resolveFingerprint(fingerprints.backupFailed(job.id));
        await this.resolveFingerprint(fingerprints.backupMissed(job.id));
      }
    });
    this.events.on('agent.update.finished', async ({ serverId, version, succeeded, error }) => {
      if (succeeded) {
        await this.resolveFingerprint(fingerprints.agentUpdate(serverId));
        return;
      }
      const server = await this.prisma.server.findUnique({ where: { id: serverId }, select: { name: true } });
      await this.open(
        { type: 'AGENT_UPDATE_FAILED', severity: 'WARNING', fingerprint: fingerprints.agentUpdate(serverId), title: `Agent update to ${version} failed on ${server?.name ?? serverId}`, message: error ?? 'The agent rolled back to the previous version.' },
        { serverId },
      );
    });
  }

  async open(spec: AlertSpec, target: AlertTarget = {}) {
    const existing = await this.prisma.alert.findFirst({ where: { fingerprint: spec.fingerprint, status: { not: 'RESOLVED' } } });
    if (existing) {
      return this.prisma.alert.update({
        where: { id: existing.id },
        data: {
          lastSeenAt: new Date(),
          occurrences: { increment: 1 },
          message: spec.message,
          // Escalate severity, never silently downgrade an open alert.
          ...(rank(spec.severity) > rank(existing.severity) ? { severity: spec.severity } : {}),
          details: spec.details as Prisma.InputJsonValue | undefined,
        },
      });
    }
    const alert = await this.prisma.alert.create({
      data: {
        type: spec.type,
        severity: spec.severity,
        fingerprint: spec.fingerprint,
        title: spec.title.slice(0, 255),
        message: spec.message.slice(0, 2000),
        details: spec.details as Prisma.InputJsonValue | undefined,
        serverId: target.serverId ?? null,
        jobId: target.jobId ?? null,
      },
    });
    this.logger.log(`Alert opened: ${alert.title}`);
    await this.events.emit('alert.opened', { alert });
    return alert;
  }

  async resolveFingerprint(fingerprint: string): Promise<number> {
    const open = await this.prisma.alert.findMany({ where: { fingerprint, status: { not: 'RESOLVED' } } });
    for (const a of open) {
      const alert = await this.prisma.alert.update({ where: { id: a.id }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
      await this.events.emit('alert.resolved', { alert });
    }
    return open.length;
  }

  openFingerprints(serverId: string): Promise<string[]> {
    return this.prisma.alert.findMany({ where: { serverId, status: { not: 'RESOLVED' } }, select: { fingerprint: true } }).then((r) => r.map((a) => a.fingerprint));
  }

  async list(q: { status?: AlertStatus | 'ACTIVE'; severity?: AlertSeverity; serverId?: string; page: number; pageSize: number }) {
    const where: Prisma.AlertWhereInput = {
      ...(q.status === 'ACTIVE' ? { status: { not: 'RESOLVED' } } : q.status ? { status: q.status } : {}),
      ...(q.severity ? { severity: q.severity } : {}),
      ...(q.serverId ? { serverId: q.serverId } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.alert.findMany({ where, orderBy: [{ status: 'asc' }, { lastSeenAt: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { server: { select: { id: true, name: true, nodeId: true } } } }),
      this.prisma.alert.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  async acknowledge(id: string, user: AuthUser) {
    const alert = await this.prisma.alert.findUnique({ where: { id } });
    if (!alert) throw new NotFoundException('Alert not found');
    if (alert.status !== 'OPEN') return alert;
    await this.audit.byUser(user, 'alert.acknowledge', { type: 'alert', id });
    return this.prisma.alert.update({ where: { id }, data: { status: 'ACKNOWLEDGED', acknowledgedAt: new Date(), acknowledgedById: user.id } });
  }

  async resolveManually(id: string, user: AuthUser) {
    const alert = await this.prisma.alert.findUnique({ where: { id } });
    if (!alert) throw new NotFoundException('Alert not found');
    if (alert.status === 'RESOLVED') return alert;
    const resolved = await this.prisma.alert.update({ where: { id }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
    await this.audit.byUser(user, 'alert.resolve', { type: 'alert', id });
    await this.events.emit('alert.resolved', { alert: resolved });
    return resolved;
  }

  /**
   * Missed backups: an enabled job whose most recent scheduled slot (older than
   * the grace period) has no run started after it.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async detectMissedBackups(): Promise<void> {
    await this.locks.runExclusive('alerts.missed-backups', 300_000, async () => {
      const { backupMissedGraceMinutes } = await this.settings.get('monitoring');
      const cutoff = new Date(Date.now() - backupMissedGraceMinutes * 60_000);
      const jobs = await this.prisma.backupJob.findMany({
        where: { enabled: true, archivedAt: null, server: { status: { in: ['ONLINE', 'OFFLINE'] } } },
        include: { server: { select: { id: true, name: true } } },
      });
      for (const job of jobs) {
        const slot = previousRun(job.schedule, job.timezone, cutoff);
        if (!slot || slot < job.createdAt) continue;
        const ran = await this.prisma.backupRun.count({ where: { jobId: job.id, createdAt: { gte: new Date(slot.getTime() - 60_000) } } });
        if (ran > 0) continue;
        await this.open(
          {
            type: 'BACKUP_MISSED',
            severity: 'WARNING',
            fingerprint: fingerprints.backupMissed(job.id),
            title: `Backup "${job.name}" did not run on ${job.server.name}`,
            message: `No run was reported for the slot at ${slot.toISOString()} (grace ${backupMissedGraceMinutes} min).`,
            details: { slot: slot.toISOString() },
          },
          { serverId: job.serverId, jobId: job.id },
        );
      }
    });
  }
}

function rank(s: AlertSeverity): number {
  return { INFO: 0, WARNING: 1, CRITICAL: 2 }[s];
}
