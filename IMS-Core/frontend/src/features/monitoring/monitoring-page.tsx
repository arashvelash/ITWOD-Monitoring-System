import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { motion } from 'framer-motion';
import { Activity, BellRing, Cpu, Gauge, HardDrive, MemoryStick, Search, ServerCrash } from 'lucide-react';
import { Page, PageHeader, EmptyState, ErrorState, LoadingRows } from '@/components/common/page';
import { StatCard } from '@/components/common/stat-card';
import { ServerStatusBadge } from '@/components/common/status';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress, Skeleton } from '@/components/ui/misc';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { diskPercent, formatRate, maxDiskPercent, memoryPercent, toneFor } from '@/lib/metrics';
import { formatPercent, formatUptime, timeAgo } from '@/lib/utils';
import { useServers, type ServerListItem } from '@/features/servers/api';

type SortKey = 'pressure' | 'cpu' | 'memory' | 'disk' | 'name';

function pressure(s: ServerListItem): number {
  const m = s.latestMetrics;
  if (s.status === 'OFFLINE') return 1000;
  return Math.max(m?.cpu?.percent ?? 0, memoryPercent(m) ?? 0, maxDiskPercent(m) ?? 0) + (s.openAlerts ?? 0) * 10;
}

const SORTERS: Record<SortKey, (a: ServerListItem, b: ServerListItem) => number> = {
  pressure: (a, b) => pressure(b) - pressure(a),
  cpu: (a, b) => (b.latestMetrics?.cpu?.percent ?? -1) - (a.latestMetrics?.cpu?.percent ?? -1),
  memory: (a, b) => (memoryPercent(b.latestMetrics) ?? -1) - (memoryPercent(a.latestMetrics) ?? -1),
  disk: (a, b) => (maxDiskPercent(b.latestMetrics) ?? -1) - (maxDiskPercent(a.latestMetrics) ?? -1),
  name: (a, b) => a.name.localeCompare(b.name),
};

function Meter({ icon: Icon, label, value, hint }: { icon: typeof Cpu; label: string; value: number | null; hint?: string }) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between text-[12px]">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Icon className="size-3.5" /> {label}
        </span>
        <span className="tabular font-medium">{formatPercent(value)}</span>
      </div>
      <Progress value={value ?? 0} tone={toneFor(value)} />
      {hint && <p className="truncate text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ServerCard({ s, index }: { s: ServerListItem; index: number }) {
  const m = s.latestMetrics;
  const worstDisk = m?.disks?.length ? [...m.disks].sort((a, b) => diskPercent(b) - diskPercent(a))[0] : undefined;
  const down = m?.services?.filter((x) => !x.active) ?? [];
  const stale = s.status === 'OFFLINE';
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(index, 12) * 0.025 }}>
      <Link
        to={`/servers/${s.id}?tab=monitoring`}
        className="surface flex h-full flex-col gap-4 p-4 transition hover:border-primary/40 hover:shadow-[var(--shadow-float)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-medium">{s.name}</p>
            <p className="truncate text-[12px] text-muted-foreground">
              {s.nodeId} · {m ? `sample ${timeAgo(m.collectedAt)}` : 'no samples'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {!!s.openAlerts && (
              <Badge variant="destructive" aria-label={`${s.openAlerts} open alerts`}>
                <BellRing className="size-3" /> {s.openAlerts}
              </Badge>
            )}
            <ServerStatusBadge status={s.status} />
          </div>
        </div>
        <div className={stale ? 'grid gap-3 opacity-50' : 'grid gap-3'}>
          <Meter icon={Cpu} label="CPU" value={m?.cpu?.percent ?? null} hint={m?.cpu?.load ? `load ${m.cpu.load.map((l) => l.toFixed(2)).join(' · ')}` : undefined} />
          <Meter icon={MemoryStick} label="Memory" value={memoryPercent(m)} />
          <Meter icon={HardDrive} label="Disk" value={maxDiskPercent(m)} hint={worstDisk ? `fullest: ${worstDisk.mount}` : undefined} />
        </div>
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3 text-[12px] text-muted-foreground">
          <span className="tabular">
            ↓ {formatRate(m?.network?.rxBytesPerSec)} · ↑ {formatRate(m?.network?.txBytesPerSec)}
          </span>
          {down.length ? (
            <span className="font-medium text-destructive">{down.length} service(s) down</span>
          ) : (
            <span>up {formatUptime(m?.uptimeSec)}</span>
          )}
        </div>
      </Link>
    </motion.div>
  );
}

