// API contract types shared by the dashboard (mirror of backend responses).

export type UserRole = 'ADMIN' | 'OPERATOR' | 'VIEWER';

export interface User {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  role: UserRole;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  isActive?: boolean;
  lockedUntil?: string | null;
}

export interface AuthResponse {
  accessToken: string;
  expiresIn: number;
  user: User;
}

export interface SessionInfo {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string;
  absoluteExpiresAt: string;
  current: boolean;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CheckResult {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

export interface SetupStatus {
  initialized: boolean;
  version: string;
  checks?: {
    database: CheckResult;
    migrations: CheckResult & { applied?: number };
    redis: CheckResult;
    masterKey: CheckResult & { fingerprint?: string };
    jwtSecret: CheckResult & { length?: number };
    https: CheckResult & { publicUrl?: string | null };
  };
}

export type ServerType = 'UBUNTU' | 'CPANEL';
export type ServerStatus = 'PENDING' | 'ONLINE' | 'OFFLINE' | 'REVOKED' | 'DECOMMISSIONED';

export interface DiskUsage {
  mount: string;
  fs?: string;
  totalBytes: number;
  usedBytes: number;
}

export interface MetricsSnapshot {
  collectedAt: string;
  cpu?: { percent?: number; cores?: number; load?: number[] };
  memory?: { totalBytes?: number; usedBytes?: number; availableBytes?: number };
  swap?: { totalBytes?: number; usedBytes?: number };
  disks?: DiskUsage[];
  network?: { rxBytesPerSec?: number; txBytesPerSec?: number };
  uptimeSec?: number;
  services?: { name: string; active: boolean; state?: string }[];
}

export interface Server {
  id: string;
  nodeId: string;
  name: string;
  type: ServerType;
  operatingSystem: string;
  description: string | null;
  tags: string[];
  status: ServerStatus;
  hostname: string | null;
  ipAddress: string | null;
  osDetails: string | null;
  arch: string | null;
  agentVersion: string | null;
  registeredAt: string | null;
  lastHeartbeatAt: string | null;
  lastMetricsAt: string | null;
  latestMetrics: MetricsSnapshot | null;
  monitoringConfig: { services?: string[] } | null;
  createdAt: string;
  connected?: boolean;
  credential?: { keyFingerprint: string | null; keyAlgorithm: string | null; issuedAt: string; lastUsedAt: string | null } | null;
  openAlerts?: number;
}

export interface RegistrationInfo {
  server: Server;
  registrationToken: string;
  expiresAt: string;
  installCommand: string;
  coreUrl: string;
}

export type CommandStatus = 'PENDING' | 'SENT' | 'ACKNOWLEDGED' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED';

export interface NodeCommand {
  id: string;
  type: string;
  status: CommandStatus;
  origin: 'DASHBOARD' | 'TELEGRAM' | 'SYSTEM';
  payload: Record<string, unknown>;
  createdAt: string;
  sentAt: string | null;
  completedAt: string | null;
  expiresAt: string;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  websiteUrl: string | null;
  serverId: string | null;
  server?: Pick<Server, 'id' | 'name' | 'nodeId'> | null;
  archivedAt: string | null;
  createdAt: string;
  _count?: { jobs: number };
}

export type BackupType = 'FILES' | 'MYSQL' | 'POSTGRES';
export type BackupDestinationType = 'LOCAL' | 'S3';
export type BackupRunStatus = 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED';
export type BackupTrigger = 'SCHEDULED' | 'MANUAL' | 'TELEGRAM';

export interface BackupJob {
  id: string;
  name: string;
  slug: string;
  projectId: string | null;
  serverId: string;
  type: BackupType;
  enabled: boolean;
  schedule: string;
  timezone: string;
  sourceConfig: {
    paths?: string[];
    excludes?: string[];
    host?: string;
    port?: number;
    database?: string;
    username?: string;
  };
  hasSourceSecret: boolean;
  destinationType: BackupDestinationType;
  destinationConfig: { bucket?: string; region?: string; endpoint?: string; prefix?: string; forcePathStyle?: boolean };
  hasDestinationSecret: boolean;
  retentionCount: number;
  retentionDays: number | null;
  encryptionEnabled: boolean;
  compressionLevel: number;
  timeoutMinutes: number;
  lastRunAt: string | null;
  lastRunStatus: BackupRunStatus | null;
  lastSuccessAt: string | null;
  nextRunAt?: string | null;
  archivedAt: string | null;
  createdAt: string;
  server?: Pick<Server, 'id' | 'name' | 'nodeId' | 'status'>;
  project?: Pick<Project, 'id' | 'name'> | null;
}

export interface BackupRun {
  id: string;
  jobId: string;
  serverId: string;
  trigger: BackupTrigger;
  status: BackupRunStatus;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  sizeBytes: number | null;
  checksumSha256: string | null;
  fileName: string | null;
  location: string | null;
  encrypted: boolean;
  errorMessage: string | null;
  logTail?: string | null;
  createdAt: string;
  job?: Pick<BackupJob, 'id' | 'name' | 'type'>;
  server?: Pick<Server, 'id' | 'name' | 'nodeId'>;
}

export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type AlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';

export interface Alert {
  id: string;
  type: string;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  message: string;
  serverId: string | null;
  jobId: string | null;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  server?: Pick<Server, 'id' | 'name' | 'nodeId'> | null;
}

export interface MetricPoint {
  collectedAt: string;
  cpuPercent: number | null;
  memUsedPercent: number | null;
  diskUsedPercent: number | null;
  load1: number | null;
  netRxBps: number | null;
  netTxBps: number | null;
}

export interface DashboardOverview {
  servers: { total: number; online: number; offline: number; pending: number };
  backups: { jobs: number; enabledJobs: number; last24h: { success: number; failed: number; running: number }; totalSizeBytes24h: number };
  alerts: { open: number; critical: number };
  recentRuns: BackupRun[];
  recentAlerts: Alert[];
  serverHealth: Pick<Server, 'id' | 'name' | 'nodeId' | 'status' | 'type' | 'lastHeartbeatAt' | 'latestMetrics' | 'agentVersion'>[];
}

export interface AuditEntry {
  id: string;
  actorType: 'USER' | 'NODE' | 'SYSTEM' | 'TELEGRAM';
  actorId: string | null;
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  success: boolean;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

export interface Settings {
  general: { instanceName: string; publicUrl: string | null; timezone: string };
  security: { sessionIdleHours: number; sessionAbsoluteDays: number; registrationTokenTtlHours: number; maxFailedLogins: number; lockoutMinutes: number };
  monitoring: {
    offlineAfterSec: number;
    metricsRetentionDays: number;
    cpuPercent: number;
    cpuSustainMinutes: number;
    memoryPercent: number;
    diskPercent: number;
    backupMissedGraceMinutes: number;
    defaultServices: string[];
  };
  telegram: { enabled: boolean; notifyAlerts: boolean; notifyBackupSuccess: boolean; notifyBackupFailure: boolean; notifyNodeStatus: boolean; broadcastChatIds: string[] };
  github: { apiBase: string; coreRepo: string | null; agentRepo: string | null };
  secretsConfigured: Record<string, boolean>;
}

export interface TelegramStatus {
  enabled: boolean;
  tokenConfigured: boolean;
  running: boolean;
  bot: { id: number; username: string; firstName: string } | null;
  lastError: string | null;
  links: TelegramLink[];
}

export interface TelegramLink {
  id: string;
  userId: string;
  chatId: string;
  telegramUsername: string | null;
  notificationsEnabled: boolean;
  linkedAt: string;
  user?: Pick<User, 'id' | 'username' | 'role'>;
}

export type CoreUpdateStatus = 'REQUESTED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'ROLLED_BACK';

export interface CoreUpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  latestCheckedAt: string | null;
  latestPublishedAt: string | null;
  latestReleaseNotes: string | null;
  updateAvailable: boolean;
  repoConfigured: boolean;
  updaterInstalled: boolean;
  requestPending: boolean;
  status: { id?: string; state: 'idle' | 'queued' | 'running' | 'succeeded' | 'failed' | 'rolled_back'; step?: string; message?: string; fromVersion?: string; targetVersion?: string; startedAt?: string; updatedAt?: string } | null;
  history: {
    id: string;
    fromVersion: string;
    toVersion: string;
    status: CoreUpdateStatus;
    currentStep: string | null;
    requestedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    errorMessage: string | null;
  }[];
}

export interface GithubSource {
  apiBase: string;
  coreRepo: string | null;
  agentRepo: string | null;
  tokenConfigured: boolean;
}

export interface AgentFleet {
  latestVersion: string | null;
  servers: {
    id: string;
    name: string;
    nodeId: string;
    type: ServerType;
    status: ServerStatus;
    agentVersion: string | null;
    upToDate: boolean;
    lastUpdate: { id: string; status: CommandStatus; payload: { version?: string }; createdAt: string; completedAt: string | null; errorMessage: string | null } | null;
  }[];
}

export interface RolloutResult {
  version: string;
  results: { serverId: string; name?: string; queued: boolean; reason?: string; commandId?: string }[];
}

export interface AgentRelease {
  id: string;
  version: string;
  fileName: string;
  sha256: string;
  signature: string | null;
  sizeBytes: number;
  source: 'GITHUB' | 'UPLOAD';
  releaseNotes: string | null;
  publishedAt: string | null;
  isRevoked: boolean;
  createdAt: string;
  isLatest?: boolean;
}
