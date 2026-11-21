import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedNode } from '../common/types/request';
import { CommandsService } from './commands.service';

/** Report types an agent may send (WebSocket frames or batched HTTPS reports). */
export const REPORT_TYPES = ['heartbeat', 'metrics', 'command.ack', 'command.result', 'backup.report'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export type ReportHandler = (node: AuthenticatedNode, data: unknown) => Promise<void>;

const heartbeatSchema = z
  .object({
    uptimeSec: z.number().nonnegative().optional(),
    agentVersion: z.string().max(32).optional(),
    hostname: z.string().max(255).optional(),
    os: z.string().max(255).optional(),
    arch: z.string().max(32).optional(),
  })
  .passthrough();

const ackSchema = z.object({ commandId: z.string().uuid() });
const resultSchema = z.object({
  commandId: z.string().uuid(),
  status: z.enum(['SUCCEEDED', 'FAILED']),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().max(4000).optional(),
});

export type NodeStatusListener = (serverId: string, status: 'ONLINE', previous: string) => Promise<void> | void;

/**
 * Single entry point for everything an agent reports, independent of transport.
 * Feature modules (backups, monitoring) register their handlers at startup,
 * which keeps this module free of circular dependencies.
 */
@Injectable()
export class AgentEventsService {
  private readonly logger = new Logger(AgentEventsService.name);
  private readonly handlers = new Map<string, ReportHandler>();
  private readonly onlineListeners: NodeStatusListener[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: CommandsService,
  ) {
    this.handlers.set('heartbeat', (node, data) => this.heartbeat(node, data));
    this.handlers.set('command.ack', async (node, data) => {
      const { commandId } = ackSchema.parse(data);
      await this.commands.acknowledge(node.serverId, commandId);
    });
    this.handlers.set('command.result', async (node, data) => {
      const r = resultSchema.parse(data);
      await this.commands.complete(node.serverId, r.commandId, r.status === 'SUCCEEDED', r.result, r.error);
    });
  }

  register(type: ReportType, handler: ReportHandler): void {
    this.handlers.set(type, handler);
  }

  onNodeOnline(listener: NodeStatusListener): void {
    this.onlineListeners.push(listener);
  }

  async dispatch(node: AuthenticatedNode, type: string, data: unknown): Promise<void> {
    const handler = this.handlers.get(type);
    if (!handler) {
      this.logger.debug(`Ignoring unknown report type "${type}" from ${node.nodeId}`);
      return;
    }
    await handler(node, data);
  }

  async heartbeat(node: AuthenticatedNode, data: unknown): Promise<void> {
    const hb = heartbeatSchema.parse(data ?? {});
    const previous = await this.prisma.server.findUnique({ where: { id: node.serverId }, select: { status: true } });
    await this.prisma.server.update({
      where: { id: node.serverId },
      data: {
        lastHeartbeatAt: new Date(),
        ...(previous && previous.status !== 'REVOKED' && previous.status !== 'DECOMMISSIONED' ? { status: 'ONLINE' } : {}),
        ...(hb.agentVersion ? { agentVersion: hb.agentVersion } : {}),
        ...(hb.hostname ? { hostname: hb.hostname } : {}),
        ...(hb.os ? { osDetails: hb.os } : {}),
        ...(hb.arch ? { arch: hb.arch } : {}),
      },
    });
    if (previous && previous.status === 'OFFLINE') {
      for (const l of this.onlineListeners) await Promise.resolve(l(node.serverId, 'ONLINE', previous.status)).catch(() => undefined);
    }
  }
}