export default function MonitoringPage() {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('pressure');
  const { data, isLoading, error, refetch } = useServers();

  const monitored = useMemo(() => (data ?? []).filter((s) => s.status === 'ONLINE' || s.status === 'OFFLINE'), [data]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return monitored.filter((s) => !q || [s.name, s.nodeId, s.hostname ?? ''].some((v) => v.toLowerCase().includes(q))).sort(SORTERS[sort]);
  }, [monitored, search, sort]);

  const stats = useMemo(() => {
    const online = monitored.filter((s) => s.status === 'ONLINE');
    const cpus = online.map((s) => s.latestMetrics?.cpu?.percent).filter((v): v is number => typeof v === 'number');
    const disks = online.map((s) => maxDiskPercent(s.latestMetrics)).filter((v): v is number => v !== null);
    const down = online.reduce((n, s) => n + (s.latestMetrics?.services?.filter((x) => !x.active).length ?? 0), 0);
    return {
      online: online.length,
      offline: monitored.length - online.length,
      avgCpu: cpus.length ? cpus.reduce((a, b) => a + b, 0) / cpus.length : null,
      maxDisk: disks.length ? Math.max(...disks) : null,
      down,
    };
  }, [monitored]);

  return (
    <Page>
      <PageHeader title="Monitoring" description="Live resource usage across every connected server." />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {isLoading ? (
          Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[118px] rounded-2xl" />)
        ) : (
          <>
            <StatCard index={0} label="Reporting" value={`${stats.online}/${monitored.length}`} hint={`${stats.offline} offline`} icon={Activity} tone={stats.offline ? 'warning' : 'success'} />
            <StatCard index={1} label="Average CPU" value={formatPercent(stats.avgCpu)} hint="Online servers" icon={Gauge} tone={toneFor(stats.avgCpu) === 'destructive' ? 'destructive' : 'primary'} />
            <StatCard index={2} label="Fullest disk" value={formatPercent(stats.maxDisk)} hint="Highest mount usage" icon={HardDrive} tone={toneFor(stats.maxDisk) === 'destructive' ? 'destructive' : toneFor(stats.maxDisk) === 'warning' ? 'warning' : 'muted'} />
            <StatCard index={3} label="Services down" value={stats.down} hint="Watched systemd units" icon={ServerCrash} tone={stats.down ? 'destructive' : 'success'} />
          </>
        )}
      </div>

      <div className="my-5 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Filter servers" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Filter servers" />
        </div>
        <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
          <SelectTrigger className="w-48" aria-label="Sort servers">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pressure">Needs attention first</SelectItem>
            <SelectItem value="cpu">Highest CPU</SelectItem>
            <SelectItem value="memory">Highest memory</SelectItem>
            <SelectItem value="disk">Fullest disk</SelectItem>
            <SelectItem value="name">Name</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <Card>
          <LoadingRows />
        </Card>
      ) : error ? (
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      ) : !visible.length ? (
        <Card>
          <EmptyState icon={Activity} title={monitored.length ? 'No matching servers' : 'Nothing to monitor yet'} description={monitored.length ? 'Try a different filter.' : 'Servers appear here once their agent has registered.'} />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((s, i) => (
            <ServerCard key={s.id} s={s} index={i} />
          ))}
        </div>
      )}
    </Page>
  );
}
