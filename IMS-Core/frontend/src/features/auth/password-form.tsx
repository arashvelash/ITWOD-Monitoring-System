import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { api, errorMessage } from '@/lib/api';
import { PasswordStrength } from './password-strength';

const schema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: z.string().min(12, 'At least 12 characters').max(128, 'At most 128 characters'),
    confirm: z.string(),
  })
  .refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });

type FormValues = z.infer<typeof schema>;

export function ChangePasswordForm({ onDone }: { onDone?: () => void }) {
  const { register, handleSubmit, formState, watch, reset } = useForm<FormValues>({ resolver: zodResolver(schema) });
  const onSubmit = handleSubmit(async ({ currentPassword, newPassword }) => {
    try {
      await api.post('/auth/change-password', { currentPassword, newPassword });
      toast.success('Password changed. Other sessions were signed out.');
      reset();
      onDone?.();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  });

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <Field id="currentPassword" label="Current password" error={formState.errors.currentPassword?.message}>
        <Input id="currentPassword" type="password" autoComplete="current-password" {...register('currentPassword')} />
      </Field>
      <Field id="newPassword" label="New password" error={formState.errors.newPassword?.message} hint="Use a long passphrase (12+ characters).">
        <Input id="newPassword" type="password" autoComplete="new-password" {...register('newPassword')} />
      </Field>
      <PasswordStrength password={watch('newPassword') ?? ''} />
      <Field id="confirm" label="Confirm new password" error={formState.errors.confirm?.message}>
        <Input id="confirm" type="password" autoComplete="new-password" {...register('confirm')} />
      </Field>
      <Button type="submit" loading={formState.isSubmitting} className="justify-self-start">
        Update password
      </Button>
    </form>
  );
}
