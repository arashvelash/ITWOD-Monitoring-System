import { Navigate, useNavigate } from 'react-router';
import { api } from '@/lib/api';
import { authStore } from '@/lib/auth-store';
import type { User } from '@/lib/types';
import { AuthLayout } from './auth-layout';
import { ChangePasswordForm } from './password-form';
import { useAuth } from './use-auth';
import { Splash } from './guards';

/** Forced password change after an admin reset or first login with a temporary password. */
export default function ChangePasswordPage() {
  const { status, user } = useAuth();
  const navigate = useNavigate();
  if (status === 'loading') return <Splash />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  if (!user?.mustChangePassword) return <Navigate to="/" replace />;

  return (
    <AuthLayout>
      <h1 className="text-xl font-semibold">Choose a new password</h1>
      <p className="mb-6 mt-1 text-sm text-muted-foreground">Your password was set by an administrator. Please replace it before continuing.</p>
      <ChangePasswordForm
        onDone={async () => {
          const me = await api.get<User>('/auth/me');
          authStore.setUser(me);
          navigate('/', { replace: true });
        }}
      />
    </AuthLayout>
  );
}
