import { EventEmitter } from 'node:events';
import type { CoreClient } from '../src/core-client';
import { readJson, writeJson } from '../src/fs-utils';
import { createLogger } from '../src/logger';
import { openConfigSecrets, type SecretsEnvelope } from '../src/protocol';

const log = createLogger('config');

export type BackupType = 'FILES' | 'MYSQL' | 'POSTGRES';

export interface JobConfig {
  id: string;
  name: string;
  slug: string;
  type: BackupType;
  enabled: boolean;
  schedule: string;
  timezone: string;
  timeoutMinutes: number;
  compressionLevel: number;
  source: { paths?: string[]; excludes?: string[]; host?: string; port?: number; database?: string; username?: string };
  destination: { type: 'LOCAL' | 'S3'; bucket?: string; region?: string; endpoint?: string; prefix?: string; forcePathStyle?: boolean };
  retention: { count: number; days: number | null };
  encryption: { enabled: boolean };
}

export interface AgentConfig {
  configVersion: number;
  heartbeatIntervalSec: number;
  metricsIntervalSec: number;
  monitoring: { services: string[] };
  backup: { localDirectory: string };
  jobs: JobConfig[];
  secrets: SecretsEnvelope | null;
}

export interface JobSecrets {
  dbPassword?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  encryptionKey?: string;
}

const EMPTY: AgentConfig = {
  configVersion: 0,
  heartbeatIntervalSec: 30,
  metricsIntervalSec: 60,
  monitoring: { services: [] },
  backup: { localDirectory: '/var/backups/ims' },
  jobs: [],
  secrets: null,
};

/**
 * Holds the configuration received from Core. The cache on disk keeps the
 * secrets sealed; they are decrypted in memory only when a job runs, so the
 * agent keeps working (and backing up) while Core is unreachable.
 */
export class ConfigService extends EventEmitter {
  private config: AgentConfig = EMPTY;

  constructor(
    private readonly cacheFile: string,
    private readonly nodeSecret: string,
    private readonly client: () => CoreClient | null,
  ) {
    super();
  }

  get current(): AgentConfig {
    return this.config;
  }

  async loadCache(): Promise<void> {
    const cached = await readJson<AgentConfig>(this.cacheFile).catch(() => null);
    if (cached && isAgentConfig(cached)) {
      this.config = cached;
      log.info('Loaded cached configuration', { configVersion: cached.configVersion, jobs: cached.jobs.length });
    }
  }

  /** Fetches the configuration if Core reports a newer version (or always when forced). */
  async refresh(knownVersion?: number, force = false): Promise<boolean> {
    if (!force && knownVersion !== undefined && knownVersion === this.config.configVersion) return false;
    const client = this.client();
    if (!client) return false;
    const next = await client.request<AgentConfig>('GET', '/api/v1/agent/config');
    if (!isAgentConfig(next)) throw new Error('Core sent an invalid configuration');
    // Validate secrets can be opened before accepting the config.
    if (next.secrets) openConfigSecrets(this.nodeSecret, next.secrets);
    this.config = next;
    await writeJson(this.cacheFile, next, 0o600);
    log.info('Configuration updated', { configVersion: next.configVersion, jobs: next.jobs.length });
    this.emit('changed', next);
    return true;
  }

  secretsFor(jobId: string): JobSecrets {
    if (!this.config.secrets) return {};
    const all = openConfigSecrets<Record<string, JobSecrets>>(this.nodeSecret, this.config.secrets);
    return all[jobId] ?? {};
  }

  job(jobId: string): JobConfig | undefined {
    return this.config.jobs.find((j) => j.id === jobId);
  }
}

export function isAgentConfig(v: unknown): v is AgentConfig {
  const c = v as AgentConfig;
  return (
    !!c &&
    Number.isInteger(c.configVersion) &&
    Array.isArray(c.jobs) &&
    typeof c.monitoring === 'object' &&
    Array.isArray(c.monitoring?.services) &&
    c.jobs.every((j) => typeof j?.id === 'string' && typeof j.schedule === 'string' && ['FILES', 'MYSQL', 'POSTGRES'].includes(j.type))
  );
}
