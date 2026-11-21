import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Server as ServerIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { RegistrationInfo, ServerType } from '@/lib/types';
import { useCreateServer } from './api';
import { RegistrationPanel } from './registration-panel';

const schema = z.object({
  name: z.string().trim().min(1, 'Required').max(128),
  type: z.enum(['UBUNTU', 'CPANEL']),
  operatingSystem: z.string().trim().min(1, 'Required').max(128),
  description: z.string().trim().max(1000).optional(),
  tags: z.string().optional(),
});
type Values = z.infer<typeof schema>;

export function AddServerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const create = useCreateServer();
  const [result, setResult] = useState<RegistrationInfo | null>(null);
  const { register, handleSubmit, formState, watch, setValue, reset } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { type: 'UBUNTU', operatingSystem: 'Ubuntu 24.04 LTS', name: '', description: '', tags: '' },
  });

  const close = (o: boolean) => {
    if (!o) {
      setResult(null);
      reset();
    }
    onOpenChange(o);
  };

  const onSubmit = handleSubmit(async (v) => {
    const tags = (v.tags ?? '')
      .split(/[\s,]+/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const info = await create.mutateAsync({ name: v.name, type: v.type, operatingSystem: v.operatingSystem, ...(v.description ? { description: v.description } : {}), tags });
    setResult(info);
  });

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{result ? `${result.server.name} is ready for its agent` : 'Add server'}</DialogTitle>
          <DialogDescription>
            {result ? 'Install the agent with the one-time registration token below.' : 'Core generates a Node ID and a one-time registration token for the agent.'}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <>
            <RegistrationPanel info={result} />
            <DialogFooter>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={onSubmit} className="grid gap-4" noValidate>
            <Field id="srv-name" label="Server name" error={formState.errors.name?.message}>
              <Input id="srv-name" placeholder="web-01" autoFocus {...register('name')} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="srv-type" label="Server type">
                <Select
                  value={watch('type')}
                  onValueChange={(t) => {
                    setValue('type', t as ServerType);
                    setValue('operatingSystem', t === 'CPANEL' ? 'cPanel shared hosting' : 'Ubuntu 24.04 LTS');
                  }}
                >
                  <SelectTrigger id="srv-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="UBUNTU">Ubuntu server (IMS-Agent)</SelectItem>
                    <SelectItem value="CPANEL">cPanel hosting (IMS-CPanel-Agent)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field id="srv-os" label="Operating system" error={formState.errors.operatingSystem?.message}>
                <Input id="srv-os" {...register('operatingSystem')} />
              </Field>
            </div>
            <Field id="srv-desc" label="Description (optional)">
              <Textarea id="srv-desc" rows={2} {...register('description')} />
            </Field>
            <Field id="srv-tags" label="Tags (optional)" hint="Comma separated, e.g. production, customer-a">
              <Input id="srv-tags" {...register('tags')} />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={formState.isSubmitting}>
                <ServerIcon /> Create server
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
