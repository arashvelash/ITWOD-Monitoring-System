import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { LogIn } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { errorMessage, login } from '@/lib/api';
import { AuthLayout } from './auth-layout';
import { useAuth } from './use-auth';
import { useSetupStatus } from './guards';

const schema = z.object({
  username: z.string().trim().min(1, 'Enter your username'),
  password: z.string().min(1, 'Enter your password'),
});
type FormValues = z.infer<typeof schema>;

/** Only allow same-app relative redirects (prevents open redirects). */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export default function LoginPage() {
  const { status } = useAuth();
  const setup = useSetupStatus();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState } = useForm<FormValues>({ resolver: zodResolver(schema) });

  if (setup.data && !setup.data.initialized) return <Navigate to="/setup" replace />;
  if (status === 'authenticated') return <Navigate to={safeNext(params.get('next'))} replace />;

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      const res = await login(values.username, values.password);
      navigate(res.user.mustChangePassword ? '/change-password' : safeNext(params.get('next')), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  return (
    <AuthLayout>
      <h1 className="text-xl font-semibold">Sign in</h1>
      <p className="mt-1 text-sm text-muted-foreground">Use your IMS account to continue.</p>
      <form onSubmit={onSubmit} className="mt-6 grid gap-4" noValidate>
        <Field id="username" label="Username" error={formState.errors.username?.message}>
          <Input id="username" autoComplete="username" autoFocus aria-invalid={!!formState.errors.username} {...register('username')} />
        </Field>
        <Field id="password" label="Password" error={formState.errors.password?.message}>
          <Input id="password" type="password" autoComplete="current-password" aria-invalid={!!formState.errors.password} {...register('password')} />
        </Field>
        {error && (
          <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" loading={formState.isSubmitting} className="mt-2 w-full">
          <LogIn /> Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
