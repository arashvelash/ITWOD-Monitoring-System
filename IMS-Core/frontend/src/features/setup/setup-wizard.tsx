import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { useForm, type FieldPath } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, CircleAlert, Database, KeyRound, Lock, Send, ServerCog, ShieldCheck, UserRoundPlus } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { api, errorMessage, login } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { SetupStatus } from '@/lib/types';
import { AuthLayout } from '@/features/auth/auth-layout';
import { PasswordStrength } from '@/features/auth/password-strength';
import { Splash, useSetupStatus } from '@/features/auth/guards';

const schema = z
  .object({
    setupToken: z.string().trim().min(16, 'Paste the setup token from the backend logs'),
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9._-]{2,31}$/, '3-32 characters: letters, digits, dot, dash, underscore'),
    displayName: z.string().trim().max(128).optional(),
    email: z.union([z.literal(''), z.string().trim().email('Invalid e-mail')]).optional(),
    password: z.string().min(12, 'At least 12 characters').max(128),
    confirm: z.string(),
    instanceName: z.string().trim().min(1, 'Required').max(64),
    publicUrl: z.union([z.literal(''), z.string().url('Must be a full URL, e.g. https://itwodms.ir')]),
    timezone: z.string().min(1),
    sessionIdleHours: z.coerce.number().int().min(1).max(168),
    sessionAbsoluteDays: z.coerce.number().int().min(1).max(90),
    registrationTokenTtlHours: z.coerce.number().int().min(1).max(168),
    telegramEnabled: z.boolean(),
    telegramToken: z.union([z.literal(''), z.string().trim().regex(/^\d{5,16}:[A-Za-z0-9_-]{30,64}$/, 'Invalid bot token format')]),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' })
  .refine((v) => !v.telegramEnabled || v.telegramToken !== '', { path: ['telegramToken'], message: 'Enter the bot token or disable Telegram' });

type Values = z.input<typeof schema>;

const STEPS: { title: string; icon: typeof KeyRound; fields: FieldPath<Values>[] }[] = [
  { title: 'Setup token', icon: KeyRound, fields: ['setupToken'] },
  { title: 'System checks', icon: ServerCog, fields: [] },
  { title: 'Administrator', icon: UserRoundPlus, fields: ['username', 'displayName', 'email', 'password', 'confirm'] },
  { title: 'Instance', icon: Database, fields: ['instanceName', 'publicUrl', 'timezone'] },
  { title: 'Security', icon: Lock, fields: ['sessionIdleHours', 'sessionAbsoluteDays', 'registrationTokenTtlHours'] },
  { title: 'Telegram', icon: Send, fields: ['telegramEnabled', 'telegramToken'] },
];

function CheckRow({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-xl border border-border/70 px-4 py-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {detail && <p className="text-[12px] text-muted-foreground">{detail}</p>}
      </div>
      {ok ? <CheckCircle2 className="size-5 text-success" aria-label="OK" /> : <CircleAlert className="size-5 text-warning" aria-label="Needs attention" />}
    </li>
  );
}

function SystemChecks({ status }: { status: SetupStatus }) {
  const c = status.checks;
  if (!c) return null;
  return (
    <ul className="grid gap-2">
      <CheckRow label="PostgreSQL database" ok={c.database.ok} detail={c.database.ok ? 'Connected' : c.database.error} />
      <CheckRow label="Database migrations" ok={c.migrations.ok} detail={`${c.migrations.applied ?? 0} applied`} />
      <CheckRow label="Redis" ok={c.redis.ok} detail={c.redis.ok ? 'Connected' : c.redis.error} />
      <CheckRow label="Master encryption key" ok={c.masterKey.ok} detail={`Fingerprint ${c.masterKey.fingerprint}`} />
      <CheckRow label="JWT signing secret" ok={c.jwtSecret.ok} detail={`${c.jwtSecret.length} characters`} />
      <CheckRow label="Secure cookies (HTTPS)" ok={c.https.ok} detail={c.https.publicUrl ?? 'Public URL not configured in .env'} />
    </ul>
  );
}

