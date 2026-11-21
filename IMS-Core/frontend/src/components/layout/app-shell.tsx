import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import { AnimatePresence, motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/common/logo';
import { api } from '@/lib/api';
import { Sidebar, SidebarNav } from './sidebar';
import { Topbar } from './topbar';

export function AppShell() {
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: () => api.get<{ version: string }>('/health'), staleTime: 300_000 });

  useEffect(() => setDrawer(false), [location.pathname]);

  return (
    <div className="flex min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-card focus:px-4 focus:py-2 focus:shadow">
        Skip to content
      </a>
      <Sidebar version={health?.version} />

      <AnimatePresence>
        {drawer && (
          <>
            <motion.div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setDrawer(false)} />
            <motion.aside
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
              className="glass fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-border/60 lg:hidden"
              initial={{ x: -300 }}
              animate={{ x: 0 }}
              exit={{ x: -300 }}
              transition={{ type: 'spring', stiffness: 420, damping: 40 }}
            >
              <div className="flex items-center justify-between px-5 py-5">
                <Logo />
                <Button variant="ghost" size="icon" onClick={() => setDrawer(false)} aria-label="Close navigation">
                  <X />
                </Button>
              </div>
              <div className="flex-1 overflow-y-auto pb-6">
                <SidebarNav onNavigate={() => setDrawer(false)} />
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onMenu={() => setDrawer(true)} />
        <main id="main" className="flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
