import { Link, useSearchParams } from 'react-router';
import { Check, CheckCircle2, ChevronLeft, ChevronRight, Eye, X } from 'lucide-react';
import { Page, PageHeader, EmptyState, ErrorState, LoadingRows } from '@/components/common/page';
import { AlertStatusBadge, SeverityBadge } from '@/components/common/status';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { AlertSeverity, AlertStatus } from '@/lib/types';
import { formatDateTime, timeAgo } from '@/lib/utils';
import { useAuth } from '@/features/auth/use-auth';
import { useServers } from '@/features/servers/api';
import { useAlertAction, useAlerts } from '@/features/monitoring/api';

const PAGE_SIZE = 20;
type StatusFilter = 'ACTIVE' | AlertStatus | 'ALL';

const TYPE_LABELS: Record<string, string> = {
  NODE_OFFLINE: 'Node offline',
  CPU_HIGH: 'CPU',
  MEMORY_HIGH: 'Memory',
  DISK_HIGH: 'Disk',
  SERVICE_DOWN: 'Service',
  BACKUP_FAILED: 'Backup failed',
  BACKUP_MISSED: 'Backup missed',
  AGENT_UPDATE_FAILED: 'Agent update',
};

export default function AlertsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') as StatusFilter | null) ?? 'ACTIVE';
  const severity = (params.get('severity') as AlertSeverity | null) ?? undefined;
  const serverId = params.get('serverId') ?? undefined;
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);

  const { data: servers } = useServers();
  const { data, isLoading, error, refetch } = useAlerts({ status: status === 'ALL' ? undefined : status, severity, serverId, page, pageSize: PAGE_SIZE });
  const acknowledge = useAlertAction('acknowledge');
  const resolve = useAlertAction('resolve');
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  const setFilter = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  return (
    <Page>
      <PageHeader title="Alerts" description="Resource, availability and backup problems detected by Core. Alerts resolve automatically when the condition clears." />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs value={status} onValueChange={(v) => setFilter('status', v === 'ACTIVE' ? undefined : v)}>
          <TabsList aria-label="Alert status">
            <TabsTrigger value="ACTIVE">Active</TabsTrigger>
            <TabsTrigger value="OPEN">Open</TabsTrigger>
            <TabsTrigger value="ACKNOWLEDGED">Acknowledged</TabsTrigger>
            <TabsTrigger value="RESOLVED">Resolved</TabsTrigger>
            <TabsTrigger value="ALL">All</TabsTrigger>
          </TabsList>
        </Tabs>
        <Select value={severity ?? 'all'} onValueChange={(v) => setFilter('severity', v === 'all' ? undefined : v)}>
          <SelectTrigger className="w-40" aria-label="Filter by severity">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All severities</SelectItem>
            <SelectItem value="CRITICAL">Critical</SelectItem>
            <SelectItem value="WARNING">Warning</SelectItem>
            <SelectItem value="INFO">Info</SelectItem>
          </SelectContent>
        </Select>
        <Select value={serverId ?? 'all'} onValueChange={(v) => setFilter('serverId', v === 'all' ? undefined : v)}>
          <SelectTrigger className="w-52" aria-label="Filter by server">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All servers</SelectItem>
            {servers?.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(severity || serverId) && (
          <Button variant="ghost" size="sm" onClick={() => setParams(status === 'ACTIVE' ? {} : { status }, { replace: true })}>
            <X /> Clear filters
          </Button>
        )}
      </div>

      <Card>
        {isLoading ? (
          <LoadingRows />
        ) : error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : !data?.items.length ? (
          <EmptyState icon={CheckCircle2} title={status === 'ACTIVE' ? 'All clear' : 'No alerts'} description={status === 'ACTIVE' ? 'Nothing needs your attention right now.' : 'No alerts match these filters.'} />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Severity</TableHead>
                  <TableHead>Alert</TableHead>
                  <TableHead>Server</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last seen</TableHead>
                  {can('OPERATOR') && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <SeverityBadge severity={a.severity} />
                    </TableCell>
                    <TableCell className="max-w-md">
                      <div className="font-medium">{a.title}</div>
                      <div className="text-[12px] text-muted-foreground">
                        <span className="mr-1.5 rounded-md bg-muted px-1.5 py-0.5 text-[11px]">{TYPE_LABELS[a.type] ?? a.type}</span>
                        {a.message}
                      </div>
                    </TableCell>
                    <TableCell>
                      {a.server ? (
                        <Link className="text-primary hover:underline" to={`/servers/${a.server.id}`}>
                          {a.server.name}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">System</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <AlertStatusBadge status={a.status} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-[13px] text-muted-foreground" title={`First seen ${formatDateTime(a.firstSeenAt)}${a.resolvedAt ? ` · resolved ${formatDateTime(a.resolvedAt)}` : ''}`}>
                      {timeAgo(a.lastSeenAt)}
                      {a.occurrences > 1 && <span className="ml-1 text-[11px]">×{a.occurrences}</span>}
                    </TableCell>
                    {can('OPERATOR') && (
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1.5">
                          {a.status === 'OPEN' && (
                            <Button variant="outline" size="sm" onClick={() => acknowledge.mutate(a.id)} loading={acknowledge.isPending && acknowledge.variables === a.id}>
                              <Eye /> Acknowledge
                            </Button>
                          )}
                          {a.status !== 'RESOLVED' && (
                            <Button variant="ghost" size="sm" onClick={() => resolve.mutate(a.id)} loading={resolve.isPending && resolve.variables === a.id}>
                              <Check /> Resolve
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {pages > 1 && (
              <div className="flex items-center justify-end gap-2 border-t border-border/60 p-3">
                <span className="text-[13px] text-muted-foreground">
                  Page {page} of {pages} · {data.total} alerts
                </span>
                <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => setFilter('page', String(page - 1))} aria-label="Previous page">
                  <ChevronLeft />
                </Button>
                <Button variant="outline" size="icon-sm" disabled={page >= pages} onClick={() => setFilter('page', String(page + 1))} aria-label="Next page">
                  <ChevronRight />
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </Page>
  );
}
