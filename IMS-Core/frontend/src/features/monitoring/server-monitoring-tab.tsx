import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Activity, BellRing, CheckCircle2 } from 'lucide-react';
import { EmptyState, ErrorState } from '@/components/common/page';
import { SeverityBadge } from '@/components/common/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/misc';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { MetricPoint, Server } from '@/lib/types';
import { bucketMs, diskPercent, formatRate, memoryPercent, toneFor, withGaps } from '@/lib/metrics';
import { formatBytes, formatPercent, formatUptime, timeAgo } from '@/lib/utils';
import { METRIC_RANGES, useAlerts, useMetricsHistory, type MetricRange } from './api';
import { MetricChart } from './metric-chart';

const pct = (v: number) => `${Math.round(v)}%`;
const emptyPoint = (at: string): MetricPoint => ({ collectedAt: at, cpuPercent: null, memUsedPercent: null, diskUsedPercent: null, load1: null, netRxBps: null, netTxBps: null });

export function RangePicker({ value, onChange }: { value: MetricRange; onChange: (r: MetricRange) => void }) {
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as MetricRange)}>
      <TabsList aria-label="Time range">
        {METRIC_RANGES.map((r) => (
          <TabsTrigger key={r} value={r}>
            {r}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

function OpenAlerts({ serverId }: { serverId: string }) {
  const { data } = useAlerts({ serverId, status: 'ACTIVE', pageSize: 10 });
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle className="text-[15px]">Active alerts</CardTitle>
          <CardDescription>For this server</CardDescription>
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link to={`/alerts?serverId=${serverId}`}>History</Link>
        </Button>
      </CardHeader>
      <CardContent>
        {!data?.items.length ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-success" /> No active alerts
          </div>
        ) : (
          <ul className="grid gap-2">
            {data.items.map((a) => (
              <li key={a.id} className="rounded-xl border border-border/70 px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-medium">{a.title}</p>
                  <SeverityBadge severity={a.severity} />
                </div>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  {a.status === 'ACKNOWLEDGED' ? 'Acknowledged · ' : ''}since {timeAgo(a.firstSeenAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Metric history, current disks/services and active alerts of one server. */
export function ServerMonitoringTab({ server }: { server: Server }) {
  const [range, setRange] = useState<MetricRange>('24h');
  const { data, isLoading, error, refetch } = useMetricsHistory(server.id, range);
  const m = server.latestMetrics;
  const longRange = range === '7d' || range === '30d';

  const points = useMemo(() => (data ? withGaps(data.points, bucketMs(data.bucket), emptyPoint) : []), [data]);

  if (server.status === 'PENDING') {
    return (
      <Card>
        <EmptyState icon={Activity} title="Waiting for the agent" description="Metrics appear as soon as the agent is installed and connected." />
      </Card>
    );
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">
          {m ? `Last sample ${timeAgo(m.collectedAt)} · uptime ${formatUptime(m.uptimeSec)}` : 'No samples received yet'}
          {data && ` · ${data.bucket} resolution`}
        </p>
        <RangePicker value={range} onChange={setRange} />
      </div>

      {error ? (
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <MetricChart title="CPU" description="Average usage" data={points} series={[{ key: 'cpuPercent', label: 'CPU', color: 'var(--color-primary)' }]} format={pct} percent longRange={longRange} loading={isLoading} current={formatPercent(m?.cpu?.percent)} />
          <MetricChart title="Memory" description="Used, excluding cache" data={points} series={[{ key: 'memUsedPercent', label: 'Memory', color: 'var(--color-success)' }]} format={pct} percent longRange={longRange} loading={isLoading} current={formatPercent(memoryPercent(m))} />
          <MetricChart title="Disk" description="Fullest mount" data={points} series={[{ key: 'diskUsedPercent', label: 'Disk', color: 'var(--color-warning)' }]} format={pct} percent longRange={longRange} loading={isLoading} />
          <MetricChart
            title="Network"
            description="Physical interfaces"
            data={points}
            series={[
              { key: 'netRxBps', label: 'In', color: 'var(--color-primary)' },
              { key: 'netTxBps', label: 'Out', color: 'var(--color-destructive)' },
            ]}
            format={formatRate}
            longRange={longRange}
            loading={isLoading}
          />
          <MetricChart
            title="Load average"
            description={m?.cpu?.cores ? `1 minute · ${m.cpu.cores} cores` : '1 minute'}
            data={points}
            series={[{ key: 'load1', label: 'Load', color: 'var(--color-muted-foreground)' }]}
            format={(v) => v.toFixed(2)}
            longRange={longRange}
            loading={isLoading}
            current={m?.cpu?.load?.[0]?.toFixed(2)}
          />
          <OpenAlerts serverId={server.id} />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-[15px]">Disks</CardTitle>
            <CardDescription>Current usage per mount</CardDescription>
          </CardHeader>
          <CardContent>
            {!m?.disks?.length ? (
              <p className="text-sm text-muted-foreground">No disks reported.</p>
            ) : (
              <ul className="grid gap-4">
                {m.disks.map((d) => {
                  const p = diskPercent(d);
                  return (
                    <li key={d.mount} className="grid gap-1.5">
                      <div className="flex items-baseline justify-between gap-3 text-[13px]">
                        <span className="min-w-0 truncate font-mono" title={d.mount}>
                          {d.mount}
                          {d.fs && <span className="ml-2 font-sans text-[11px] text-muted-foreground">{d.fs}</span>}
                        </span>
                        <span className="tabular shrink-0 text-muted-foreground">
                          {formatBytes(d.usedBytes)} / {formatBytes(d.totalBytes)} · <span className="font-medium text-foreground">{formatPercent(p)}</span>
                        </span>
                      </div>
                      <Progress value={p} tone={toneFor(p)} />
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-[15px]">Services</CardTitle>
            <CardDescription>systemd units watched on this server</CardDescription>
          </CardHeader>
          <CardContent>
            {server.type === 'CPANEL' ? (
              <p className="text-sm text-muted-foreground">Service checks are not available on shared hosting.</p>
            ) : !m?.services?.length ? (
              <EmptyState icon={BellRing} title="No services watched" description="Add systemd services in the server settings tab or set defaults in Settings › Monitoring." />
            ) : (
              <ul className="divide-y divide-border/60">
                {m.services.map((s) => (
                  <li key={s.name} className="flex items-center justify-between py-2.5">
                    <span className="font-mono text-[13px]">{s.name}</span>
                    <Badge variant={s.active ? 'success' : 'destructive'} dot>
                      {s.state ?? (s.active ? 'active' : 'inactive')}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
