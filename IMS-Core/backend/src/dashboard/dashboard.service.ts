import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const SERVER_SUMMARY = { id: true, name: true, nodeId: true } as const;

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async overview() {
    const since = new Date(Date.now() - 86_400_000);
    const [serverCounts, jobs, enabledJobs, runsByStatus, size24h, openAlerts, criticalAlerts, recentRuns, recentAlerts, serverHealth] = await Promise.all([
      this.prisma.server.groupBy({ by: ['status'], _count: { _all: true }, where: { status: { not: 'DECOMMISSIONED' } } }),
      this.prisma.backupJob.count({ where: { archivedAt: null } }),
      this.prisma.backupJob.count({ where: { archivedAt: null, enabled: true } }),
      this.prisma.backupRun.groupBy({ by: ['status'], _count: { _all: true }, where: { createdAt: { gte: since } } }),
      this.prisma.backupRun.aggregate({ _sum: { sizeBytes: true }, where: { createdAt: { gte: since }, status: 'SUCCESS' } }),
      this.prisma.alert.count({ where: { status: { not: 'RESOLVED' } } }),
      this.prisma.alert.count({ where: { status: { not: 'RESOLVED' }, severity: 'CRITICAL' } }),
      this.prisma.backupRun.findMany({
        take: 8,
        orderBy: { createdAt: 'desc' },
        include: { job: { select: { id: true, name: true, type: true } }, server: { select: SERVER_SUMMARY } },
      }),
      this.prisma.alert.findMany({ where: { status: { not: 'RESOLVED' } }, take: 6, orderBy: { lastSeenAt: 'desc' }, include: { server: { select: SERVER_SUMMARY } } }),
      this.prisma.server.findMany({
        where: { status: { in: ['ONLINE', 'OFFLINE', 'PENDING'] } },
        orderBy: [{ status: 'asc' }, { name: 'asc' }],
        take: 12,
        select: { id: true, name: true, nodeId: true, status: true, type: true, lastHeartbeatAt: true, latestMetrics: true, agentVersion: true },
      }),
    ]);

    const count = (rows: { status: string; _count: { _all: number } }[], status: string) => rows.find((r) => r.status === status)?._count._all ?? 0;
    const total = serverCounts.reduce((a, r) => a + r._count._all, 0);

    return {
      servers: { total, online: count(serverCounts, 'ONLINE'), offline: count(serverCounts, 'OFFLINE'), pending: count(serverCounts, 'PENDING') },
      backups: {
        jobs,
        enabledJobs,
        last24h: { success: count(runsByStatus, 'SUCCESS'), failed: count(runsByStatus, 'FAILED'), running: count(runsByStatus, 'RUNNING') + count(runsByStatus, 'QUEUED') },
        totalSizeBytes24h: Number(size24h._sum.sizeBytes ?? 0),
      },
      alerts: { open: openAlerts, critical: criticalAlerts },
      recentRuns: recentRuns.map(({ logTail: _l, ...r }) => r),
      recentAlerts,
      serverHealth,
    };
  }
}
