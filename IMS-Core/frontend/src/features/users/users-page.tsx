import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { KeyRound, LockOpen, MoreHorizontal, UserPlus, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Page, PageHeader, EmptyState, ErrorState, LoadingRows } from '@/components/common/page';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import type { User, UserRole } from '@/lib/types';
import { timeAgo } from '@/lib/utils';
import { useAuth } from '@/features/auth/use-auth';

const ROLES: { value: UserRole; label: string; hint: string }[] = [
  { value: 'ADMIN', label: 'Admin', hint: 'Full access including users, settings and Core updates' },
  { value: 'OPERATOR', label: 'Operator', hint: 'Manage servers and backups, run jobs, update agents' },
  { value: 'VIEWER', label: 'Viewer', hint: 'Read-only access' },
];

const createSchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,31}$/, '3-32 characters: letters, digits, dot, dash, underscore'),
  displayName: z.string().trim().max(128).optional(),
  email: z.union([z.literal(''), z.string().trim().email('Invalid e-mail')]).optional(),
  password: z.string().min(12, 'At least 12 characters').max(128),
  role: z.enum(['ADMIN', 'OPERATOR', 'VIEWER']),
});
type CreateValues = z.infer<typeof createSchema>;

function CreateUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const { register, handleSubmit, formState, setValue, watch, reset } = useForm<CreateValues>({ resolver: zodResolver(createSchema), defaultValues: { role: 'VIEWER', email: '', displayName: '' } });
  const onSubmit = handleSubmit(async (v) => {
    try {
      await api.post('/users', { username: v.username, password: v.password, role: v.role, mustChangePassword: true, ...(v.displayName ? { displayName: v.displayName } : {}), ...(v.email ? { email: v.email } : {}) });
      toast.success(`User ${v.username} created. They must change the password at first sign-in.`);
      await qc.invalidateQueries({ queryKey: ['users'] });
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription>The initial password is temporary and must be changed at first sign-in.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="new-username" label="Username" error={formState.errors.username?.message}>
              <Input id="new-username" autoComplete="off" {...register('username')} />
            </Field>
            <Field id="new-display" label="Display name" error={formState.errors.displayName?.message}>
              <Input id="new-display" {...register('displayName')} />
            </Field>
          </div>
          <Field id="new-email" label="E-mail (optional)" error={formState.errors.email?.message}>
            <Input id="new-email" type="email" {...register('email')} />
          </Field>
          <Field id="new-password" label="Temporary password" error={formState.errors.password?.message}>
            <Input id="new-password" type="password" autoComplete="new-password" {...register('password')} />
          </Field>
          <Field id="new-role" label="Role" hint={ROLES.find((r) => r.value === watch('role'))?.hint}>
            <Select value={watch('role')} onValueChange={(v) => setValue('role', v as UserRole)}>
              <SelectTrigger id="new-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={formState.isSubmitting}>
              Create user
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: User | null; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const mutation = useMutation({
    mutationFn: () => api.post(`/users/${user!.id}/reset-password`, { password }),
    onSuccess: () => {
      toast.success('Password reset. All sessions of this user were signed out.');
      setPassword('');
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset password for {user?.username}</DialogTitle>
          <DialogDescription>The user must choose a new password at next sign-in.</DialogDescription>
        </DialogHeader>
        <Field id="reset-password" label="Temporary password" hint="At least 12 characters.">
          <Input id="reset-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} loading={mutation.isPending} disabled={password.length < 12}>
            Reset password
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function UsersPage() {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const [resetUser, setResetUser] = useState<User | null>(null);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/users') });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Pick<User, 'role' | 'isActive'>> }) => api.patch(`/users/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const unlock = useMutation({
    mutationFn: (id: string) => api.post(`/users/${id}/unlock`),
    onSuccess: () => {
      toast.success('Account unlocked');
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Page>
      <PageHeader
        title="Users"
        description="People who can access this IMS instance and what they are allowed to do."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <UserPlus /> Add user
          </Button>
        }
      />
      <Card>
        {isLoading ? (
          <LoadingRows />
        ) : error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : !data?.length ? (
          <EmptyState icon={Users} title="No users" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Last sign-in</TableHead>
                <TableHead>Active</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((u) => {
                const self = u.id === me?.id;
                const locked = u.lockedUntil && new Date(u.lockedUntil) > new Date();
                return (
                  <TableRow key={u.id}>
                    <TableCell>
                      <div className="font-medium">
                        {u.displayName || u.username} {self && <Badge variant="secondary">you</Badge>} {locked && <Badge variant="warning">locked</Badge>}
                      </div>
                      <div className="text-[12px] text-muted-foreground">
                        @{u.username}
                        {u.email ? ` · ${u.email}` : ''}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Select value={u.role} disabled={self} onValueChange={(role) => update.mutate({ id: u.id, body: { role: role as UserRole } })}>
                        <SelectTrigger className="h-8 w-32" aria-label={`Role of ${u.username}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLES.map((r) => (
                            <SelectItem key={r.value} value={r.value}>
                              {r.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{timeAgo(u.lastLoginAt)}</TableCell>
                    <TableCell>
                      <Switch checked={u.isActive ?? true} disabled={self} onCheckedChange={(isActive) => update.mutate({ id: u.id, body: { isActive } })} aria-label={`Active state of ${u.username}`} />
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${u.username}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setResetUser(u)} disabled={self}>
                            <KeyRound /> Reset password
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => unlock.mutate(u.id)} disabled={!locked}>
                            <LockOpen /> Unlock account
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ResetPasswordDialog user={resetUser} onClose={() => setResetUser(null)} />
    </Page>
  );
}
