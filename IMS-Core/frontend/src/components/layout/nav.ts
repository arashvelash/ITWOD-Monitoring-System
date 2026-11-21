import { Activity, Archive, BellRing, FolderKanban, LayoutDashboard, RefreshCcwDot, ScrollText, Send, Server, Settings, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { UserRole } from '@/lib/types';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  minRole: UserRole;
  end?: boolean;
}

export const NAV_SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, minRole: 'VIEWER', end: true },
      { to: '/alerts', label: 'Alerts', icon: BellRing, minRole: 'VIEWER' },
    ],
  },
  {
    title: 'Infrastructure',
    items: [
      { to: '/servers', label: 'Servers', icon: Server, minRole: 'VIEWER' },
      { to: '/projects', label: 'Projects', icon: FolderKanban, minRole: 'VIEWER' },
      { to: '/backups', label: 'Backups', icon: Archive, minRole: 'VIEWER' },
      { to: '/monitoring', label: 'Monitoring', icon: Activity, minRole: 'VIEWER' },
    ],
  },
  {
    title: 'Administration',
    items: [
      { to: '/updates', label: 'Updates', icon: RefreshCcwDot, minRole: 'OPERATOR' },
      { to: '/telegram', label: 'Telegram', icon: Send, minRole: 'ADMIN' },
      { to: '/users', label: 'Users', icon: Users, minRole: 'ADMIN' },
      { to: '/audit', label: 'Audit log', icon: ScrollText, minRole: 'ADMIN' },
      { to: '/settings', label: 'Settings', icon: Settings, minRole: 'ADMIN' },
    ],
  },
];