export default function SetupWizard() {
  const setup = useSetupStatus();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const form = useForm<Values, any, z.output<typeof schema>>({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    defaultValues: {
      setupToken: '',
      username: 'admin',
      displayName: '',
      email: '',
      password: '',
      confirm: '',
      instanceName: 'ITWOD Monitoring System',
      publicUrl: window.location.origin.startsWith('https://') ? window.location.origin : '',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      sessionIdleHours: 12,
      sessionAbsoluteDays: 7,
      registrationTokenTtlHours: 24,
      telegramEnabled: false,
      telegramToken: '',
    },
  });
  const { register, formState, watch, setValue, trigger, handleSubmit } = form;
  const errors = formState.errors;

  if (setup.isLoading) return <Splash />;
  if (setup.data?.initialized) return <Navigate to="/login" replace />;

  const last = step === STEPS.length - 1;
  const checksOk = Boolean(setup.data?.checks?.database.ok && setup.data.checks.redis.ok && setup.data.checks.migrations.ok);

  const next = async () => {
    const ok = await trigger(STEPS[step].fields);
    if (!ok) return;
    if (step === 1 && !checksOk) {
      toast.error('Resolve the failing system checks first.');
      return;
    }
    setDirection(1);
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };
  const back = () => {
    setDirection(-1);
    setStep((s) => Math.max(s - 1, 0));
  };

  const submit = handleSubmit(async (v) => {
    try {
      await api.post('/setup/initialize', {
        setupToken: v.setupToken,
        admin: { username: v.username, password: v.password, ...(v.displayName ? { displayName: v.displayName } : {}), ...(v.email ? { email: v.email } : {}) },
        instance: { name: v.instanceName, timezone: v.timezone, ...(v.publicUrl ? { publicUrl: v.publicUrl } : {}) },
        security: { sessionIdleHours: Number(v.sessionIdleHours), sessionAbsoluteDays: Number(v.sessionAbsoluteDays), registrationTokenTtlHours: Number(v.registrationTokenTtlHours) },
        telegram: { enabled: v.telegramEnabled, ...(v.telegramToken ? { botToken: v.telegramToken } : {}) },
      });
      await queryClient.invalidateQueries({ queryKey: ['setup-status'] });
      await login(v.username.trim().toLowerCase(), v.password);
      toast.success('IMS is ready. Welcome!');
      navigate('/', { replace: true });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  });

  return (
    <AuthLayout wide>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Welcome to IMS</h1>
        <p className="mt-1 text-sm text-muted-foreground">Let's secure and configure this Core instance. This wizard runs only once.</p>
      </div>

      <ol className="mb-8 flex items-center gap-1.5" aria-label="Setup progress">
        {STEPS.map((s, i) => (
          <li key={s.title} className="flex flex-1 flex-col gap-2">
            <div className={cn('h-1 rounded-full transition-colors duration-300', i <= step ? 'bg-primary' : 'bg-muted')} />
            <span className={cn('hidden text-[11px] sm:block', i === step ? 'font-medium text-foreground' : 'text-muted-foreground')} aria-current={i === step ? 'step' : undefined}>
              {s.title}
            </span>
          </li>
        ))}
      </ol>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (last) void submit();
          else void next();
        }}
        noValidate
      >
        <div className="relative min-h-[300px]">
          <AnimatePresence mode="wait" custom={direction}>
            <motion.div
              key={step}
              custom={direction}
              initial={{ opacity: 0, x: direction * 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: direction * -24 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="grid gap-4"
            >
              {step === 0 && (
                <>
                  <p className="text-sm text-muted-foreground">
                    A one-time setup token protects this wizard from being claimed by anyone else. Retrieve it on the Core server:
                  </p>
                  <pre className="overflow-x-auto rounded-xl bg-muted px-4 py-3 font-mono text-[12.5px]">docker compose exec backend cat /run/ims-secrets/setup_token</pre>
                  <Field id="setupToken" label="Setup token" error={errors.setupToken?.message}>
                    <Input id="setupToken" autoComplete="off" spellCheck={false} className="font-mono" {...register('setupToken')} />
                  </Field>
                </>
              )}

              {step === 1 && setup.data && (
                <>
                  <p className="text-sm text-muted-foreground">
                    Database, Redis and security keys were provisioned automatically by the installer. Infrastructure secrets are stored outside the database and cannot be changed from the browser.
                  </p>
                  <SystemChecks status={setup.data} />
                  <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => setup.refetch()} loading={setup.isFetching}>
                    Re-run checks
                  </Button>
                </>
              )}

              {step === 2 && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id="username" label="Username" error={errors.username?.message}>
                    <Input id="username" autoComplete="username" {...register('username')} />
                  </Field>
                  <Field id="displayName" label="Display name (optional)" error={errors.displayName?.message}>
                    <Input id="displayName" autoComplete="name" {...register('displayName')} />
                  </Field>
                  <Field id="email" label="E-mail (optional)" error={errors.email?.message} className="sm:col-span-2">
                    <Input id="email" type="email" autoComplete="email" {...register('email')} />
                  </Field>
                  <Field id="password" label="Password" error={errors.password?.message} hint="12+ characters. A passphrase works best.">
                    <Input id="password" type="password" autoComplete="new-password" {...register('password')} />
                  </Field>
                  <Field id="confirm" label="Confirm password" error={errors.confirm?.message}>
                    <Input id="confirm" type="password" autoComplete="new-password" {...register('confirm')} />
                  </Field>
                  <div className="sm:col-span-2">
                    <PasswordStrength password={watch('password') ?? ''} />
                  </div>
                </div>
              )}

              {step === 3 && (
                <>
                  <Field id="instanceName" label="Instance name" error={errors.instanceName?.message}>
                    <Input id="instanceName" {...register('instanceName')} />
                  </Field>
                  <Field id="publicUrl" label="Public URL" error={errors.publicUrl?.message} hint="Used for the agent install command, e.g. https://itwodms.ir">
                    <Input id="publicUrl" placeholder="https://itwodms.ir" {...register('publicUrl')} />
                  </Field>
                  <Field id="timezone" label="Default time zone" error={errors.timezone?.message} hint="Default for new backup schedules (IANA name, e.g. Asia/Tehran).">
                    <Input id="timezone" {...register('timezone')} />
                  </Field>
                </>
              )}

              {step === 4 && (
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field id="sessionIdleHours" label="Idle timeout (hours)" error={errors.sessionIdleHours?.message}>
                    <Input id="sessionIdleHours" type="number" min={1} max={168} {...register('sessionIdleHours')} />
                  </Field>
                  <Field id="sessionAbsoluteDays" label="Max session (days)" error={errors.sessionAbsoluteDays?.message}>
                    <Input id="sessionAbsoluteDays" type="number" min={1} max={90} {...register('sessionAbsoluteDays')} />
                  </Field>
                  <Field id="registrationTokenTtlHours" label="Node token TTL (hours)" error={errors.registrationTokenTtlHours?.message}>
                    <Input id="registrationTokenTtlHours" type="number" min={1} max={168} {...register('registrationTokenTtlHours')} />
                  </Field>
                  <div className="flex items-start gap-3 rounded-xl bg-muted/60 p-4 text-sm text-muted-foreground sm:col-span-3">
                    <ShieldCheck className="mt-0.5 size-5 shrink-0 text-success" />
                    Passwords use Argon2id, sessions rotate refresh tokens on every use, and accounts lock after repeated failed sign-ins.
                  </div>
                </div>
              )}

              {step === 5 && (
                <>
                  <label className="flex items-center justify-between gap-4 rounded-xl border border-border/70 px-4 py-3">
                    <span>
                      <span className="block text-sm font-medium">Enable Telegram bot</span>
                      <span className="block text-[12px] text-muted-foreground">Status queries, alerts and backup notifications. You can configure this later.</span>
                    </span>
                    <Switch checked={watch('telegramEnabled')} onCheckedChange={(v) => setValue('telegramEnabled', v, { shouldValidate: true })} aria-label="Enable Telegram bot" />
                  </label>
                  {watch('telegramEnabled') && (
                    <Field id="telegramToken" label="Bot token (from @BotFather)" error={errors.telegramToken?.message} hint="Stored encrypted. Never shown again.">
                      <Input id="telegramToken" autoComplete="off" spellCheck={false} className="font-mono" {...register('telegramToken')} />
                    </Field>
                  )}
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="mt-8 flex items-center justify-between gap-3">
          <Button type="button" variant="ghost" onClick={back} disabled={step === 0}>
            <ArrowLeft /> Back
          </Button>
          {last ? (
            <Button type="submit" loading={formState.isSubmitting}>
              <Check /> Finish setup
            </Button>
          ) : (
            <Button type="submit">
              Continue <ArrowRight />
            </Button>
          )}
        </div>
      </form>
    </AuthLayout>
  );
}
