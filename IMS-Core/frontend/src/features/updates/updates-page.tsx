import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useForm } from 'react-hook-form';
import { useSearchParams } from 'react-router';
import { ArrowUpCircle, Ban, Check, CircleAlert, CircleCheck, CloudDownload, GitBranch, Loader2, PackageOpen, RefreshCw, Server as ServerIcon, ShieldCheck, Upload } from 'lucide-react';
import { Page, PageHeader, EmptyState, ErrorState, LoadingRows } from '@/components/common/page';
import { CommandStatusBadge } from '@/components/common/status';
import { Confirm } from '@/components/common/confirm';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { CoreUpdateInfo, CoreUpdateStatus } from '@/lib/types';
import { cn, formatBytes, formatDateTime, timeAgo } from '@/lib/utils';
import { useAuth } from '@/features/auth/use-auth';
import { useAgentFleet, useAgentReleases, useApplyCore, useCheckCore, useCoreUpdate, useGithubSource, useRevokeRelease, useRollout, useSaveGithub, useSyncReleases, useUploadRelease } from './api';

const STEPS = [
  ['prepare', 'Preflight checks'],
  ['fetch', 'Fetch release'],
  ['backup', 'Back up database & config'],
  ['checkout', 'Check out release'],
  ['build', 'Build images'],
  ['migrate', 'Database migrations'],
  ['restart', 'Restart services'],
  ['health', 'Health check'],
] as const;

const HISTORY_BADGE: Record<CoreUpdateStatus, ['success' | 'destructive' | 'warning' | 'default' | 'secondary', string]> = {
  REQUESTED: ['secondary', 'Requested'],
  RUNNING: ['default', 'Running'],
  SUCCEEDED: ['success', 'Succeeded'],
  FAILED: ['destructive', 'Failed'],
  ROLLED_BACK: ['warning', 'Rolled back'],
};

function Progress({ status }: { status: NonNullable<CoreUpdateInfo['status']> }) {
  const current = STEPS.findIndex(([k]) => k === status.step);
  const running = status.state === 'running' || status.state === 'queued';
  return (
    <ol className="grid gap-2" aria-label="Update progress">
      {STEPS.map(([key, label], i) => {
        const done = status.state === 'succeeded' || (current >= 0 && i < current);
        const active = running && i === current;
        return (
          <li key={key} className="flex items-center gap-3 text-sm">
            <span className={cn('flex size-6 items-center justify-center rounded-full border text-[11px]', done ? 'border-success bg-success/15 text-success' : active ? 'border-primary text-primary' : 'border-border text-muted-foreground')}>
              {done ? <Check className="size-3.5" /> : active ? <Loader2 className="size-3.5 animate-spin" /> : i + 1}
            </span>
            <span className={cn(done || active ? 'text-foreground' : 'text-muted-foreground')}>{label}</span>
          </li>
        );
      })}
      {status.step === 'rollback' && (
        <li className="flex items-center gap-3 text-sm text-warning">
          <span className="flex size-6 items-center justify-center rounded-full border border-warning">{running ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}</span>
          Rolling back to the previous version
        </li>
      )}
    </ol>
  );
}

