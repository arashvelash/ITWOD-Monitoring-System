import { AlertsService } from '../../../backend/src/alerts/alerts.service';
import { fingerprints } from '../../../backend/src/alerts/alert-rules';
import { MonitoringService } from '../../../backend/src/monitoring/monitoring.service';

const SERVER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const node = { serverId: SERVER, nodeId: 'ims-node-0001', type: 'UBUNTU' as const, secret: 'imss_x' };
const MONITORING = { offlineAfterSec: 180, metricsRetentionDays: 30, cpuPercent: 90, cpuSustainMinutes: 5, memoryPercent: 90, diskPercent: 90, backupMissedGraceMinutes: 120, defaultServices: [] };

/** Tiny where-matcher: equality and `{ not: x }` only (what the services use). */
function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'not' in (v as object)) return row[k] !== (v as { not: unknown }).not;
    if (v && typeof v === 'object' && 'in' in (v as object)) return ((v as { in: unknown[] }).in).includes(row[k]);
    return row[k] === v;
  });
}

function fixture() {
  const server: Record<string, any> = { id: SERVER, name: 'web-1', nodeId: 'ims-node-0001', type: 'UBUNTU', status: 'ONLINE', lastHeartbeatAt: new Date() };
  const alerts: any[] = [];
  const metrics: any[] = [];
  let seq = 0;
  const prisma = {
    server: {
      findUnique: async ({ where }: any) => (where.id === SERVER ? server : null),
      update: async ({ data }: any) => Object.assign(server, data),
      findMany: async ({ where }: any) => (matches(server, where) ? [server] : []),
      updateMany: async ({ where, data }: any) => {
        if (!matches(server, where)) return { count: 0 };
        Object.assign(server, data);
        return { count: 1 };
      },
    },
    nodeMetric: {
      create: async ({ data }: any) => metrics.push(data),
      findMany: async () => metrics.filter((m) => m.cpuPercent !== null).map((m) => ({ cpuPercent: m.cpuPercent })),
    },
    alert: {
      findFirst: async ({ where }: any) => alerts.find((a) => matches(a, where)) ?? null,
      findMany: async ({ where }: any) => alerts.filter((a) => matches(a, where)),
      create: async ({ data }: any) => {
        const a = { id: `alert-${++seq}`, status: 'OPEN', occurrences: 1, ...data };
        alerts.push(a);
        return a;
      },
      update: async ({ where, data }: any) => {
        const a = alerts.find((x) => x.id === where.id);
        for (const [k, v] of Object.entries(data)) a[k] = v && typeof v === 'object' && 'increment' in (v as object) ? a[k] + (v as any).increment : v;
        return a;
      },
    },
  };
  const settings = { get: jest.fn(async () => MONITORING) };
  const locks = { runExclusive: jest.fn(async (_k: string, _ttl: number, fn: () => Promise<void>) => fn()) };
  const emitted: [string, any][] = [];
  const events = { on: jest.fn(), emit: jest.fn(async (name: string, payload: unknown) => void emitted.push([name, payload])) };
  const agentEvents = { register: jest.fn(), onNodeOnline: jest.fn() };
  const alertsService = new AlertsService(prisma as never, {} as never, settings as never, locks as never, events as never);
  const service = new MonitoringService(prisma as never, settings as never, locks as never, agentEvents as never, events as never, alertsService);
  return { service, server, alerts, metrics, emitted, agentEvents };
}

const sample = (over: Record<string, unknown> = {}) => ({
  collectedAt: new Date().toISOString(),
  cpu: { percent: 12, cores: 4, load: [0.1, 0.2, 0.3] },
  memory: { totalBytes: 1000, usedBytes: 400, availableBytes: 600 },
  disks: [{ mount: '/', fs: 'ext4', totalBytes: 1000, usedBytes: 300 }],
  services: [{ name: 'nginx', active: true, state: 'active' }],
  uptimeSec: 3600,
  ...over,
});

describe('MonitoringService', () => {
  it('registers the metrics handler and the online bridge', () => {
    const f = fixture();
    f.service.onModuleInit();
    expect(f.agentEvents.register).toHaveBeenCalledWith('metrics', expect.any(Function));
    expect(f.agentEvents.onNodeOnline).toHaveBeenCalled();
  });

  it('stores the latest sample and throttles the time series', async () => {
    const f = fixture();
    await f.service.ingest(node, sample());
    await f.service.ingest(node, sample({ cpu: { percent: 30 } }));
    expect(f.server.latestMetrics).toMatchObject({ cpu: { percent: 30 } });
    expect(f.metrics).toHaveLength(1);
    expect(f.metrics[0]).toMatchObject({ serverId: SERVER, cpuPercent: 12, memTotalBytes: 1000n, diskUsedPercent: 30, uptimeSec: 3600 });
    expect(f.alerts).toHaveLength(0);
  });

  it('rejects malformed samples', async () => {
    const f = fixture();
    await expect(f.service.ingest(node, { collectedAt: 'yesterday' })).rejects.toThrow();
    await expect(f.service.ingest(node, sample({ services: [{ name: 'bad name;rm', active: true }] }))).rejects.toThrow();
  });

  it('opens de-duplicated alerts and resolves them when values recover', async () => {
    const f = fixture();
    const full = sample({ disks: [{ mount: '/', totalBytes: 1000, usedBytes: 970 }], services: [{ name: 'nginx', active: false, state: 'failed' }] });
    await f.service.ingest(node, full);
    await f.service.ingest(node, full);
    const open = f.alerts.filter((a) => a.status === 'OPEN');
    expect(open.map((a) => a.type).sort()).toEqual(['DISK_HIGH', 'SERVICE_DOWN']);
    expect(open.find((a) => a.type === 'DISK_HIGH').occurrences).toBe(2);
    expect(f.emitted.filter(([n]) => n === 'alert.opened')).toHaveLength(2);

    await f.service.ingest(node, sample());
    expect(f.alerts.every((a) => a.status === 'RESOLVED')).toBe(true);
    expect(f.emitted.filter(([n]) => n === 'alert.resolved')).toHaveLength(2);
  });

  it('marks silent nodes offline once and raises NODE_OFFLINE', async () => {
    const f = fixture();
    f.server.lastHeartbeatAt = new Date(Date.now() - 10 * 60_000);
    await f.service.detectOffline();
    await f.service.detectOffline();
    expect(f.server.status).toBe('OFFLINE');
    expect(f.alerts).toEqual([expect.objectContaining({ type: 'NODE_OFFLINE', fingerprint: fingerprints.offline(SERVER), severity: 'CRITICAL' })]);
    expect(f.emitted.filter(([n]) => n === 'node.offline')).toHaveLength(1);
  });

  it('keeps nodes with recent heartbeats online', async () => {
    const f = fixture();
    await f.service.detectOffline();
    expect(f.server.status).toBe('ONLINE');
    expect(f.alerts).toHaveLength(0);
  });
});
