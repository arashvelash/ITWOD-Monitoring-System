import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CommandOrigin, CommandStatus, NodeCommand, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { signCommand, SignedCommand } from '../crypto/node-protocol';
import { RedisLockService } from '../redis/redis-lock.service';
import { ALLOWED_COMMANDS, AgentCommandType, COMMAND_TTL_SEC } from './agent.constants';
import { ConnectionRegistry } from './connection-registry';
import { NodeAuthService } from './node-auth.service';

export interface EnqueueOptions {
  origin?: CommandOrigin;
  createdById?: string | null;
  ttlSec?: number;
}

type CompletionListener = (command: NodeCommand) => Promise<void> | void;

const OPEN_STATUSES: CommandStatus[] = ['PENDING', 'SENT', 'ACKNOWLEDGED'];

/**
 * Durable, signed, expiring command queue for agents.
 * Commands are stored first and then pushed over WebSocket when the node is
 * connected; otherwise they are delivered on reconnect or on the next poll.
 */
@Injectable()
export class CommandsService {
  private readonly logger = new Logger(CommandsService.name);
  private readonly listeners = new Map<string, CompletionListener[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectionRegistry,
    private readonly nodeAuth: NodeAuthService,
    private readonly locks: RedisLockService,
  ) {}

  /** Other modules subscribe to completion of a command type (e.g. agent.update). */
  onCompleted(type: AgentCommandType, listener: CompletionListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  async enqueue(serverId: string, type: AgentCommandType, payload: Record<string, unknown>, opts: EnqueueOptions = {}): Promise<NodeCommand> {
    if (!ALLOWED_COMMANDS.includes(type)) throw new BadRequestException('Command type not allowed');
    const ttl = opts.ttlSec ?? COMMAND_TTL_SEC[type];
    const command = await this.prisma.nodeCommand.create({
      data: {
        serverId,
        type,
        payload: payload as Prisma.InputJsonValue,
        origin: opts.origin ?? 'DASHBOARD',
        createdById: opts.createdById ?? null,
        expiresAt: new Date(Date.now() + ttl * 1000),
      },
    });
    if (this.registry.isConnected(serverId)) {
      await this.push(command).catch((err: Error) => this.logger.warn(`Immediate delivery failed for ${command.id}: ${err.message}`));
    }
    return command;
  }

  /** Builds the signed wire representation of a command. */
  sign(command: Pick<NodeCommand, 'id' | 'type' | 'payload' | 'createdAt' | 'expiresAt'>, secret: string): SignedCommand {
    return signCommand(secret, {
      id: command.id,
      command: command.type,
      issuedAt: Math.floor(command.createdAt.getTime() / 1000),
      expiresAt: Math.floor(command.expiresAt.getTime() / 1000),
      payload: JSON.stringify(command.payload ?? {}),
    });
  }

  /** Sends all undelivered commands to a freshly connected node. */
  async deliverPending(serverId: string): Promise<number> {
    const pending = await this.prisma.nodeCommand.findMany({
      where: { serverId, status: { in: ['PENDING', 'SENT'] }, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    let sent = 0;
    for (const c of pending) if (await this.push(c)) sent++;
    return sent;
  }

  /** HTTP polling (cPanel agents): returns signed pending commands and marks them sent. */
  async poll(serverId: string, secret: string): Promise<SignedCommand[]> {
    const pending = await this.prisma.nodeCommand.findMany({
      where: { serverId, status: { in: ['PENDING', 'SENT'] }, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    if (!pending.length) return [];
    await this.prisma.nodeCommand.updateMany({
      where: { id: { in: pending.map((c) => c.id) } },
      data: { status: 'SENT', sentAt: new Date(), deliveryCount: { increment: 1 } },
    });
    return pending.map((c) => this.sign(c, secret));
  }

  async acknowledge(serverId: string, commandId: string): Promise<void> {
    await this.prisma.nodeCommand.updateMany({
      where: { id: commandId, serverId, status: { in: ['PENDING', 'SENT'] } },
      data: { status: 'ACKNOWLEDGED', acknowledgedAt: new Date() },
    });
  }

  async complete(serverId: string, commandId: string, succeeded: boolean, result?: unknown, error?: string): Promise<void> {
    const updated = await this.prisma.nodeCommand.updateMany({
      where: { id: commandId, serverId, status: { in: OPEN_STATUSES } },
      data: {
        status: succeeded ? 'SUCCEEDED' : 'FAILED',
        completedAt: new Date(),
        result: result === undefined ? undefined : (result as Prisma.InputJsonValue),
        errorMessage: error ? error.slice(0, 2000) : null,
      },
    });
    if (updated.count === 0) return;
    const command = await this.prisma.nodeCommand.findUnique({ where: { id: commandId } });
    if (!command) return;
    for (const listener of this.listeners.get(command.type) ?? []) {
      try {
        await listener(command);
      } catch (err) {
        this.logger.error(`Command listener for ${command.type} failed: ${(err as Error).message}`);
      }
    }
  }

  list(serverId: string, take = 50) {
    return this.prisma.nodeCommand.findMany({ where: { serverId }, orderBy: { createdAt: 'desc' }, take });
  }

  /** Expires commands that were never completed in time. */
  @Cron(CronExpression.EVERY_MINUTE)
  async expireStale(): Promise<void> {
    await this.locks.runExclusive('commands.expire', 50_000, async () => {
      const res = await this.prisma.nodeCommand.updateMany({
        where: { status: { in: OPEN_STATUSES }, expiresAt: { lt: new Date() } },
        data: { status: 'EXPIRED', completedAt: new Date() },
      });
      if (res.count) this.logger.log(`Expired ${res.count} command(s)`);
    });
  }

  private async push(command: NodeCommand): Promise<boolean> {
    const secret = await this.nodeAuth.secretFor(command.serverId);
    if (!secret) return false;
    if (!this.registry.send(command.serverId, this.sign(command, secret))) return false;
    await this.prisma.nodeCommand.updateMany({
      where: { id: command.id, status: { in: ['PENDING', 'SENT'] } },
      data: { status: 'SENT', sentAt: new Date(), deliveryCount: { increment: 1 } },
    });
    return true;
  }
}
