import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { Activity, Archive, ArrowLeft, Ban, Gauge, KeyRound, ListChecks, Radio, RefreshCw, Settings2, Trash2 } from 'lucide-react';
import { Page, ErrorState, LoadingRows, EmptyState } from '@/components/common/page';
import { CommandStatusBadge, ServerStatusBadge } from '@/components/common/status';
import { Confirm } from '@/components/common/confirm';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Progress } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { RegistrationInfo } from '@/lib/types';
import { formatBytes, formatDateTime, formatPercent, formatUptime, timeAgo } from '@/lib/utils';
import { maxDiskPercent, memoryPercent, toneFor } from '@/lib/metrics';
import { useAuth } from '@/features/auth/use-auth';
import { ServerBackupsTab } from '@/features/backups/server-backups-tab';
import { ServerMonitoringTab } from '@/features/monitoring/server-monitoring-tab';
import { useServer, useServerAction, useServerCommands, useUpdateServer, type ServerDetail } from './api';
import { RegistrationPanel } from './registration-panel';

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[12px] text-muted-foreground">{label}</p>
      <div className="mt-0.5 truncate text-sm font-medium">{children}</div>
    </div>
  );
}

function Overview({ server }: { server: ServerDetail }) {
  const m = server.latestMetrics;
  const mem = memoryPercent(m);
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Node</CardTitle>
          <CardDescription>Identity and agent details</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Info label="Node ID">
            <code className="font-mono text-[13px]">{server.nodeId}</code>
          </Info>
          <Info label="Type">{server.type === 'UBUNTU' ? 'Ubuntu server' : 'cPanel hosting'}</Info>
          <Info label="Hostname">{server.hostname ?? '—'}</Info>
          <Info label="Operating system">{server.osDetails ?? server.operatingSystem}</Info>
          <Info label="Agent version">{server.agentVersion ?? '—'}</Info>
          <Info label="IP address">{server.ipAddress ?? '—'}</Info>
          <Info label="Registered">{formatDateTime(server.registeredAt)}</Info>
          <Info label="Last heartbeat">{timeAgo(server.lastHeartbeatAt)}</Info>
          <Info label="Connection">{server.connected ? <span className="text-success">Live WebSocket</span> : server.type === 'CPANEL' ? 'Cron polling' : 'Not connected'}</Info>
          <Info label="Key fingerprint">
            <code className="font-mono text-[12px]">{server.credential?.keyFingerprint?.slice(0, 23) ?? (server.credential ? 'HMAC only' : '—')}</code>
          </Info>
          <Info label="Credential issued">{formatDateTime(server.credential?.issuedAt)}</Info>
          <Info label="Tags">{server.tags.length ? server.tags.map((t) => <Badge key={t} variant="secondary" className="mr-1">{t}</Badge>) : '—'}</Info>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Resources</CardTitle>
          <CardDescription>{m ? `Reported ${timeAgo(m.collectedAt)}` : 'No metrics yet'}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {[
            ['CPU', m?.cpu?.percent ?? null, m?.cpu?.load ? `load ${m.cpu.load.map((l) => l.toFixed(2)).join(' / ')}` : undefined],
            ['Memory', mem, m?.memory ? `${formatBytes(m.memory.usedBytes)} of ${formatBytes(m.memory.totalBytes)}` : undefined],
            ['Disk (max)', maxDiskPercent(m), m?.disks?.length ? `${m.disks.length} mount(s)` : undefined],
          ].map(([label, value, hint]) => (
            <div key={label as string} className="grid gap-1.5">
              <div className="flex justify-between text-[13px]">
                <span>{label as string}</span>
                <span className="tabular font-medium">{formatPercent(value as number | null)}</span>
              </div>
              <Progress value={(value as number | null) ?? 0} tone={toneFor(value as number | null)} />
              {hint && <p className="text-[11px] text-muted-foreground">{hint as string}</p>}
            </div>
          ))}
          <p className="text-[12px] text-muted-foreground">Uptime {formatUptime(m?.uptimeSec)}</p>
          {!!m?.services?.length && (
            <div className="flex flex-wrap gap-1.5">
              {m.services.map((s) => (
                <Badge key={s.name} variant={s.active ? 'success' : 'destructive'} dot>
                  {s.name}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Commands({ id }: { id: string }) {
  const { data, isLoading, error, refetch } = useServerCommands(id);
  if (isLoading) return <LoadingRows />;
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (!data?.length) return <EmptyState icon={ListChecks} title="No commands yet" description="Commands such as ping, backup runs and agent updates appear here." />;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Command</TableHead>
          <TableHead>Origin</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>Result</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((c) => (
          <TableRow key={c.id}>
            <TableCell>
              <code className="font-mono text-[12.5px]">{c.type}</code>
            </TableCell>
            <TableCell className="text-muted-foreground">{c.origin.toLowerCase()}</TableCell>
            <TableCell>
              <CommandStatusBadge status={c.status} />
            </TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground">{timeAgo(c.createdAt)}</TableCell>
            <TableCell className="max-w-xs truncate text-[12px] text-muted-foreground" title={c.errorMessage ?? JSON.stringify(c.result ?? {})}>
              {c.errorMessage ?? (c.result ? JSON.stringify(c.result) : '—')}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SettingsForm({ server }: { server: ServerDetail }) {
  const update = useUpdateServer(server.id);
  const { register, handleSubmit, reset } = useForm<{ name: string; operatingSystem: string; description: string; tags: string; services: string }>();
  useEffect(
    () =>
      reset({
        name: server.name,
        operatingSystem: server.operatingSystem,
        description: server.description ?? '',
        tags: server.tags.join(', '),
        services: server.monitoringConfig?.services?.join(', ') ?? '',
      }),
    [server, reset],
  );
  const split = (v: string) =>
    v
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  return (
    <Card>
      <form
        onSubmit={handleSubmit((v) =>
          update.mutate({
            name: v.name,
            operatingSystem: v.operatingSystem,
            description: v.description || null,
            tags: split(v.tags).map((t) => t.toLowerCase()),
            monitoredServices: v.services.trim() ? split(v.services) : null,
          }),
        )}
      >
        <CardContent className="grid gap-4 pt-5 sm:grid-cols-2">
          <Field id="s-name" label="Name">
            <Input id="s-name" {...register('name', { required: true })} />
          </Field>
          <Field id="s-os" label="Operating system">
            <Input id="s-os" {...register('operatingSystem', { required: true })} />
          </Field>
          <Field id="s-desc" label="Description" className="sm:col-span-2">
            <Textarea id="s-desc" rows={2} {...register('description')} />
          </Field>
          <Field id="s-tags" label="Tags" hint="Comma separated">
            <Input id="s-tags" {...register('tags')} />
          </Field>
          <Field id="s-services" label="Monitored systemd services" hint="Empty = instance default (Settings › Monitoring)">
            <Input id="s-services" placeholder="nginx, mysql, php8.3-fpm" {...register('services')} />
          </Field>
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" loading={update.isPending}>
            Save changes
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

export default function ServerDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'overview';
  const { data: server, isLoading, error, refetch } = useServer(id);
  const [registration, setRegistration] = useState<RegistrationInfo | null>(null);

  const ping = useServerAction(id, 'ping', 'Ping sent');
  const sync = useServerAction(id, 'config-sync', 'Configuration sync requested');
  const token = useServerAction<RegistrationInfo>(id, 'registration-token');
  const revoke = useServerAction(id, 'revoke', 'Node credential revoked');
  const decommission = useServerAction(id, 'decommission', 'Server decommissioned');

  if (isLoading) return <Page><Card><LoadingRows /></Card></Page>;
  if (error || !server) return <Page><Card><ErrorState error={error} onRetry={() => refetch()} /></Card></Page>;

  const registered = server.status === 'ONLINE' || server.status === 'OFFLINE';
  const canEnroll = server.status === 'PENDING' || server.status === 'REVOKED';

  return (
    <Page>
      <Button asChild variant="ghost" size="sm" className="-ml-2 mb-3">
        <Link to="/servers">
          <ArrowLeft /> Servers
        </Link>
      </Button>
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold sm:text-[28px]">{server.name}</h1>
            <ServerStatusBadge status={server.status} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {server.nodeId} · {server.description ?? server.operatingSystem}
          </p>
          {server.pendingToken && (
            <p className="mt-1 text-[12px] text-muted-foreground">
              Registration token {server.pendingToken.tokenPrefix}… valid until {formatDateTime(server.pendingToken.expiresAt)}
            </p>
          )}
        </div>
        {can('OPERATOR') && (
          <div className="flex flex-wrap gap-2">
            {registered && (
              <>
                <Button variant="outline" onClick={() => ping.mutate()} loading={ping.isPending}>
                  <Radio /> Ping
                </Button>
                <Button variant="outline" onClick={() => sync.mutate()} loading={sync.isPending}>
                  <RefreshCw /> Sync config
                </Button>
              </>
            )}
            {canEnroll && (
              <Button onClick={async () => setRegistration(await token.mutateAsync())} loading={token.isPending}>
                <KeyRound /> New registration token
              </Button>
            )}
            {can('ADMIN') && registered && (
              <Confirm
                title="Revoke node credential?"
                description="The agent is disconnected immediately and can no longer authenticate. Nothing on the server is changed or deleted. You can re-enrol it later with a new registration token."
                confirmLabel="Revoke"
                destructive
                onConfirm={() => revoke.mutate()}
              >
                <Button variant="outline">
                  <Ban /> Revoke
                </Button>
              </Confirm>
            )}
            {can('ADMIN') && server.status !== 'DECOMMISSIONED' && (
              <Confirm
                title="Decommission server?"
                description="Access is revoked, backup jobs are archived and the server is hidden from lists. History is kept. Files and databases on the server are not touched."
                confirmLabel="Decommission"
                destructive
                onConfirm={async () => {
                  await decommission.mutateAsync();
                  navigate('/servers');
                }}
              >
                <Button variant="ghost" className="text-destructive">
                  <Trash2 /> Decommission
                </Button>
              </Confirm>
            )}
          </div>
        )}
      </div>

      <Tabs value={tab} onValueChange={(t) => setParams({ tab: t }, { replace: true })}>
        <TabsList>
          <TabsTrigger value="overview">
            <Gauge /> Overview
          </TabsTrigger>
          <TabsTrigger value="monitoring">
            <Activity /> Monitoring
          </TabsTrigger>
          <TabsTrigger value="backups">
            <Archive /> Backups
          </TabsTrigger>
          <TabsTrigger value="commands">
            <ListChecks /> Commands
          </TabsTrigger>
          {can('OPERATOR') && (
            <TabsTrigger value="settings">
              <Settings2 /> Settings
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="overview">
          <Overview server={server} />
        </TabsContent>
        <TabsContent value="monitoring">
          <ServerMonitoringTab server={server} />
        </TabsContent>
        <TabsContent value="backups">
          <ServerBackupsTab serverId={server.id} />
        </TabsContent>
        <TabsContent value="commands">
          <Card>
            <Commands id={server.id} />
          </Card>
        </TabsContent>
        <TabsContent value="settings">
          <SettingsForm server={server} />
        </TabsContent>
      </Tabs>

      <Dialog open={!!registration} onOpenChange={(o) => !o && setRegistration(null)}>
        <DialogContent wide>
          <DialogHeader>
            <DialogTitle>New registration token</DialogTitle>
          </DialogHeader>
          {registration && <RegistrationPanel info={registration} />}
          <DialogFooter>
            <Button onClick={() => setRegistration(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
