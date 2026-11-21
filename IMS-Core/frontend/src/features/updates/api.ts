import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import type { AgentFleet, AgentRelease, CoreUpdateInfo, GithubSource, RolloutResult } from '@/lib/types';

export function useCoreUpdate() {
  return useQuery({
    queryKey: ['updates', 'core'],
    queryFn: () => api.get<CoreUpdateInfo>('/updates/core'),
    // Poll quickly while an update runs so progress is visible; Core may restart meanwhile.
    refetchInterval: (q) => (q.state.data?.requestPending || q.state.data?.status?.state === 'running' || q.state.data?.status?.state === 'queued' ? 3_000 : 60_000),
    retry: true,
  });
}

export function useAgentReleases() {
  return useQuery({ queryKey: ['updates', 'releases'], queryFn: () => api.get<AgentRelease[]>('/updates/agents/releases') });
}

export function useAgentFleet() {
  return useQuery({ queryKey: ['updates', 'fleet'], queryFn: () => api.get<AgentFleet>('/updates/agents/fleet'), refetchInterval: 10_000 });
}

export function useGithubSource(enabled: boolean) {
  return useQuery({ queryKey: ['updates', 'github'], queryFn: () => api.get<GithubSource>('/updates/github'), enabled });
}

function useUpdatesMutation<TVars, TResult>(fn: (v: TVars) => Promise<TResult>, success?: (r: TResult) => string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      const msg = success?.(r);
      if (msg) toast.success(msg);
      void qc.invalidateQueries({ queryKey: ['updates'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
}

export const useCheckCore = () =>
  useUpdatesMutation(
    () => api.post<CoreUpdateInfo>('/updates/core/check'),
    (r) => (r.updateAvailable ? `Version ${r.latestVersion} is available` : 'IMS-Core is up to date'),
  );

export const useApplyCore = () => useUpdatesMutation((version: string) => api.post('/updates/core/apply', { version }), () => 'Update requested. The host updater will start within a few seconds.');

export const useSyncReleases = () =>
  useUpdatesMutation(
    () => api.post<{ status: string; version?: string }>('/updates/agents/releases/sync'),
    (r) =>
      r.status === 'imported'
        ? `Imported agent ${r.version}`
        : r.status === 'up-to-date'
          ? `Agent ${r.version} is already available`
          : r.status === 'not-configured'
            ? 'Configure the agent repository first'
            : 'No published agent release found',
  );

export const useUploadRelease = () =>
  useUpdatesMutation(
    (form: FormData) => api.upload<AgentRelease>('/updates/agents/releases/upload', form),
    (r) => `Agent ${r.version} uploaded`,
  );

export const useRevokeRelease = () => useUpdatesMutation((version: string) => api.post(`/updates/agents/releases/${version}/revoke`), () => 'Release revoked');

export const useRollout = () =>
  useUpdatesMutation(
    (body: { version?: string; serverIds: string[]; force?: boolean }) => api.post<RolloutResult>('/updates/agents/rollout', body),
    (r) => {
      const queued = r.results.filter((x) => x.queued).length;
      return `Update to ${r.version} queued for ${queued} of ${r.results.length} server(s)`;
    },
  );

export const useSaveGithub = () =>
  useUpdatesMutation((body: Partial<{ apiBase: string; coreRepo: string | null; agentRepo: string | null; token: string | null }>) => api.put<GithubSource>('/updates/github', body), () => 'Release source saved');
