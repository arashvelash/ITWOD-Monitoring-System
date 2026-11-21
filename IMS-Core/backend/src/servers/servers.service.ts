import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Server } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { generateToken, sha256Hex, TOKEN_PREFIX } from '../crypto/tokens';
import type { AuthUser } from '../common/types/request';
import type { ClientContext } from '../common/utils/request-context';
import { ConnectionRegistry } from '../agents/connection-registry';
import { CommandsService } from '../agents/commands.service';
import { AgentConfigService } from '../agents/agent-config.service';
import { WS_CLOSE } from '../agents/agent.constants';
import { CreateServerInput, formatNodeId, ListServersQuery, UpdateServerInput } from './servers.schemas';

const CREDENTIAL_SUMMARY = { select: { keyFingerprint: true, keyAlgorithm: true, issuedAt: true, lastUsedAt: true, revokedAt: true } } as const;

@Injectable()
export class ServersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly registry: ConnectionRegistry,
    private readonly commands: CommandsService,
    private readonly agentConfig: AgentConfigService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(q: ListServersQuery) {
    const where: Prisma.ServerWhereInput = {
      ...(q.status ? { status: q.status } : { status: { not: 'DECOMMISSIONED' } }),
      ...(q.type ? { type: q.type } : {}),
      ...(q.search
        ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { nodeId: { contains: q.search } }, { hostname: { contains: q.search, mode: 'insensitive' } }] }
        : {}),
    };
    const servers = await this.prisma.server.findMany({
      where,
      orderBy: [{ name: 'asc' }],
      include: { credential: CREDENTIAL_SUMMARY, _count: { select: { alerts: { where: { status: { not: 'RESOLVED' } } }, backupJobs: { where: { archivedAt: null } } } } },
    });
    return servers.map(({ _count, ...s }) => ({ ...s, connected: this.registry.isConnected(s.id), openAlerts: _count.alerts, jobCount: _count.backupJobs }));
  }

  async get(id: string) {
    const server = await this.prisma.server.findUnique({ where: { id }, include: { credential: CREDENTIAL_SUMMARY } });
    if (!server) throw new NotFoundException('Server not found');
    const openAlerts = await this.prisma.alert.count({ where: { serverId: id, status: { not: 'RESOLVED' } } });
    const pendingToken = await this.prisma.registrationToken.findFirst({
      where: { serverId: id, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { tokenPrefix: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return { ...server, connected: this.registry.isConnected(id), openAlerts, pendingToken };
  }

  async create(input: CreateServerInput, actor: AuthUser, ctx: ClientContext) {
    const server = await this.prisma.$transaction(async (tx) => {
      const created = await tx.server.create({
        data: {
          nodeId: `pending-${randomUUID()}`,
          name: input.name,
          type: input.type,
          operatingSystem: input.operatingSystem,
          description: input.description ?? null,
          tags: input.tags,
          createdById: actor.id,
        },
      });
      return tx.server.update({ where: { id: created.id }, data: { nodeId: formatNodeId(created.serial) } });
    });
    const registration = await this.createRegistrationToken(server, actor.id);
    await this.audit.byUser(actor, 'server.create', { type: 'server', id: server.id }, { nodeId: server.nodeId, type: server.type }, ctx);
    return registration;
  }

  async update(id: string, input: UpdateServerInput, actor: AuthUser, ctx: ClientContext) {
    const existing = await this.prisma.server.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Server not found');
    const monitoringChanged = input.monitoredServices !== undefined;
    const server = await this.prisma.server.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.operatingSystem !== undefined ? { operatingSystem: input.operatingSystem } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(monitoringChanged
          ? { monitoringConfig: input.monitoredServices === null ? Prisma.DbNull : ({ services: input.monitoredServices } as Prisma.InputJsonValue), configVersion: { increment: 1 } }
          : {}),
      },
    });
    if (monitoringChanged) await this.notifyConfigChanged(id);
    await this.audit.byUser(actor, 'server.update', { type: 'server', id }, { fields: Object.keys(input) }, ctx);
    return server;
  }

  /** Issues a fresh one-time registration token (initial install or re-enrolment after revocation). */
  async issueToken(id: string, actor: AuthUser, ctx: ClientContext) {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('Server not found');
    if (server.status !== 'PENDING' && server.status !== 'REVOKED') {
      throw new BadRequestException('Revoke the current node credential before issuing a new registration token');
    }
    const registration = await this.createRegistrationToken(server, actor.id);
    await this.audit.byUser(actor, 'server.registration_token', { type: 'server', id }, undefined, ctx);
    return registration;
  }

  /**
   * Revokes the node credential. The agent is disconnected immediately and can
   * no longer authenticate. Nothing on the managed server itself is touched.
   */
  async revoke(id: string, actor: AuthUser, ctx: ClientContext) {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('Server not found');
    if (server.status === 'DECOMMISSIONED') throw new BadRequestException('Server is decommissioned');
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.nodeCredential.updateMany({ where: { serverId: id, revokedAt: null }, data: { revokedAt: now } }),
      this.prisma.registrationToken.updateMany({ where: { serverId: id, usedAt: null, revokedAt: null }, data: { revokedAt: now } }),
      this.prisma.nodeCommand.updateMany({ where: { serverId: id, status: { in: ['PENDING', 'SENT', 'ACKNOWLEDGED'] } }, data: { status: 'EXPIRED', completedAt: now } }),
      this.prisma.server.update({ where: { id }, data: { status: 'REVOKED' } }),
    ]);
    this.registry.disconnect(id, WS_CLOSE.forbidden, 'Credential revoked');
    await this.audit.byUser(actor, 'server.revoke', { type: 'server', id }, { nodeId: server.nodeId }, ctx);
    return this.get(id);
  }

  /** Retires a server: revokes access and hides it from lists. History is preserved. */
  async decommission(id: string, actor: AuthUser, ctx: ClientContext) {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('Server not found');
    if (server.status !== 'REVOKED' && server.status !== 'DECOMMISSIONED') await this.revoke(id, actor, ctx);
    await this.prisma.$transaction([
      this.prisma.server.update({ where: { id }, data: { status: 'DECOMMISSIONED' } }),
      this.prisma.backupJob.updateMany({ where: { serverId: id, archivedAt: null }, data: { enabled: false, archivedAt: new Date() } }),
    ]);
    await this.audit.byUser(actor, 'server.decommission', { type: 'server', id }, { nodeId: server.nodeId }, ctx);
  }

  async ping(id: string, actor: AuthUser) {
    await this.assertActive(id);
    return this.commands.enqueue(id, 'ping', {}, { createdById: actor.id });
  }

  async requestConfigSync(id: string, actor: AuthUser) {
    await this.assertActive(id);
    return this.commands.enqueue(id, 'config.sync', {}, { createdById: actor.id });
  }

  listCommands(id: string) {
    return this.commands.list(id);
  }

  /** Called whenever something in the node configuration changed. */
  async notifyConfigChanged(serverId: string): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId }, select: { status: true } });
    if (!server || server.status === 'PENDING' || server.status === 'REVOKED' || server.status === 'DECOMMISSIONED') return;
    await this.commands.enqueue(serverId, 'config.sync', {}, { origin: 'SYSTEM' });
  }

  async coreUrl(): Promise<string> {
    const general = await this.settings.get('general');
    return (general.publicUrl ?? this.config.publicUrl ?? '').replace(/\/+$/, '');
  }

  private async assertActive(id: string) {
    const s = await this.prisma.server.findUnique({ where: { id }, select: { status: true } });
    if (!s) throw new NotFoundException('Server not found');
    if (s.status === 'PENDING' || s.status === 'REVOKED' || s.status === 'DECOMMISSIONED') throw new BadRequestException('The agent of this server is not registered');
  }

  private async createRegistrationToken(server: Server, createdById: string) {
    const security = await this.settings.get('security');
    const token = generateToken(TOKEN_PREFIX.registration, 24);
    const expiresAt = new Date(Date.now() + security.registrationTokenTtlHours * 3_600_000);
    await this.prisma.$transaction([
      this.prisma.registrationToken.updateMany({ where: { serverId: server.id, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } }),
      this.prisma.registrationToken.create({ data: { serverId: server.id, tokenHash: sha256Hex(token), tokenPrefix: token.slice(0, 12), expiresAt, createdById } }),
    ]);
    const coreUrl = await this.coreUrl();
    const base = coreUrl || 'https://<your-core-domain>';
    const installCommand =
      server.type === 'UBUNTU'
        ? `curl -fsSL ${base}/install-agent.sh | sudo bash`
        : `php ~/ims-agent/cron/register.php --core-url=${base} --token=${token}`;
    return { server: await this.get(server.id), registrationToken: token, expiresAt, installCommand, coreUrl: base };
  }
}