function CorePanel() {
  const { can } = useAuth();
  const { data, isLoading, error, refetch } = useCoreUpdate();
  const check = useCheckCore();
  const apply = useApplyCore();

  if (isLoading) return <Card><LoadingRows /></Card>;
  if (error || !data) return <Card><ErrorState error={error} onRetry={() => refetch()} /></Card>;

  const running = data.requestPending || data.status?.state === 'running' || data.status?.state === 'queued';
  const lastFinished = data.status && ['succeeded', 'failed', 'rolled_back'].includes(data.status.state) ? data.status : null;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>IMS-Core</CardTitle>
            <CardDescription>
              {data.latestCheckedAt ? `Last checked ${timeAgo(data.latestCheckedAt)}` : 'Not checked yet'}
              {data.latestPublishedAt && ` · released ${formatDateTime(data.latestPublishedAt)}`}
            </CardDescription>
          </div>
          {data.updateAvailable ? <Badge variant="warning">Update available</Badge> : data.latestVersion ? <Badge variant="success">Up to date</Badge> : null}
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-[12px] text-muted-foreground">Installed</p>
              <p className="tabular text-2xl font-semibold">v{data.currentVersion}</p>
            </div>
            <div>
              <p className="text-[12px] text-muted-foreground">Latest release</p>
              <p className="tabular text-2xl font-semibold">{data.latestVersion ? `v${data.latestVersion}` : '—'}</p>
            </div>
          </div>
          {!data.repoConfigured && <p className="rounded-xl bg-muted px-3 py-2 text-[13px] text-muted-foreground">Set the Core repository in the “Release source” tab to check for updates.</p>}
          {!data.updaterInstalled && (
            <div className="rounded-xl border border-warning/40 bg-warning/10 px-3.5 py-3 text-[13px]">
              <p className="font-medium">Host updater not installed</p>
              <p className="mt-1 text-muted-foreground">
                Updates are applied by a small systemd service on the Core host (containers never get host access). Install it once with <code className="font-mono">sudo ./scripts/install-updater.sh</code> in the IMS-Core directory.
              </p>
            </div>
          )}
          {data.latestReleaseNotes && (
            <div className="grid gap-1.5">
              <span className="text-[12px] font-medium text-muted-foreground">Release notes</span>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-muted p-3 font-sans text-[13px] leading-relaxed">{data.latestReleaseNotes}</pre>
            </div>
          )}
        </CardContent>
        {can('ADMIN') && (
          <CardFooter className="justify-end gap-2">
            <Button variant="outline" onClick={() => check.mutate()} loading={check.isPending} disabled={!data.repoConfigured}>
              <RefreshCw /> Check for updates
            </Button>
            <Confirm
              title={`Install IMS-Core v${data.latestVersion}?`}
              description={
                <div className="grid gap-2">
                  <p>The updater backs up the database, secrets and configuration, installs the release, runs migrations and restarts the services. If the health check fails it restores the previous version automatically.</p>
                  <p>The dashboard is unavailable for a few minutes. Agents keep working and reconnect on their own.</p>
                </div>
              }
              confirmLabel="Install update"
              onConfirm={() => data.latestVersion && apply.mutate(data.latestVersion)}
            >
              <Button disabled={!data.updateAvailable || !data.updaterInstalled || running} loading={apply.isPending}>
                <ArrowUpCircle /> Install v{data.latestVersion ?? '…'}
              </Button>
            </Confirm>
          </CardFooter>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{running ? 'Update in progress' : 'Last update'}</CardTitle>
          <CardDescription>{data.status?.targetVersion ? `v${data.status.fromVersion ?? '?'} → v${data.status.targetVersion}` : 'No update has run yet'}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {running && !data.status?.step && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Waiting for the host updater…</p>}
          {data.status && data.status.state !== 'idle' && <Progress status={data.status} />}
          {lastFinished && (
            <p className={cn('rounded-xl px-3 py-2 text-[13px]', lastFinished.state === 'succeeded' ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive')}>
              {lastFinished.state === 'succeeded' ? <CircleCheck className="mr-1.5 inline size-4" /> : <CircleAlert className="mr-1.5 inline size-4" />}
              {lastFinished.message}
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-3">
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        {!data.history.length ? (
          <EmptyState icon={ArrowUpCircle} title="No updates yet" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Requested</TableHead>
                <TableHead>Finished</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.history.map((h) => (
                <TableRow key={h.id}>
                  <TableCell className="tabular whitespace-nowrap">
                    v{h.fromVersion} → v{h.toVersion}
                  </TableCell>
                  <TableCell>
                    <Badge variant={HISTORY_BADGE[h.status][0]}>{HISTORY_BADGE[h.status][1]}</Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(h.requestedAt)}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(h.finishedAt)}</TableCell>
                  <TableCell className="max-w-sm truncate text-[12px] text-muted-foreground" title={h.errorMessage ?? h.currentStep ?? ''}>
                    {h.errorMessage ?? h.currentStep ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function UploadDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const upload = useUploadRelease();
  const [file, setFile] = useState<File | null>(null);
  const [signature, setSignature] = useState('');
  const [notes, setNotes] = useState('');
  useEffect(() => {
    if (!open) {
      setFile(null);
      setSignature('');
      setNotes('');
    }
  }, [open]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    if (signature.trim()) form.append('signature', signature.trim());
    if (notes.trim()) form.append('releaseNotes', notes.trim());
    await upload.mutateAsync(form);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Upload agent package</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <Field id="rel-file" label="Package (.tgz)" hint="Built with `npm run package` in IMS-Agent. The version is read from its manifest.">
              <Input id="rel-file" type="file" accept=".tgz,application/gzip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
            </Field>
            <Field id="rel-sig" label="Signature (optional)" hint="Contents of the .sig file. Required by agents that pin a release key.">
              <Input id="rel-sig" className="font-mono" autoComplete="off" spellCheck={false} value={signature} onChange={(e) => setSignature(e.target.value)} />
            </Field>
            <Field id="rel-notes" label="Release notes (optional)">
              <Textarea id="rel-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={upload.isPending} disabled={!file}>
              <Upload /> Upload
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AgentsPanel() {
  const { can } = useAuth();
  const releases = useAgentReleases();
  const fleet = useAgentFleet();
  const sync = useSyncReleases();
  const revoke = useRevokeRelease();
  const rollout = useRollout();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const ubuntu = useMemo(() => fleet.data?.servers.filter((s) => s.type === 'UBUNTU') ?? [], [fleet.data]);
  const outdated = ubuntu.filter((s) => !s.upToDate);
  const latest = fleet.data?.latestVersion;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Agent fleet</CardTitle>
            <CardDescription>{latest ? `Latest release v${latest} · ${outdated.length} of ${ubuntu.length} Ubuntu agents need an update` : 'No agent release available yet'}</CardDescription>
          </div>
          {can('ADMIN') && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={!latest || !selected.size} loading={rollout.isPending} onClick={() => rollout.mutateAsync({ serverIds: [...selected] }).then(() => setSelected(new Set()))}>
                <ArrowUpCircle /> Update selected ({selected.size})
              </Button>
              <Confirm
                title={`Update ${outdated.length} agent(s) to v${latest}?`}
                description="Each agent downloads the release from Core, verifies its checksum (and signature, if pinned), restarts into it and rolls back automatically if it cannot reconnect."
                confirmLabel="Update all"
                onConfirm={() => rollout.mutate({ serverIds: outdated.map((s) => s.id) })}
              >
                <Button disabled={!latest || !outdated.length}>
                  <ArrowUpCircle /> Update all outdated
                </Button>
              </Confirm>
            </div>
          )}
        </CardHeader>
        {fleet.isLoading ? (
          <LoadingRows />
        ) : fleet.error ? (
          <ErrorState error={fleet.error} onRetry={() => fleet.refetch()} />
        ) : !fleet.data?.servers.length ? (
          <EmptyState icon={ServerIcon} title="No registered agents" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {can('ADMIN') && <TableHead className="w-10"><span className="sr-only">Select</span></TableHead>}
                <TableHead>Server</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Last update</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fleet.data.servers.map((s) => (
                <TableRow key={s.id}>
                  {can('ADMIN') && (
                    <TableCell>
                      {s.type === 'UBUNTU' && (
                        <input type="checkbox" className="size-4 accent-[var(--color-primary)]" checked={selected.has(s.id)} onChange={() => toggle(s.id)} aria-label={`Select ${s.name}`} />
                      )}
                    </TableCell>
                  )}
                  <TableCell>
                    <div className="font-medium">{s.name}</div>
                    <div className="text-[12px] text-muted-foreground">
                      {s.nodeId} · {s.type === 'UBUNTU' ? 'Ubuntu' : 'cPanel (manual update)'} · {s.status.toLowerCase()}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="tabular mr-2">{s.agentVersion ? `v${s.agentVersion}` : '—'}</span>
                    {s.upToDate ? <Badge variant="success">current</Badge> : latest && s.type === 'UBUNTU' ? <Badge variant="warning">outdated</Badge> : null}
                  </TableCell>
                  <TableCell>
                    {s.lastUpdate ? (
                      <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
                        <CommandStatusBadge status={s.lastUpdate.status} />
                        <span>
                          v{s.lastUpdate.payload.version} · {timeAgo(s.lastUpdate.createdAt)}
                        </span>
                        {s.lastUpdate.errorMessage && (
                          <span className="max-w-xs truncate text-destructive" title={s.lastUpdate.errorMessage}>
                            {s.lastUpdate.errorMessage}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-[12px] text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Agent releases</CardTitle>
            <CardDescription>Packages stored on this Core. Agents download them over their authenticated channel only.</CardDescription>
          </div>
          {can('ADMIN') && (
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => sync.mutate()} loading={sync.isPending}>
                <CloudDownload /> Sync from GitHub
              </Button>
              <Button onClick={() => setUploadOpen(true)}>
                <Upload /> Upload
              </Button>
            </div>
          )}
        </CardHeader>
        {releases.isLoading ? (
          <LoadingRows />
        ) : releases.error ? (
          <ErrorState error={releases.error} onRetry={() => releases.refetch()} />
        ) : !releases.data?.length ? (
          <EmptyState icon={PackageOpen} title="No agent releases" description="Upload a package built with `npm run package` or sync the latest GitHub release." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>SHA-256</TableHead>
                <TableHead>Added</TableHead>
                {can('ADMIN') && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {releases.data.map((r) => (
                <TableRow key={r.id} className={r.isRevoked ? 'opacity-60' : undefined}>
                  <TableCell>
                    <span className="tabular font-medium">v{r.version}</span>
                    <span className="ml-2 inline-flex gap-1">
                      {r.isLatest && <Badge variant="success">latest</Badge>}
                      {r.isRevoked && <Badge variant="destructive">revoked</Badge>}
                      {r.signature && (
                        <Badge variant="secondary">
                          <ShieldCheck className="size-3" /> signed
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.source === 'GITHUB' ? 'GitHub' : 'Upload'}</TableCell>
                  <TableCell className="tabular text-muted-foreground">{formatBytes(r.sizeBytes)}</TableCell>
                  <TableCell>
                    <code className="font-mono text-[12px] text-muted-foreground" title={r.sha256}>
                      {r.sha256.slice(0, 16)}…
                    </code>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{timeAgo(r.createdAt)}</TableCell>
                  {can('ADMIN') && (
                    <TableCell className="text-right">
                      {!r.isRevoked && (
                        <Confirm
                          title={`Revoke agent v${r.version}?`}
                          description="Agents can no longer download this release and it is no longer offered for installation. Agents already running it are not changed."
                          confirmLabel="Revoke"
                          destructive
                          onConfirm={() => revoke.mutate(r.version)}
                        >
                          <Button variant="ghost" size="sm" className="text-destructive">
                            <Ban /> Revoke
                          </Button>
                        </Confirm>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} />
    </div>
  );
}

function SourcePanel() {
  const { data, isLoading, error, refetch } = useGithubSource(true);
  const save = useSaveGithub();
  const [clearToken, setClearToken] = useState(false);
  const { register, handleSubmit, reset } = useForm<{ apiBase: string; coreRepo: string; agentRepo: string; token: string }>();
  useEffect(() => {
    if (data) reset({ apiBase: data.apiBase, coreRepo: data.coreRepo ?? '', agentRepo: data.agentRepo ?? '', token: '' });
  }, [data, reset]);

  if (isLoading) return <Card><LoadingRows /></Card>;
  if (error || !data) return <Card><ErrorState error={error} onRetry={() => refetch()} /></Card>;

  return (
    <Card className="max-w-3xl">
      <form
        onSubmit={handleSubmit((v) =>
          save.mutateAsync({
            apiBase: v.apiBase.trim(),
            coreRepo: v.coreRepo.trim() || null,
            agentRepo: v.agentRepo.trim() || null,
            ...(clearToken ? { token: null } : v.token.trim() ? { token: v.token.trim() } : {}),
          }).then(() => setClearToken(false)),
        )}
      >
        <CardHeader>
          <CardTitle>Release source</CardTitle>
          <CardDescription>Private GitHub repositories that publish IMS releases. Use a fine-grained token with read-only “Contents” access to these repositories.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field id="gh-core" label="Core repository" hint="owner/repository, releases tagged vX.Y.Z">
            <Input id="gh-core" placeholder="itwod/IMS-Core" {...register('coreRepo')} />
          </Field>
          <Field id="gh-agent" label="Agent repository" hint="Releases with asset ims-agent-X.Y.Z.tgz">
            <Input id="gh-agent" placeholder="itwod/IMS-Agent" {...register('agentRepo')} />
          </Field>
          <Field id="gh-token" label="Access token" hint={data.tokenConfigured ? 'A token is stored encrypted. Enter a new one to replace it.' : 'Required for private repositories.'} className="sm:col-span-2">
            <Input id="gh-token" type="password" autoComplete="off" spellCheck={false} className="font-mono" placeholder={data.tokenConfigured ? '••••••••••••' : 'github_pat_…'} {...register('token')} />
          </Field>
          {data.tokenConfigured && (
            <label className="flex items-center gap-2 text-[13px] text-muted-foreground sm:col-span-2">
              <input type="checkbox" checked={clearToken} onChange={(e) => setClearToken(e.target.checked)} /> Remove the stored token
            </label>
          )}
          <Field id="gh-api" label="API base URL" hint="Only change for GitHub Enterprise Server" className="sm:col-span-2">
            <Input id="gh-api" {...register('apiBase', { required: true })} />
          </Field>
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" loading={save.isPending}>
            Save
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

export default function UpdatesPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'core';
  return (
    <Page>
      <PageHeader title="Updates" description="Keep IMS-Core and every agent on the latest release. Every update is backed up, verified and rolled back automatically on failure." />
      <Tabs value={tab} onValueChange={(t) => setParams({ tab: t }, { replace: true })}>
        <TabsList>
          <TabsTrigger value="core">
            <ArrowUpCircle /> IMS-Core
          </TabsTrigger>
          <TabsTrigger value="agents">
            <ServerIcon /> Agents
          </TabsTrigger>
          {can('ADMIN') && (
            <TabsTrigger value="source">
              <GitBranch /> Release source
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="core">
          <CorePanel />
        </TabsContent>
        <TabsContent value="agents">
          <AgentsPanel />
        </TabsContent>
        {can('ADMIN') && (
          <TabsContent value="source">
            <SourcePanel />
          </TabsContent>
        )}
      </Tabs>
    </Page>
  );
}
