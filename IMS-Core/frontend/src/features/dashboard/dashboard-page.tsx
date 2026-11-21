import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Archive, BellRing, CheckCircle2, HardDrive, Plus, Server as ServerIcon } from 'lucide-react';
import { Page, PageHeader, EmptyState, ErrorState, LoadingRows } from '@/components/common/page';
import { StatCard } from '@/components/common/stat-card';
import { RunStatusBadge, ServerStatusBadge, SeverityBadge } from '@/components/common/status';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress, Skeleton } from '@/components/ui/misc';
import { api } from '@/lib/api';
import type { DashboardOverview } from '@/lib/types';
import { formatBytes, formatPercent, timeAgo } from '@/lib/utils';
import { maxDiskPercent, memoryPercent, toneFor } from '@/lib/metrics';
import { useAuth } from '@/features/auth/use-auth';

function Meter({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="grid gap-1">
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{label}</span>
        <span className="tabular">{formatPercent(value)}</span>
      </div>
      <Progress value={value ?? 0} tone={toneFor(value)} />
    </div>
  );
}

export default function DashboardPage() {
  const { can, user } = useAuth();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardOverview>('/dashboard/overview'),
    refetchInterval: 15_000,
  });

  const greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  })();

  return (
    <Page>
      <PageHeader
        title={`${greeting}, ${user?.displayName || user?.username}`}
        description="Here is the current state of your infrastructure."
        actions={
          can('OPERATOR') && (
            <Button asChild>
              <Link to="/servers?add=1">
                <Plus /> Add server
              </Link>
            </Button>
          )
        }
      />

      {error ? (
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {isLoading || !data ? (
              Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[118px] rounded-2xl" />)
            ) : (
              <>
                <StatCard index={0} label="Servers online" value={`${data.servers.online}/${data.servers.total}`} hint={`${data.servers.offline} offline · ${data.servers.pending} awaiting agent`} icon={ServerIcon} tone={data.servers.offline ? 'warning' : 'success'} />
                <StatCard index={1} label="Backups (24h)" value={data.backups.last24h.success} hint={`${data.backups.last24h.failed} failed · ${data.backups.last24h.running} running`} icon={Archive} tone={data.backups.last24h.failed ? 'destructive' : 'primary'} />
                <StatCard index={2} label="Open alerts" value={data.alerts.open} hint={`${data.alerts.critical} critical`} icon={BellRing} tone={data.alerts.critical ? 'destructive' : data.alerts.open ? 'warning' : 'success'} />
                <StatCard index={3} label="Backed up (24h)" value={formatBytes(data.backups.totalSizeBytes24h)} hint={`${data.backups.enabledJobs} of ${data.backups.jobs} jobs enabled`} icon={HardDrive} tone="muted" />
              </>
            )}
          </div>

          <div className="mt-6 grid gap-6 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader className="flex-row items-center justify-between">
                <div>
                  <CardTitle>Server health</CardTitle>
                  <CardDescription>Latest reported resource usage</CardDescription>
                </div>
                <Button asChild variant="ghost" size="sm">
                  <Link to="/servers">View all</Link>
                </Button>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <LoadingRows rows={3} />
                ) : !data?.serverHealth.length ? (
                  <EmptyState icon={ServerIcon} title="No servers yet" description="Add a server and install the agent to start monitoring and backups." />
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {data.serverHealth.map((s, i) => (
                      <motion.div key={s.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}>
                        <Link to={`/servers/${s.id}`} className="block rounded-xl border border-border/70 p-4 transition hover:border-primary/40 hover:shadow-[var(--shadow-soft)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring">
                          <div className="mb-3 flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate font-medium">{s.name}</p>
                              <p className="text-[12px] text-muted-foreground">
                                {s.nodeId} · {timeAgo(s.lastHeartbeatAt)}
                              </p>
                            </div>
                            <ServerStatusBadge status={s.status} />
                          </div>
                          <div className="grid gap-2">
                            <Meter label="CPU" value={s.latestMetrics?.cpu?.percent ?? null} />
                            <Meter label="Memory" value={memoryPercent(s.latestMetrics)} />
                            <Meter label="Disk" value={maxDiskPercent(s.latestMetrics)} />
                          </div>
                        </Link>
                      </motion.div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <div>
                  <CardTitle>Open alerts</CardTitle>
                  <CardDescription>Most recent first</CardDescription>
                </div>
                <Button asChild variant="ghost" size="sm">
                  <Link to="/alerts">All alerts</Link>
                </Button>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <LoadingRows rows={3} />
                ) : !data?.recentAlerts.length ? (
                  <EmptyState icon={CheckCircle2} title="All clear" description="No open alerts right now." />
                ) : (
                  <ul className="grid gap-2">
                    {data.recentAlerts.map((a) => (
                      <li key={a.id} className="rounded-xl border border-border/70 px-3.5 py-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-sm font-medium">{a.title}</p>
                          <SeverityBadge severity={a.severity} />
                        </div>
                        <p className="mt-1 text-[12px] text-muted-foreground">
                          {a.server?.name ?? 'System'} · {timeAgo(a.lastSeenAt)}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          <Card className="mt-6">
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle>Recent backup runs</CardTitle>
                <CardDescription>Across all servers</CardDescription>
              </div>
              <Button asChild variant="ghost" size="sm">
                <Link to="/backups?tab=runs">History</Link>
              </Button>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <LoadingRows rows={4} />
              ) : !data?.recentRuns.length ? (
                <EmptyState icon={Archive} title="No backups yet" description="Create a backup job for a server to see runs here." />
              ) : (
                <ul className="divide-y divide-border/60">
                  {data.recentRuns.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{r.job?.name ?? 'Backup job'}</p>
                        <p className="text-[12px] text-muted-foreground">
                          {r.server?.name} · {r.trigger.toLowerCase()} · {timeAgo(r.createdAt)}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="tabular text-[13px] text-muted-foreground">{formatBytes(r.sizeBytes)}</span>
                        <RunStatusBadge status={r.status} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </Page>
  );
}
