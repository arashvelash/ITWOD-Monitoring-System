/**
 * Pure message builders for Telegram (parse_mode = HTML).
 * Every dynamic value goes through `esc()` so user- or agent-supplied text can
 * never inject markup or links into bot messages.
 */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatBytes(bytes: number | bigint | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms && ms !== 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function ago(date: Date | null | undefined, now = Date.now()): string {
  if (!date) return 'never';
  const s = Math.round((now - date.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

const STATUS_ICON: Record<string, string> = { ONLINE: '🟢', OFFLINE: '🔴', PENDING: '🟡', REVOKED: '⚫', DECOMMISSIONED: '⚪' };
const RUN_ICON: Record<string, string> = { SUCCESS: '✅', FAILED: '❌', RUNNING: '⏳', QUEUED: '🕒' };
const SEVERITY_ICON: Record<string, string> = { CRITICAL: '🔥', WARNING: '⚠️', INFO: 'ℹ️' };

export const icons = { status: STATUS_ICON, run: RUN_ICON, severity: SEVERITY_ICON };

export interface BackupNotice {
  jobName: string;
  serverName: string;
  status: string;
  sizeBytes?: bigint | number | null;
  durationMs?: number | null;
  error?: string | null;
  trigger: string;
}

export function backupMessage(n: BackupNotice, instance: string): string {
  const ok = n.status === 'SUCCESS';
  const lines = [
    `${RUN_ICON[n.status] ?? '•'} <b>Backup ${ok ? 'completed' : 'failed'}</b>`,
    `<b>Job:</b> ${esc(n.jobName)}`,
    `<b>Server:</b> ${esc(n.serverName)}`,
    `<b>Trigger:</b> ${esc(n.trigger.toLowerCase())}`,
  ];
  if (ok) lines.push(`<b>Size:</b> ${formatBytes(n.sizeBytes)} · <b>Duration:</b> ${formatDuration(n.durationMs)}`);
  if (!ok && n.error) lines.push(`<b>Error:</b> <code>${esc(n.error.slice(0, 500))}</code>`);
  lines.push(`<i>${esc(instance)}</i>`);
  return lines.join('\n');
}

export interface AlertNotice {
  title: string;
  message: string;
  severity: string;
  serverName?: string | null;
  resolved: boolean;
}

export function alertMessage(a: AlertNotice, instance: string): string {
  const head = a.resolved ? `✅ <b>Resolved:</b> ${esc(a.title)}` : `${SEVERITY_ICON[a.severity] ?? '•'} <b>${esc(a.title)}</b>`;
  return [head, a.serverName ? `<b>Server:</b> ${esc(a.serverName)}` : null, esc(a.message.slice(0, 1000)), `<i>${esc(instance)}</i>`].filter(Boolean).join('\n');
}

export function nodeStatusMessage(serverName: string, nodeId: string, online: boolean, instance: string): string {
  return `${online ? '🟢' : '🔴'} <b>${esc(serverName)}</b> (${esc(nodeId)}) is ${online ? 'back online' : 'offline'}\n<i>${esc(instance)}</i>`;
}
