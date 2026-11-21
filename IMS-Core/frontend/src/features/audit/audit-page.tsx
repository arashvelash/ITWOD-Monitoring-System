import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ScrollText, Search } from 'lucide-react';
import { Page, PageHeader, EmptyState, ErrorState, LoadingRows } from '@/components/common/page';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import type { AuditEntry, Paginated } from '@/lib/types';
import { formatDateTime } from '@/lib/utils';

const PAGE_SIZE = 25;

export default function AuditPage() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['audit', page, action],
    queryFn: () => api.get<Paginated<AuditEntry>>('/audit-logs', { page, pageSize: PAGE_SIZE, action: action || undefined }),
    placeholderData: keepPreviousData,
  });
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <Page>
      <PageHeader title="Audit log" description="Security-relevant actions performed by users, nodes, Telegram and the system." />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border/60 p-4">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Filter by action prefix, e.g. auth."
              className="pl-9"
              value={action}
              onChange={(e) => {
                setAction(e.target.value.trim());
                setPage(1);
              }}
              aria-label="Filter by action"
            />
          </div>
          <span className="text-[13px] text-muted-foreground">{data?.total ?? 0} entries</span>
        </div>
        {isLoading ? (
          <LoadingRows rows={8} />
        ) : error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : !data?.items.length ? (
          <EmptyState icon={ScrollText} title="No audit entries" />
        ) : (
          <Table className={isFetching ? 'opacity-70' : undefined}>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>IP</TableHead>
                <TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(e.createdAt)}</TableCell>
                  <TableCell>
                    <span className="font-medium">{e.actorName ?? '—'}</span> <span className="text-[12px] text-muted-foreground">{e.actorType.toLowerCase()}</span>
                  </TableCell>
                  <TableCell>
                    <code className="font-mono text-[12.5px]">{e.action}</code>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{e.targetType ? `${e.targetType}:${e.targetId?.slice(0, 8) ?? ''}` : '—'}</TableCell>
                  <TableCell className="font-mono text-[12px] text-muted-foreground">{e.ipAddress ?? '—'}</TableCell>
                  <TableCell>{e.success ? <Badge variant="success">ok</Badge> : <Badge variant="destructive">denied</Badge>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-border/60 p-3">
          <span className="text-[13px] text-muted-foreground">
            Page {page} of {pages}
          </span>
          <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="icon-sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
            <ChevronRight />
          </Button>
        </div>
      </Card>
    </Page>
  );
}
