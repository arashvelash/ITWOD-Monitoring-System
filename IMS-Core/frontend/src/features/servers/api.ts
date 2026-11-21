import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import type { NodeCommand, RegistrationInfo, Server, ServerType } from '@/lib/types';

export interface ServerListItem extends Server {
  jobCount?: number;
}

export interface ServerDetail extends Server {
  pendingToken: { tokenPrefix: string; expiresAt: string } | null;
}

export function useServers(filters: { status?: string; search?: string } = {}) {
  return useQuery({
    queryKey: ['servers', filters],
    queryFn: () => api.get<ServerListItem[]>('/servers', { status: filters.status, search: filters.search }),
    refetchInterval: 15_000,
  });
}

export function useServer(id: string) {
  return useQuery({ queryKey: ['server', id], queryFn: () => api.get<ServerDetail>(`/servers/${id}`), refetchInterval: 10_000 });
}

export function useServerCommands(id: string) {
  return useQuery({ queryKey: ['server', id, 'commands'], queryFn: () => api.get<NodeCommand[]>(`/servers/${id}/commands`), refetchInterval: 5_000 });
}

export interface CreateServerInput {
  name: string;
  type: ServerType;
  operatingSystem: string;
  description?: string;
  tags?: string[];
}

export function useCreateServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateServerInput) => api.post<RegistrationInfo>('/servers', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['servers'] }),
    onError: (err) => toast.error(errorMessage(err)),
  });
}

/** Generic POST action on a server (ping, config-sync, revoke, ...). */
export function useServerAction<T = unknown>(id: string, action: string, successMessage?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<T>(`/servers/${id}/${action}`),
    onSuccess: () => {
      if (successMessage) toast.success(successMessage);
      void qc.invalidateQueries({ queryKey: ['server', id] });
      void qc.invalidateQueries({ queryKey: ['servers'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
}

export function useUpdateServer(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<{ name: string; operatingSystem: string; description: string | null; tags: string[]; monitoredServices: string[] | null }>) => api.patch<Server>(`/servers/${id}`, body),
    onSuccess: () => {
      toast.success('Server updated');
      void qc.invalidateQueries({ queryKey: ['server', id] });
      void qc.invalidateQueries({ queryKey: ['servers'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
}
