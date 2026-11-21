import { NavLink } from 'react-router';
import { motion } from 'framer-motion';
import { Logo } from '@/components/common/logo';
import { useAuth } from '@/features/auth/use-auth';
import { cn } from '@/lib/utils';
import { NAV_SECTIONS } from './nav';

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { can } = useAuth();
  return (
    <nav aria-label="Main" className="flex flex-col gap-6 px-3">
      {NAV_SECTIONS.map((section) => {
        const items = section.items.filter((i) => can(i.minRole));
        if (!items.length) return null;
        return (
          <div key={section.title}>
            <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">{section.title}</p>
            <ul className="grid gap-0.5">
              {items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn(
                        'relative flex items-center gap-3 rounded-xl px-3 py-2 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring',
                        isActive ? 'text-foreground' : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && (
                          <motion.span
                            layoutId="sidebar-active"
                            className="absolute inset-0 rounded-xl bg-card shadow-[var(--shadow-soft)] ring-1 ring-border/60"
                            transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                          />
                        )}
                        <item.icon className={cn('relative size-[18px]', isActive && 'text-primary')} />
                        <span className="relative">{item.label}</span>
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

export function Sidebar({ version }: { version?: string }) {
  return (
    <aside className="glass sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-border/60 lg:flex">
      <div className="px-6 pb-6 pt-6">
        <Logo />
      </div>
      <div className="flex-1 overflow-y-auto pb-6 scrollbar-thin">
        <SidebarNav />
      </div>
      {version && <div className="border-t border-border/60 px-6 py-3 text-[11px] text-muted-foreground">IMS-Core v{version}</div>}
    </aside>
  );
}
