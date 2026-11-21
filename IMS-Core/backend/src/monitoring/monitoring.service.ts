import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { RedisLockService } from '../redis/redis-lock.service';
import { AgentEventsService } from '../agents/agent-events.service';
import { DomainEvents } from '../events/domain-events.service';
import { AlertsService } from '../alerts/alerts.service';
import { diskPercent, evaluateSample, fingerprints, offlineThresholdSec } from '../alerts/alert-rules';
import type { AuthenticatedNode } from '../common/types/request';
import { metricsSampleSchema, MetricsRange, RANGES } from './metrics.schema';

/** Minimum spacing of persisted samples per server (bounds database growth). */
const STORE_EVERY_MS = 50_000;

@Injectable()
export class MonitoringService implements OnModuleInit {
  private readonly logger = new Logger(MonitoringService.name);
  private readonly lastStored = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly locks: RedisLockService,
    private readonly agentEvents: AgentEventsService,
    private readonly events: DomainEvents,
    private readonly alerts: AlertsService,
  ) {}

  onModuleInit(): void {
    this.agentEvents.register('metrics', (node, data) => this.ingest(node, data));
    this.agentEvents.onNodeOnline(async (serverId) => {
      await this.alerts.resolveFingerprint(fingerprints.offline(serverId));
      await this.events.emit('node.online', { serverId });
    });
  }

  async ingest(node: AuthenticatedNode, data: unknown): Promise<void> {
    const sample = metricsSampleSchema.parse(data);
    const server = await this.prisma.server.findUnique({ where: { id: node.serverId }, select: { id: true, name: true } });
    if (!server) return;
    const collectedAt = new Date(sample.collectedAt);
    // Never trust agent clocks for ordering beyond a small skew.
    const at = Math.abs(collectedAt.getTime() - Date.now()) > 10 * 60_000 ? new Date() : collectedAt;

    await this.prisma.server.update({ where: { id: server.id }, data: { latestMetrics: sample as Prisma.InputJsonValue, lastMetricsAt: at } });

    const disks = sample.disks ?? [];
    const now = Date.now();
    if (now - (this.lastStored.get(server.id) ?? 0) >= STORE_EVERY_MS) {
      this.lastStored.set(server.id, now);
      await this.prisma.nodeMetric.create({
        data: {
          serverId: server.id,
          collectedAt: at,
          cpuPercent: sample.cpu?.percent ?? null,
          load1: sample.cpu?.load?.[0] ?? null,
          load5: sample.cpu?.load?.[1] ?? null,
          load15: sample.cpu?.load?.[2] ?? null,
          memTotalBytes: sample.memory?.totalBytes !== undefined ? BigInt(Math.round(sample.memory.totalBytes)) : null,
          memUsedBytes: sample.memory?.usedBytes !== undefined ? BigInt(Math.round(sample.memory.usedBytes)) : null,
          swapTotalBytes: sample.swap?.totalBytes !== undefined ? BigInt(Math.round(sample.swap.totalBytes)) : null,
          swapUsedBytes: sample.swap?.usedBytes !== undefined ? BigInt(Math.round(sample.swap.usedBytes)) : null,
          diskUsedPercent: disks.length ? Math.max(...disks.map(diskPercent)) : null,
          disks: disks.length ? (disks as Prisma.InputJsonValue) : undefined,
          netRxBps: sample.network?.rxBytesPerSec ?? null,
          netTxBps: sample.network?.txBytesPerSec ?? null,
          uptimeSec: sample.uptimeSec !== undefined ? Math.round(sample.uptimeSec) : null,
        },
      });
    }
    await this.evaluate(server.id, server.name, sample);
  }

  private async evaluate(serverId: string, serverName: string, sample: ReturnType<typeof metricsSampleSchema.parse>) {
    const t = await this.settings.get('monitoring');
    const since = new Date(Date.now() - t.cpuSustainMinutes * 60_000);
    const recent = await this.prisma.nodeMetric.findMany({ where: { serverId, collectedAt: { gte: since }, cpuPercent: { not: null } }, select: { cpuPercent: true } });
    const cpuSeries = [...recent.map((r) => r.cpuPercent as number), ...(sample.cpu?.percent !== undefined ? [sample.cpu.percent] : [])];
    const result = evaluateSample(serverId, serverName, sample, t, cpuSeries, await this.alerts.openFingerprints(serverId));
    for (const spec of result.open) await this.alerts.open(spec, { serverId });
    for (const fp of result.resolve) await this.alerts.resolveFingerprint(fp);
  }

  async history(serverId: string, range: MetricsRange) {
    const server = await this.prisma.server.findUnique({ where: { id: serverId }, select: { id: true } });
    if (!server) throw new NotFoundException('Server not found');
    const { ms, bucket } = RANGES[range];
    const since = new Date(Date.now() - ms);
    const rows = await this.prisma.$queryRaw<
      { bucket: Date; cpu: number | null; mem: number | null; disk: number | null; load1: number | null; rx: number | null; tx: number | null }[]
    >(Prisma.sql`
      SELECT date_bin(${bucket}::interval, collected_at, TIMESTAMP '2000-01-01') AS bucket,
             avg(cpu_percent)::float8 AS cpu,
             avg(CASE WHEN mem_total_bytes > 0 THEN mem_used_bytes::float8 * 100 / mem_total_bytes END)::float8 AS mem,
             max(disk_used_percent)::float8 AS disk,
             avg(load1)::float8 AS load1,
             avg(net_rx_bps)::float8 AS rx,
             avg(net_tx_bps)::float8 AS tx
      FROM node_metrics
      WHERE server_id = ${serverId}::uuid AND collected_at >= ${since}
      GROUP BY 1
      ORDER BY 1`);
    return {
      range,
      bucket,
      points: rows.map((r) => ({ collectedAt: r.bucket, cpuPercent: r.cpu, memUsedPercent: r.mem, diskUsedPercent: r.disk, load1: r.load1, netRxBps: r.rx, netTxBps: r.tx })),
    };
  }

  /** Marks nodes offline when heartbeats stop and raises NODE_OFFLINE alerts. */
  @Cron(CronExpression.EVERY_MINUTE)
  async detectOffline(): Promise<void> {
    await this.locks.runExclusive('monitoring.offline', 50_000, async () => {
      const { offlineAfterSec } = await this.settings.get('monitoring');
      const online = await this.prisma.server.findMany({ where: { status: 'ONLINE' }, select: { id: true, name: true, nodeId: true, type: true, lastHeartbeatAt: true } });
      for (const s of online) {
        const threshold = offlineThresholdSec(s.type, offlineAfterSec) * 1000;
        if (s.lastHeartbeatAt && Date.now() - s.lastHeartbeatAt.getTime() < threshold) continue;
        const changed = await this.prisma.server.updateMany({ where: { id: s.id, status: 'ONLINE' }, data: { status: 'OFFLINE' } });
        if (!changed.count) continue;
        this.logger.warn(`Node ${s.nodeId} (${s.name}) is offline`);
        await this.alerts.open(
          {
            type: 'NODE_OFFLINE',
            severity: 'CRITICAL',
            fingerprint: fingerprints.offline(s.id),
            title: `${s.name} is offline`,
            message: `No heartbeat from ${s.nodeId} since ${s.lastHeartbeatAt?.toISOString() ?? 'registration'}.`,
          },
          { serverId: s.id },
        );
        await this.events.emit('node.offline', { serverId: s.id, lastHeartbeatAt: s.lastHeartbeatAt });
      }
    });
  }

  /** Daily housekeeping of time series and expired security artefacts. */
  @Cron('17 3 * * *')
  async housekeeping(): Promise<void> {
    await this.locks.runExclusive('monitoring.housekeeping', 30 * 60_000, async () => {
      const { metricsRetentionDays } = await this.settings.get('monitoring');
      const day = 86_400_000;
      const now = Date.now();
      const results = await Promise.all([
        this.prisma.nodeMetric.deleteMany({ where: { collectedAt: { lt: new Date(now - metricsRetentionDays * day) } } }),
        this.prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: new Date(now - day) } } }),
        this.prisma.session.deleteMany({ where: { OR: [{ absoluteExpiresAt: { lt: new Date(now - 30 * day) } }, { revokedAt: { lt: new Date(now - 30 * day) } }] } }),
        this.prisma.telegramLinkCode.deleteMany({ where: { expiresAt: { lt: new Date(now - day) } } }),
        this.prisma.registrationToken.deleteMany({ where: { expiresAt: { lt: new Date(now - 30 * day) } } }),
        this.prisma.nodeCommand.deleteMany({ where: { completedAt: { lt: new Date(now - 90 * day) } } }),
        this.prisma.alert.deleteMany({ where: { status: 'RESOLVED', resolvedAt: { lt: new Date(now - 365 * day) } } }),
      ]);
      this.logger.log(`Housekeeping removed: ${results.map((r) => r.count).join(', ')} (metrics, refresh tokens, sessions, link codes, reg. tokens, commands, alerts)`);
    });
  }
}
