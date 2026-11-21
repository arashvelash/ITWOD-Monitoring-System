import { Badge } from '@/components/ui/badge';
import type { AlertSeverity, AlertStatus, BackupRunStatus, CommandStatus, ServerStatus } from '@/lib/types';

type Variant = 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline';

const SERVER: Record<ServerStatus, [Variant, string]> = {
  ONLINE: ['success', 'Online'],
  OFFLINE: ['destructive', 'Offline'],
  PENDING: ['warning', 'Awaiting agent'],
  REVOKED: ['secondary', 'Revoked'],
  DECOMMISSIONED: ['outline', 'Decommissioned'],
};

const RUN: Record<BackupRunStatus, [Variant, string]> = {
  SUCCESS: ['success', 'Success'],
  FAILED: ['destructive', 'Failed'],
  RUNNING: ['default', 'Running'],
  QUEUED: ['secondary', 'Queued'],
};

const SEVERITY: Record<AlertSeverity, [Variant, string]> = {
  CRITICAL: ['destructive', 'Critical'],
  WARNING: ['warning', 'Warning'],
  INFO: ['default', 'Info'],
};

const ALERT_STATUS: Record<AlertStatus, [Variant, string]> = {
  OPEN: ['destructive', 'Open'],
  ACKNOWLEDGED: ['warning', 'Acknowledged'],
  RESOLVED: ['success', 'Resolved'],
};

const COMMAND: Record<CommandStatus, [Variant, string]> = {
  PENDING: ['secondary', 'Pending'],
  SENT: ['default', 'Sent'],
  ACKNOWLEDGED: ['default', 'Running'],
  SUCCEEDED: ['success', 'Succeeded'],
  FAILED: ['destructive', 'Failed'],
  EXPIRED: ['outline', 'Expired'],
};

export const ServerStatusBadge = ({ status }: { status: ServerStatus }) => <Badge variant={SERVER[status][0]} dot>{SERVER[status][1]}</Badge>;
export const RunStatusBadge = ({ status }: { status: BackupRunStatus }) => <Badge variant={RUN[status][0]} dot>{RUN[status][1]}</Badge>;
export const SeverityBadge = ({ severity }: { severity: AlertSeverity }) => <Badge variant={SEVERITY[severity][0]}>{SEVERITY[severity][1]}</Badge>;
export const AlertStatusBadge = ({ status }: { status: AlertStatus }) => <Badge variant={ALERT_STATUS[status][0]} dot>{ALERT_STATUS[status][1]}</Badge>;
export const CommandStatusBadge = ({ status }: { status: CommandStatus }) => <Badge variant={COMMAND[status][0]}>{COMMAND[status][1]}</Badge>;
