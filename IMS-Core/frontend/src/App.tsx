import { lazy, Suspense } from 'react';
import { BrowserRouter, Link, Route, Routes } from 'react-router';
import { Compass } from 'lucide-react';
import { AppShell } from '@/components/layout/app-shell';
import { EmptyState, Page } from '@/components/common/page';
import { Button } from '@/components/ui/button';
import { RequireAuth, RequireRole, SessionBootstrap, Splash } from '@/features/auth/guards';

// Route-level code splitting keeps the initial bundle small.
const LoginPage = lazy(() => import('@/features/auth/login-page'));
const ChangePasswordPage = lazy(() => import('@/features/auth/change-password-page'));
const SetupWizard = lazy(() => import('@/features/setup/setup-wizard'));
const DashboardPage = lazy(() => import('@/features/dashboard/dashboard-page'));
const UsersPage = lazy(() => import('@/features/users/users-page'));
const AuditPage = lazy(() => import('@/features/audit/audit-page'));
const SettingsPage = lazy(() => import('@/features/settings/settings-page'));
const AccountPage = lazy(() => import('@/features/account/account-page'));
const ServersPage = lazy(() => import('@/features/servers/servers-page'));
const ServerDetailPage = lazy(() => import('@/features/servers/server-detail-page'));
const BackupsPage = lazy(() => import('@/features/backups/backups-page'));
const ProjectsPage = lazy(() => import('@/features/projects/projects-page'));
const TelegramPage = lazy(() => import('@/features/telegram/telegram-page'));
const MonitoringPage = lazy(() => import('@/features/monitoring/monitoring-page'));
const AlertsPage = lazy(() => import('@/features/alerts/alerts-page'));
const UpdatesPage = lazy(() => import('@/features/updates/updates-page'));

function NotFound() {
  return (
    <Page>
      <EmptyState
        icon={Compass}
        title="Page not found"
        description="The page you are looking for does not exist."
        action={
          <Button asChild variant="outline">
            <Link to="/">Back to dashboard</Link>
          </Button>
        }
      />
    </Page>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <SessionBootstrap>
        <Suspense fallback={<Splash />}>
          <Routes>
            <Route path="/setup" element={<SetupWizard />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/change-password" element={<ChangePasswordPage />} />
            <Route element={<RequireAuth />}>
              <Route element={<AppShell />}>
                <Route index element={<DashboardPage />} />
                <Route path="account" element={<AccountPage />} />
                <Route path="servers" element={<ServersPage />} />
                <Route path="servers/:id" element={<ServerDetailPage />} />
                <Route path="backups" element={<BackupsPage />} />
                <Route path="projects" element={<ProjectsPage />} />
                <Route path="monitoring" element={<MonitoringPage />} />
                <Route path="alerts" element={<AlertsPage />} />
                <Route
                  path="updates"
                  element={
                    <RequireRole min="OPERATOR">
                      <UpdatesPage />
                    </RequireRole>
                  }
                />
                <Route
                  path="telegram"
                  element={
                    <RequireRole min="ADMIN">
                      <TelegramPage />
                    </RequireRole>
                  }
                />
                <Route
                  path="users"
                  element={
                    <RequireRole min="ADMIN">
                      <UsersPage />
                    </RequireRole>
                  }
                />
                <Route
                  path="audit"
                  element={
                    <RequireRole min="ADMIN">
                      <AuditPage />
                    </RequireRole>
                  }
                />
                <Route
                  path="settings"
                  element={
                    <RequireRole min="ADMIN">
                      <SettingsPage />
                    </RequireRole>
                  }
                />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Route>
          </Routes>
        </Suspense>
      </SessionBootstrap>
    </BrowserRouter>
  );
}
