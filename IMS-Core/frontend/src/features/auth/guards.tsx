import { useEffect, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, refreshSession } from '@/lib/api';
import { authStore } from '@/lib/auth-store';
import type { SetupStatus, UserRole } from '@/lib/types';
import { LogoMark } from '@/components/common/logo';
import { EmptyState } from '@/components/common/page';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from './use-auth';

export function useSetupStatus() {
  return useQuery({ queryKey: ['setup-status'], queryFn: () => api.get<SetupStatus>('/setup/status'), staleTime: 60_000, retry: 1 });
}

export function Splash() {
  return (
    <div className="flex min-h-dvh items-center justify-center" aria-busy="true" aria-label="Loading">
      <LogoMark className="size-12 animate-pulse" />
    </div>
  );
}

/** Restores the session from the refresh cookie once the instance is known to be initialised. */
export function SessionBootstrap({ children }: { children: ReactNode }) {
  const setup = useSetupStatus();
  const { status } = useAuth();

  useEffect(() => {
    if (!setup.data) return;
    if (!setup.data.initialized) {
      if (status === 'loading') authStore.clear();
      return;
    }
    if (status === 'loading') void refreshSession();
  }, [setup.data, status]);

  if (setup.isLoading) return <Splash />;
  if (setup.isError) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <EmptyState icon={ShieldAlert} title="IMS-Core is not reachable" description="The API did not respond. Check that the backend container is running." />
      </div>
    );
  }
  return <>{children}</>;
}

export function RequireAuth() {
  const setup = useSetupStatus();
  const { status, user } = useAuth();
  const location = useLocation();

  if (setup.data && !setup.data.initialized) return <Navigate to="/setup" replace />;
  if (status === 'loading') return <Splash />;
  if (status === 'anonymous') return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (user?.mustChangePassword) return <Navigate to="/change-password" replace />;
  return <Outlet />;
}

export function RequireRole({ min, children }: { min: UserRole; children: ReactNode }) {
  const { can } = useAuth();
  if (!can(min)) {
    return <EmptyState icon={ShieldAlert} title="Access restricted" description={`This area requires the ${min.toLowerCase()} role.`} />;
  }
  return <>{children}</>;
}
