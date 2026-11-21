import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import type { Settings } from '@/lib/types';

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/settings') });
}

export function useUpdateSettings<K extends 'general' | 'security' | 'monitoring'>(section: K) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Settings[K]>) => api.put<Settings[K]>(`/settings/${section}`, body),
    onSuccess: () => {
      toast.success('Settings saved');
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
}
