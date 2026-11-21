import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FolderKanban, MoreHorizontal, Pencil, Plus, Archive } from 'lucide-react';
import { toast } from 'sonner';
import { Page, PageHeader, EmptyState, ErrorState, LoadingRows } from '@/components/common/page';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api, errorMessage } from '@/lib/api';
import type { Project } from '@/lib/types';
import { useAuth } from '@/features/auth/use-auth';
import { useServers } from '@/features/servers/api';
import { useProjects } from '@/features/backups/api';

interface Values {
  name: string;
  description: string;
  websiteUrl: string;
  serverId: string;
}

function ProjectDialog({ open, onOpenChange, project }: { open: boolean; onOpenChange: (o: boolean) => void; project?: Project }) {
  const qc = useQueryClient();
  const { data: servers } = useServers();
  const { register, handleSubmit, reset, watch, setValue, formState } = useForm<Values>();
  useEffect(() => {
    if (open) reset({ name: project?.name ?? '', description: project?.description ?? '', websiteUrl: project?.websiteUrl ?? '', serverId: project?.serverId ?? 'none' });
  }, [open, project, reset]);

  const onSubmit = handleSubmit(async (v) => {
    const body = { name: v.name, description: v.description || null, websiteUrl: v.websiteUrl || null, serverId: v.serverId === 'none' ? null : v.serverId };
    try {
      if (project) await api.patch(`/projects/${project.id}`, body);
      else await api.post('/projects', body);
      toast.success(project ? 'Project updated' : 'Project created');
      await qc.invalidateQueries({ queryKey: ['projects'] });
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{project ? 'Edit project' : 'New project'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <Field id="p-name" label="Name">
            <Input id="p-name" {...register('name', { required: true })} />
          </Field>
          <Field id="p-url" label="Website URL (optional)">
            <Input id="p-url" placeholder="https://example.com" {...register('websiteUrl')} />
          </Field>
          <Field id="p-server" label="Primary server (optional)">
            <Select value={watch('serverId')} onValueChange={(v) => setValue('serverId', v)}>
              <SelectTrigger id="p-server">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {servers?.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="p-desc" label="Description (optional)">
            <Textarea id="p-desc" rows={3} {...register('description')} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={formState.isSubmitting}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function ProjectsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useProjects();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Project | undefined>();
  const archive = useMutation({
    mutationFn: (id: string) => api.patch(`/projects/${id}`, { archived: true }),
    onSuccess: () => {
      toast.success('Project archived');
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Page>
      <PageHeader
        title="Projects"
        description="Group backup jobs by website, customer or application."
        actions={
          can('OPERATOR') && (
            <Button
              onClick={() => {
                setEditing(undefined);
                setOpen(true);
              }}
            >
              <Plus /> New project
            </Button>
          )
        }
      />
      {isLoading ? (
        <Card>
          <LoadingRows />
        </Card>
      ) : error ? (
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      ) : !data?.length ? (
        <Card>
          <EmptyState icon={FolderKanban} title="No projects yet" description="Projects are optional but keep large installations organised." />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.map((p) => (
            <Card key={p.id} className="flex flex-col gap-3 p-5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{p.name}</p>
                  <p className="text-[12px] text-muted-foreground">{p.server ? p.server.name : 'No primary server'}</p>
                </div>
                {can('OPERATOR') && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${p.name}`}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onSelect={() => {
                          setEditing(p);
                          setOpen(true);
                        }}
                      >
                        <Pencil /> Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem destructive onSelect={() => archive.mutate(p.id)}>
                        <Archive /> Archive
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
              {p.description && <p className="line-clamp-2 text-sm text-muted-foreground">{p.description}</p>}
              <div className="mt-auto flex items-center justify-between">
                <Badge variant="secondary">{p._count?.jobs ?? 0} backup jobs</Badge>
                {p.websiteUrl && (
                  <a href={p.websiteUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[13px] text-primary hover:underline">
                    Visit <ExternalLink className="size-3.5" />
                  </a>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
      <ProjectDialog open={open} onOpenChange={setOpen} project={editing} />
    </Page>
  );
}
