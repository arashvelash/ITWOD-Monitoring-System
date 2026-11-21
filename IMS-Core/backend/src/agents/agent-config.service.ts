import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { sealConfigSecrets, SecretsEnvelope } from '../crypto/node-protocol';
import type { AuthenticatedNode } from '../common/types/request';
import { AGENT_DEFAULTS } from './agent.constants';

export interface JobsContribution {
  jobs: unknown[];
  /** Per-job secrets; sealed with a key derived from the node secret before sending. */
  secrets: Record<string, Record<string, string>>;
}

export type JobsProvider = (serverId: string) => Promise<JobsContribution>;

export interface AgentConfigPayload {
  configVersion: number;
  heartbeatIntervalSec: number;
  metricsIntervalSec: number;
  monitoring: { services: string[] };
  backup: { localDirectory: string };
  jobs: unknown[];
  secrets: SecretsEnvelope | null;
}

/** Builds the configuration document an agent fetches from GET /agent/config. */
@Injectable()
export class AgentConfigService {
  private jobsProvider: JobsProvider = async () => ({ jobs: [], secrets: {} });

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  setJobsProvider(provider: JobsProvider): void {
    this.jobsProvider = provider;
  }

  async currentVersion(serverId: string): Promise<number> {
    const s = await this.prisma.server.findUnique({ where: { id: serverId }, select: { configVersion: true } });
    return s?.configVersion ?? 0;
  }

  async build(node: AuthenticatedNode): Promise<AgentConfigPayload> {
    const [server, monitoring] = await Promise.all([
      this.prisma.server.findUniqueOrThrow({ where: { id: node.serverId }, select: { configVersion: true, monitoringConfig: true } }),
      this.settings.get('monitoring'),
    ]);
    const { jobs, secrets } = await this.jobsProvider(node.serverId);
    const monitoringConfig = (server.monitoringConfig ?? {}) as { services?: string[] };
    return {
      configVersion: server.configVersion,
      heartbeatIntervalSec: AGENT_DEFAULTS.heartbeatIntervalSec,
      metricsIntervalSec: AGENT_DEFAULTS.metricsIntervalSec,
      monitoring: { services: monitoringConfig.services ?? monitoring.defaultServices },
      backup: { localDirectory: node.type === 'CPANEL' ? '~/ims-backups' : '/var/backups/ims' },
      jobs,
      secrets: Object.keys(secrets).length ? sealConfigSecrets(node.secret, JSON.stringify(secrets)) : null,
    };
  }

  /** Marks the node's configuration as changed; agents re-fetch on the next heartbeat ack / config.sync. */
  async bump(serverId: string): Promise<number> {
    const s = await this.prisma.server.update({ where: { id: serverId }, data: { configVersion: { increment: 1 } }, select: { configVersion: true } });
    return s.configVersion;
  }
}
