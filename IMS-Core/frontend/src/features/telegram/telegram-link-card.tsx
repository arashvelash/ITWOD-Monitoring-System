import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, BellRing, Link2, Send, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import { SecretField } from '@/components/common/copy-button';
import { EmptyState } from '@/components/common/page';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { api, errorMessage } from '@/lib/api';
import type { TelegramLink } from '@/lib/types';
import { formatDateTime, timeAgo } from '@/lib/utils';

/** Lets any user link their own Telegram chat (Account › Telegram). */
export function TelegramLinkCard() {
  const qc = useQueryClient();
  const { data: links } = useQuery({ queryKey: ['telegram-links'], queryFn: () => api.get<TelegramLink[]>('/telegram/links') });
  const code = useMutation({
    mutationFn: () => api.post<{ code: string; expiresAt: string; botUsername: string | null }>('/telegram/link-code'),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const update = useMutation({
    mutationFn: ({ id, notificationsEnabled }: { id: string; notificationsEnabled: boolean }) => api.patch(`/telegram/links/${id}`, { notificationsEnabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['telegram-links'] }),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/telegram/links/${id}`),
    onSuccess: () => {
      toast.success('Telegram chat unlinked');
      void qc.invalidateQueries({ queryKey: ['telegram-links'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Telegram</CardTitle>
        <CardDescription>Link your Telegram account to receive notifications and query IMS from the bot.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {code.data ? (
          <div className="grid gap-3 rounded-xl bg-muted/50 p-4">
            <p className="text-sm">
              Open {code.data.botUsername ? <strong>@{code.data.botUsername}</strong> : 'the IMS bot'} in Telegram and send this message within 10 minutes (valid until {formatDateTime(code.data.expiresAt)}):
            </p>
            <SecretField label="Message" value={`/link ${code.data.code}`} />
          </div>
        ) : (
          <Button className="justify-self-start" onClick={() => code.mutate()} loading={code.isPending}>
            <Link2 /> Generate link code
          </Button>
        )}

        {!links?.length ? (
          <EmptyState icon={Send} title="No linked chats" description="Linked chats appear here." />
        ) : (
          <ul className="divide-y divide-border/60">
            {links.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-sm font-medium">{l.telegramUsername ? `@${l.telegramUsername}` : `Chat ${l.chatId}`}</p>
                  <p className="text-[12px] text-muted-foreground">
                    {l.user?.username ? `${l.user.username} · ` : ''}linked {timeAgo(l.linkedAt)}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
                    {l.notificationsEnabled ? <BellRing className="size-4" /> : <BellOff className="size-4" />}
                    <Switch checked={l.notificationsEnabled} onCheckedChange={(v) => update.mutate({ id: l.id, notificationsEnabled: v })} aria-label="Notifications" />
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => remove.mutate(l.id)}>
                    <Unlink /> Unlink
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
