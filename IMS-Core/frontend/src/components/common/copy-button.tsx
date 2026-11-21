import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error('Clipboard is not available. Select the text and copy it manually.');
    }
  };
  return (
    <Button type="button" variant="ghost" size="icon-sm" onClick={copy} className={cn('shrink-0', className)} aria-label={label}>
      {copied ? <Check className="text-success" /> : <Copy />}
    </Button>
  );
}

/** Read-only monospace value with copy button (tokens, commands, ids). */
export function SecretField({ value, label, multiline = false }: { value: string; label: string; multiline?: boolean }) {
  return (
    <div className="grid gap-1.5">
      <span className="text-[12px] font-medium text-muted-foreground">{label}</span>
      <div className="flex items-start gap-1 rounded-xl border border-border bg-muted/50 py-1 pl-3 pr-1">
        <code className={cn('min-w-0 flex-1 py-1.5 font-mono text-[12.5px]', multiline ? 'whitespace-pre-wrap break-all' : 'truncate')}>{value}</code>
        <CopyButton value={value} label={`Copy ${label}`} />
      </div>
    </div>
  );
}
