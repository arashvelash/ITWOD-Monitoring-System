import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { Logo } from '@/components/common/logo';

/** Centered card layout used by login, setup and forced password change. */
export function AuthLayout({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -left-40 -top-40 size-[520px] rounded-full bg-[#0a84ff]/15 blur-3xl" />
        <div className="absolute -bottom-48 -right-40 size-[560px] rounded-full bg-[#5e5ce6]/15 blur-3xl" />
      </div>
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className={`relative w-full ${wide ? 'max-w-2xl' : 'max-w-md'}`}
      >
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <div className="surface p-6 sm:p-8">{children}</div>
        <p className="mt-6 text-center text-[12px] text-muted-foreground">Private infrastructure management · authorised personnel only</p>
      </motion.div>
    </div>
  );
}
