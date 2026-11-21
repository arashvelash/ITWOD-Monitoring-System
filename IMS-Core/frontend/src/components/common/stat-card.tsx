import type { LucideIcon } from 'lucide-react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

const TONES = {
  primary: 'bg-primary/12 text-primary',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/20 text-[color-mix(in_oklch,var(--warning)_70%,var(--foreground))]',
  destructive: 'bg-destructive/12 text-destructive',
  muted: 'bg-muted text-muted-foreground',
} as const;

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'primary',
  index = 0,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon: LucideIcon;
  tone?: keyof typeof TONES;
  index?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05, duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="surface flex items-start justify-between gap-4 p-5"
    >
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
        <p className="tabular mt-2 text-[28px] font-semibold leading-none tracking-tight">{value}</p>
        {hint && <p className="mt-2 truncate text-[12px] text-muted-foreground">{hint}</p>}
      </div>
      <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl', TONES[tone])}>
        <Icon className="size-5" />
      </div>
    </motion.div>
  );
}
