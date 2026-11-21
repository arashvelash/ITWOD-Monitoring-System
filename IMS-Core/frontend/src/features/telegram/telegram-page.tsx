import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, CircleAlert, CircleCheck, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Page, PageHeader, ErrorState, LoadingRows } from '@/components/common/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field, Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { api, errorMessage } from '@/lib/api';
import type { TelegramStatus } from '@/lib/types';
import { TelegramLinkCard } from './telegram-link-card';

interface Status extends TelegramStatus {
  notifyAlerts: boolean;
  notifyBackupSuccess: boolean;
  notifyBackupFailure: boolean;
  notifyNodeStatus: boolean;
  broadcastChatIds: string[];
}

interface Values {
  enabled: boolean;
  botToken: string;
  notifyAlerts: boolean;
  notifyBackupSuccess: boolean;
  notifyBackupFailure: boolean;
  notifyNodeStatus: boolean;
  broadcastChatIds: string;
}

const TOGGLES: { key: keyof Values; label: string; hint: string }[] = [
  { key: 'notifyAlerts', label: 'Alerts', hint: 'Opened and resolved alerts (CPU, memory, disk, services, missed backups)' },
  { key: 'notifyBackupFailure', label: 'Failed backups', hint: 'Every failed or timed out backup run' },
  { key: 'notifyBackupSuccess', label: 'Successful backups', hint: 'Can be noisy with many jobs' },
  { key: 'notifyNodeStatus', label: 'Server online / offline', hint: 'When an agent stops reporting or comes back' },
];

export default function TelegramPage() {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['telegram-status'], queryFn: () => api.get<Status>('/telegram/status'), refetchInterval: 15_000 });
  const { register, handleSubmit, reset, watch, setValue } = useForm<Values>();
  const [clearToken, setClearToken] = useState(false);

  useEffect(() => {
    if (data)
      reset({
        enabled: data.enabled,
        botToken: '',
        notifyAlerts: data.notifyAlerts,
        notifyBackupSuccess: data.notifyBackupSuccess,
        notifyBackupFailure: data.notifyBackupFailure,
        notifyNodeStatus: data.notifyNodeStatus,
        broadcastChatIds: data.broadcastChatIds.join(', '),
      });
  }, [data, reset]);

  const save = useMutation({
    mutationFn: (v: Values) =>
      api.put('/telegram/config', {
        enabled: v.enabled,
        notifyAlerts: v.notifyAlerts,
        notifyBackupSuccess: v.notifyBackupSuccess,
        notifyBackupFailure: v.notifyBackupFailure,
        notifyNodeStatus: v.notifyNodeStatus,
        broadcastChatIds: v.broadcastChatIds
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        ...(clearToken ? { botToken: null } : v.botToken.trim() ? { botToken: v.botToken.trim() } : {}),
      }),
    onSuccess: () => {
      toast.success('Telegram settings saved');
      setClearToken(false);
      void qc.invalidateQueries({ queryKey: ['telegram-status'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ sent: number }>('/telegram/test'),
    onSuccess: (r) => toast.success(`Test message sent to ${r.sent} chat(s)`),
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Page className="max-w-4xl">
      <PageHeader title="Telegram" description="Bot for notifications and read-only status queries. Operators can also start backups." />
      {isLoading ? (
        <Card>
          <LoadingRows />
        </Card>
      ) : error || !data ? (
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      ) : (
        <div className="grid gap-6">
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-5">
              <div className="flex items-center gap-3">
                <div className="flex size-11 items-center justify-center rounded-2xl bg-[#229ED9]/15">
                  <Bot className="size-5 text-[#229ED9]" />
                </div>
                <div>
                  <p className="font-medium">{data.bot ? `@${data.bot.username}` : 'Bot not connected'}</p>
                  <p className="text-[12px] text-muted-foreground">{data.tokenConfigured ? 'Token stored encrypted' : 'No token configured'}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {data.running ? (
                  <Badge variant="success">
                    <CircleCheck className="size-3.5" /> Polling
                  </Badge>
                ) : (
                  <Badge variant={data.enabled ? 'warning' : 'secondary'}>
                    <CircleAlert className="size-3.5" /> {data.enabled ? 'Not running' : 'Disabled'}
                  </Badge>
                )}
                <Button variant="outline" size="sm" onClick={() => test.mutate()} loading={test.isPending} disabled={!data.tokenConfigured}>
                  <Send /> Send test
                </Button>
              </div>
            </CardContent>
            {data.lastError && <p className="mx-5 mb-5 rounded-xl bg-destructive/10 px-3 py-2 text-[13px] text-destructive">{data.lastError}</p>}
          </Card>

          <Card>
            <form onSubmit={handleSubmit((v) => save.mutate(v))}>
              <CardHeader>
                <CardTitle>Configuration</CardTitle>
                <CardDescription>Create a bot with @BotFather and paste its token. The bot uses long polling, no inbound webhook is required.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-5">
                <div className="flex items-center justify-between rounded-xl border border-border/70 px-4 py-3">
                  <Label htmlFor="tg-enabled">Enable bot</Label>
                  <Switch id="tg-enabled" checked={watch('enabled')} onCheckedChange={(c) => setValue('enabled', c)} />
                </div>
                <Field id="tg-token" label="Bot token" hint={data.tokenConfigured ? 'A token is stored. Enter a new one to replace it.' : 'Format 123456:ABC-…'}>
                  <Input id="tg-token" autoComplete="off" spellCheck={false} className="font-mono" placeholder={data.tokenConfigured ? '••••••••••••' : ''} {...register('botToken')} />
                </Field>
                {data.tokenConfigured && (
                  <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
                    <input type="checkbox" checked={clearToken} onChange={(e) => setClearToken(e.target.checked)} /> Remove the stored token
                  </label>
                )}
                <div className="grid gap-2">
                  <p className="text-sm font-medium">Notify about</p>
                  {TOGGLES.map((t) => (
                    <label key={t.key} className="flex items-center justify-between gap-4 rounded-xl border border-border/70 px-4 py-3">
                      <span>
                        <span className="block text-sm">{t.label}</span>
                        <span className="block text-[12px] text-muted-foreground">{t.hint}</span>
                      </span>
                      <Switch checked={Boolean(watch(t.key))} onCheckedChange={(c) => setValue(t.key, c as never)} aria-label={t.label} />
                    </label>
                  ))}
                </div>
                <Field id="tg-broadcast" label="Additional notification chats (optional)" hint="Chat IDs of groups/channels that only receive notifications, comma separated. Commands from them are ignored.">
                  <Input id="tg-broadcast" placeholder="-1001234567890" {...register('broadcastChatIds')} />
                </Field>
              </CardContent>
              <CardFooter className="justify-end">
                <Button type="submit" loading={save.isPending}>
                  Save
                </Button>
              </CardFooter>
            </form>
          </Card>

          <TelegramLinkCard />
        </div>
      )}
    </Page>
  );
}
