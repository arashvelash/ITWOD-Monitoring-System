import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Laptop, LogOut, Send, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { Page, PageHeader, ErrorState, LoadingRows } from '@/components/common/page';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage } from '@/lib/api';
import type { SessionInfo } from '@/lib/types';
import { formatDateTime, timeAgo } from '@/lib/utils';
import { ChangePasswordForm } from '@/features/auth/password-form';
import { useAuth } from '@/features/auth/use-auth';
import { TelegramLinkCard } from '@/features/telegram/telegram-link-card';

function describeAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  return `${browser} on ${os}`;
}

function Sessions() {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['sessions'], queryFn: () => api.get<SessionInfo[]>('/auth/sessions') });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/sessions/${id}`),
    onSuccess: () => {
      toast.success('Session signed out');
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (isLoading) return <LoadingRows rows={2} />;
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  return (
    <ul className="divide-y divide-border/60">
      {data?.map((s) => (
        <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-xl bg-muted">
              <Laptop className="size-4 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium">
                {describeAgent(s.userAgent)} {s.current && <Badge variant="success">this device</Badge>}
              </p>
              <p className="text-[12px] text-muted-foreground">
                {s.ipAddress ?? 'unknown IP'} · active {timeAgo(s.lastUsedAt)} · expires {formatDateTime(s.absoluteExpiresAt)}
              </p>
            </div>
          </div>
          {!s.current && (
            <Button variant="outline" size="sm" onClick={() => revoke.mutate(s.id)} loading={revoke.isPending && revoke.variables === s.id}>
              <LogOut /> Sign out
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function AccountPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'profile';
  return (
    <Page className="max-w-3xl">
      <PageHeader title="Account" description="Your profile, password and active sessions." />
      <Tabs value={tab} onValueChange={(t) => setParams({ tab: t }, { replace: true })}>
        <TabsList>
          <TabsTrigger value="profile">
            <UserRound /> Profile
          </TabsTrigger>
          <TabsTrigger value="password">
            <KeyRound /> Password
          </TabsTrigger>
          <TabsTrigger value="sessions">
            <Laptop /> Sessions
          </TabsTrigger>
          <TabsTrigger value="telegram">
            <Send /> Telegram
          </TabsTrigger>
        </TabsList>
        <TabsContent value="telegram">
          <TelegramLinkCard />
        </TabsContent>
        <TabsContent value="profile">
          <Card>
            <CardContent className="grid gap-4 pt-5 sm:grid-cols-2">
              {[
                ['Username', user?.username],
                ['Display name', user?.displayName ?? '—'],
                ['E-mail', user?.email ?? '—'],
                ['Role', user?.role.toLowerCase()],
                ['Last sign-in', formatDateTime(user?.lastLoginAt)],
                ['Member since', formatDateTime(user?.createdAt)],
              ].map(([k, v]) => (
                <div key={k}>
                  <p className="text-[12px] text-muted-foreground">{k}</p>
                  <p className="mt-0.5 text-sm font-medium">{v}</p>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="password">
          <Card>
            <CardHeader>
              <CardTitle>Change password</CardTitle>
              <CardDescription>Other sessions are signed out automatically.</CardDescription>
            </CardHeader>
            <CardContent>
              <ChangePasswordForm />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="sessions">
          <Card>
            <CardHeader>
              <CardTitle>Active sessions</CardTitle>
              <CardDescription>Sign out devices you don't recognise.</CardDescription>
            </CardHeader>
            <CardContent>
              <Sessions />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </Page>
  );
}
