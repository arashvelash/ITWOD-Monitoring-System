import { useNavigate } from 'react-router';
import { KeyRound, LogOut, Menu, Monitor, Moon, Sun, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useTheme, type ThemePreference } from '@/components/theme-provider';
import { LogoMark } from '@/components/common/logo';
import { useAuth } from '@/features/auth/use-auth';
import { logout } from '@/lib/api';
import { initials } from '@/lib/utils';

const THEMES: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

export function Topbar({ onMenu }: { onMenu: () => void }) {
  const { user } = useAuth();
  const { preference, resolved, setPreference } = useTheme();
  const navigate = useNavigate();
  const ThemeIcon = resolved === 'dark' ? Moon : Sun;

  return (
    <header className="glass sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border/60 px-4 sm:px-6">
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={onMenu} aria-label="Open navigation">
        <Menu />
      </Button>
      <LogoMark className="size-7 lg:hidden" />
      <div className="flex-1" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Change theme">
            <ThemeIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {THEMES.map((t) => (
            <DropdownMenuItem key={t.value} onSelect={() => setPreference(t.value)} className={preference === t.value ? 'font-semibold' : undefined}>
              <t.icon /> {t.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="flex items-center gap-2 rounded-full py-1 pl-1 pr-3 transition hover:bg-muted focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring"
            aria-label="Account menu"
          >
            <span className="flex size-7 items-center justify-center rounded-full bg-gradient-to-br from-[#0a84ff] to-[#5e5ce6] text-[11px] font-semibold text-white">
              {initials(user?.displayName || user?.username || '?')}
            </span>
            <span className="hidden text-sm font-medium sm:inline">{user?.displayName || user?.username}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>
            <div className="text-sm font-medium text-foreground">{user?.username}</div>
            <div className="text-xs">{user?.role.toLowerCase()}</div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => navigate('/account')}>
            <UserRound /> Account & sessions
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate('/account?tab=password')}>
            <KeyRound /> Change password
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            destructive
            onSelect={async () => {
              await logout();
              navigate('/login', { replace: true });
            }}
          >
            <LogOut /> Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
