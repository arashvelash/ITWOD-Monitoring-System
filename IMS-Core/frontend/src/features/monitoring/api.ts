import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import type { Alert, AlertSeverity, AlertStatus, MetricPoint, Paginated } from '@/lib/types';

export const METRIC_RANGES = ['1h', '6h', '24h', '7d', '30d'] as const;
export type MetricRange = (typeof METRIC_RANGES)[number];

export interface MetricsHistory {
  range: MetricRange;
  bucket: string;
  points: MetricPoint[];
}

/** Aggregated metric history; short ranges refresh every minute, long ranges every five. */
export function useMetricsHistory(serverId: string, range: MetricRange) {
  return useQuery({
    queryKey: ['server', serverId, 'metrics', range],
    queryFn: () => api.get<MetricsHistory>(`/servers/${serverId}/metrics`, { range }),
    refetchInterval: range === '1h' || range === '6h' ? 60_000 : 300_000,
    placeholderData: keepPreviousData,
  });
}

export type AlertFilters = {
  status?: AlertStatus | 'ACTIVE';
  severity?: AlertSeverity;
  serverId?: string;
  page?: number;
  pageSize?: number;
};

export function useAlerts(filters: AlertFilters) {
  return useQuery({
    queryKey: ['alerts', filters],
    queryFn: () => api.get<Paginated<Alert>>('/alerts', { ...filters }),
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
  });
}

export function useAlertAction(action: 'acknowledge' | 'resolve') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<Alert>(`/alerts/${id}/${action}`),
    onSuccess: () => {
      toast.success(action === 'acknowledge' ? 'Alert acknowledged' : 'Alert resolved');
      void qc.invalidateQueries({ queryKey: ['alerts'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
}
