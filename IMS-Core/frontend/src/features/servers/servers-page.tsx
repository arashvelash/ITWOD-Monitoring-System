import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { motion } from 'framer-motion';
import { BellRing, Cpu, Plus, Search, Server as ServerIcon } from 'lucide-react';
import { Page, PageHeader, EmptyState, ErrorState, LoadingRows } from '@/components/common/page';
import { ServerStatusBadge } from '@/components/common/status';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/misc';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatPercent, timeAgo } from '@/lib/utils';
import { maxDiskPercent, memoryPercent, toneFor } from '@/lib/metrics';
import { useAuth } from '@/features/auth/use-auth';
import { useServers } from './api';
import { AddServerDialog } from './add-server-dialog';

function Usage({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="grid min-w-16 gap-1">
      <span className="flex justify-between text-[11px] text-muted-foreground">
        {label} <span className="tabular">{formatPercent(value)}</span>
      </span>
      <Progress value={value ?? 0} tone={toneFor(value)} />
    </div>
  );
}

export default function ServersPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [addOpen, setAddOpen] = useState(params.get('add') === '1');
  const { data, isLoading, error, refetch } = useServers({ status: status === 'all' ? undefined : status, search: search || undefined });

  useEffect(() => {
    if (params.get('add') === '1') setParams({}, { replace: true });
  }, [params, setParams]);

  return (
    <Page>
      <PageHeader
        title="Servers"
        description="Ubuntu nodes and cPanel accounts connected to this Core."
        actions={
          can('OPERATOR') && (
            <Button onClick={() => setAddOpen(true)}>
              <Plus /> Add server
            </Button>
          )
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search name, node id, hostname" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search servers" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="ONLINE">Online</SelectItem>
            <SelectItem value="OFFLINE">Offline</SelectItem>
            <SelectItem value="PENDING">Awaiting agent</SelectItem>
            <SelectItem value="REVOKED">Revoked</SelectItem>
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
      ) : !data?.length ? (
        <Card>
          <EmptyState
            icon={ServerIcon}
            title="No servers found"
            description="Add your first server to generate a registration token and install the agent."
            action={
              can('OPERATOR') && (
                <Button onClick={() => setAddOpen(true)}>
                  <Plus /> Add server
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3">
          {data.map((s, i) => (
            <motion.div key={s.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 10) * 0.025 }}>
              <Link
                to={`/servers/${s.id}`}
                className="surface flex flex-col gap-4 p-4 transition hover:border-primary/40 hover:shadow-[var(--shadow-float)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring md:flex-row md:items-center"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
                    {s.type === 'UBUNTU' ? <Cpu className="size-5 text-muted-foreground" /> : <ServerIcon className="size-5 text-muted-foreground" />}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{s.name}</span>
                      <ServerStatusBadge status={s.status} />
                      {!!s.openAlerts && (
                        <Badge variant="destructive">
                          <BellRing className="size-3" /> {s.openAlerts}
                        </Badge>
                      )}
                    </div>
                    <p className="truncate text-[12px] text-muted-foreground">
                      {s.nodeId} · {s.type === 'UBUNTU' ? 'Ubuntu' : 'cPanel'} · {s.hostname ?? s.operatingSystem} · {s.agentVersion ? `agent v${s.agentVersion}` : 'no agent'}
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-4 md:w-72">
                  <Usage label="CPU" value={s.latestMetrics?.cpu?.percent ?? null} />
                  <Usage label="RAM" value={memoryPercent(s.latestMetrics)} />
                  <Usage label="Disk" value={maxDiskPercent(s.latestMetrics)} />
                </div>
                <div className="text-[12px] text-muted-foreground md:w-32 md:text-right">
                  {s.connected ? <span className="text-success">● live</span> : 'seen'} {timeAgo(s.lastHeartbeatAt)}
                </div>
              </Link>
            </motion.div>
          ))}
        </div>
      )}

      <AddServerDialog open={addOpen} onOpenChange={setAddOpen} />
    </Page>
  );
}
