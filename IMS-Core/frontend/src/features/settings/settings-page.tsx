import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { Activity, Globe, Lock } from 'lucide-react';
import { Page, PageHeader, ErrorState, LoadingRows } from '@/components/common/page';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { Settings } from '@/lib/types';
import { useSettings, useUpdateSettings } from './use-settings';

function GeneralForm({ value }: { value: Settings['general'] }) {
  const save = useUpdateSettings('general');
  const { register, handleSubmit, reset } = useForm<{ instanceName: string; publicUrl: string; timezone: string }>();
  useEffect(() => reset({ instanceName: value.instanceName, publicUrl: value.publicUrl ?? '', timezone: value.timezone }), [value, reset]);
  return (
    <form onSubmit={handleSubmit((v) => save.mutate({ instanceName: v.instanceName, publicUrl: v.publicUrl || null, timezone: v.timezone }))}>
      <CardContent className="grid gap-4 pt-5">
        <Field id="instanceName" label="Instance name">
          <Input id="instanceName" {...register('instanceName', { required: true })} />
        </Field>
        <Field id="publicUrl" label="Public URL" hint="Shown in agent install commands and used for origin checks.">
          <Input id="publicUrl" placeholder="https://itwodms.ir" {...register('publicUrl')} />
        </Field>
        <Field id="timezone" label="Default time zone" hint="IANA name, e.g. Asia/Tehran">
          <Input id="timezone" {...register('timezone', { required: true })} />
        </Field>
      </CardContent>
      <CardFooter className="justify-end">
        <Button type="submit" loading={save.isPending}>
          Save
        </Button>
      </CardFooter>
    </form>
  );
}

function NumberField({ id, label, hint, register, min, max, step }: { id: string; label: string; hint?: string; register: ReturnType<typeof useForm>['register']; min: number; max: number; step?: number }) {
  return (
    <Field id={id} label={label} hint={hint}>
      <Input id={id} type="number" min={min} max={max} step={step ?? 1} {...register(id, { valueAsNumber: true, min, max })} />
    </Field>
  );
}

function SecurityForm({ value }: { value: Settings['security'] }) {
  const save = useUpdateSettings('security');
  const form = useForm();
  useEffect(() => form.reset(value), [value, form]);
  return (
    <form onSubmit={form.handleSubmit((v) => save.mutate(v as Settings['security']))}>
      <CardContent className="grid gap-4 pt-5 sm:grid-cols-2">
        <NumberField id="sessionIdleHours" label="Session idle timeout (hours)" register={form.register} min={1} max={168} />
        <NumberField id="sessionAbsoluteDays" label="Maximum session lifetime (days)" register={form.register} min={1} max={90} />
        <NumberField id="maxFailedLogins" label="Failed sign-ins before lockout" register={form.register} min={3} max={20} />
        <NumberField id="lockoutMinutes" label="Lockout duration (minutes)" register={form.register} min={1} max={1440} />
        <NumberField id="registrationTokenTtlHours" label="Node registration token lifetime (hours)" register={form.register} min={1} max={168} />
      </CardContent>
      <CardFooter className="justify-end">
        <Button type="submit" loading={save.isPending}>
          Save
        </Button>
      </CardFooter>
    </form>
  );
}

function MonitoringForm({ value }: { value: Settings['monitoring'] }) {
  const save = useUpdateSettings('monitoring');
  const form = useForm();
  useEffect(() => form.reset({ ...value, defaultServices: value.defaultServices.join(', ') }), [value, form]);
  return (
    <form
      onSubmit={form.handleSubmit((v) =>
        save.mutate({
          ...(v as Settings['monitoring']),
          defaultServices: String(v.defaultServices ?? '')
            .split(/[\s,]+/)
            .filter(Boolean),
        }),
      )}
    >
      <CardContent className="grid gap-4 pt-5 sm:grid-cols-2">
        <NumberField id="cpuPercent" label="CPU alert threshold (%)" register={form.register} min={10} max={100} />
        <NumberField id="cpuSustainMinutes" label="CPU must stay high for (minutes)" register={form.register} min={1} max={60} />
        <NumberField id="memoryPercent" label="Memory alert threshold (%)" register={form.register} min={10} max={100} />
        <NumberField id="diskPercent" label="Disk alert threshold (%)" register={form.register} min={10} max={100} />
        <NumberField id="offlineAfterSec" label="Mark node offline after (seconds)" register={form.register} min={60} max={3600} />
        <NumberField id="backupMissedGraceMinutes" label="Missed backup grace (minutes)" register={form.register} min={10} max={1440} />
        <NumberField id="metricsRetentionDays" label="Keep metrics for (days)" register={form.register} min={1} max={365} />
        <Field id="defaultServices" label="Default services to watch" hint="Comma separated systemd units, e.g. nginx, mysql">
          <Input id="defaultServices" {...form.register('defaultServices')} />
        </Field>
      </CardContent>
      <CardFooter className="justify-end">
        <Button type="submit" loading={save.isPending}>
          Save
        </Button>
      </CardFooter>
    </form>
  );
}

export default function SettingsPage() {
  const { data, isLoading, error, refetch } = useSettings();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'general';
  return (
    <Page className="max-w-4xl">
      <PageHeader title="Settings" description="Instance-wide configuration. Infrastructure secrets are managed on the server, not here." />
      {isLoading ? (
        <Card>
          <LoadingRows />
        </Card>
      ) : error || !data ? (
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      ) : (
        <Tabs value={tab} onValueChange={(t) => setParams({ tab: t }, { replace: true })}>
          <TabsList>
            <TabsTrigger value="general">
              <Globe /> General
            </TabsTrigger>
            <TabsTrigger value="security">
              <Lock /> Security
            </TabsTrigger>
            <TabsTrigger value="monitoring">
              <Activity /> Monitoring
            </TabsTrigger>
          </TabsList>
          <TabsContent value="general">
            <Card>
              <CardHeader>
                <CardTitle>General</CardTitle>
                <CardDescription>How this instance identifies itself.</CardDescription>
              </CardHeader>
              <GeneralForm value={data.general} />
            </Card>
          </TabsContent>
          <TabsContent value="security">
            <Card>
              <CardHeader>
                <CardTitle>Sessions & sign-in</CardTitle>
                <CardDescription>Applies to new sessions and tokens.</CardDescription>
              </CardHeader>
              <SecurityForm value={data.security} />
            </Card>
          </TabsContent>
          <TabsContent value="monitoring">
            <Card>
              <CardHeader>
                <CardTitle>Monitoring & alerts</CardTitle>
                <CardDescription>Thresholds used by the alert engine for all servers.</CardDescription>
              </CardHeader>
              <MonitoringForm value={data.monitoring} />
            </Card>
          </TabsContent>
        </Tabs>
      )}
    </Page>
  );
}
