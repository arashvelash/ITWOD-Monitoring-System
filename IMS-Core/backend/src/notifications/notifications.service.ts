import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { AlertType } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { DomainEvents } from '../events/domain-events.service';
import { TelegramLinksService } from '../telegram/telegram-links.service';
import { alertMessage, backupMessage, esc, nodeStatusMessage } from '../telegram/telegram-format';

export const NOTIFICATION_QUEUE = 'notifications';

const DEDICATED_NOTIFICATION_TYPES = new Set<AlertType>(['NODE_OFFLINE', 'BACKUP_FAILED', 'AGENT_UPDATE_FAILED']);

export interface TelegramNotificationJob {
  channel: 'telegram';
  chatId: string;
  text: string;
}

/**
 * Turns domain events into notifications. Delivery happens asynchronously in
 * the BullMQ worker with retries, so a slow or blocked Telegram API never
 * delays request handling or agent report ingestion.
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectQueue(NOTIFICATION_QUEUE) private readonly queue: Queue<TelegramNotificationJob>,
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly events: DomainEvents,
    private readonly links: TelegramLinksService,
  ) {}

  onModuleInit(): void {
    this.events.on('backup.finished', async ({ run, job, server }) => {
      const cfg = await this.settings.get('telegram');
      if (run.status === 'SUCCESS' ? !cfg.notifyBackupSuccess : !cfg.notifyBackupFailure) return;
      await this.broadcast(
        backupMessage({ jobName: job.name, serverName: server.name, status: run.status, sizeBytes: run.sizeBytes, durationMs: run.durationMs, error: run.errorMessage, trigger: run.trigger }, await this.instanceName()),
      );
    });
    this.events.on('alert.opened', async ({ alert }) => this.alert(alert.id, false));
    this.events.on('alert.resolved', async ({ alert }) => this.alert(alert.id, true));
    this.events.on('node.online', async ({ serverId }) => this.nodeStatus(serverId, true));
    this.events.on('node.offline', async ({ serverId }) => this.nodeStatus(serverId, false));
    this.events.on('agent.update.finished', async ({ serverId, version, succeeded, error }) => {
      const server = await this.prisma.server.findUnique({ where: { id: serverId }, select: { name: true } });
      await this.broadcast(`${succeeded ? '⬆️' : '❌'} <b>Agent update ${succeeded ? 'completed' : 'failed'}</b>\n${esc(server?.name ?? serverId)} → v${esc(version)}${error ? `\n<code>${esc(error)}</code>` : ''}`);
    });
    this.events.on('core.update.finished', async ({ fromVersion, toVersion, status, message }) => {
      const ok = status === 'SUCCEEDED';
      const label = ok ? 'completed' : status === 'ROLLED_BACK' ? 'failed and was rolled back' : 'failed';
      await this.broadcast(`${ok ? '⬆️' : '❌'} <b>IMS-Core update ${label}</b>\nv${esc(fromVersion)} → v${esc(toVersion)}${!ok && message ? `\n<code>${esc(message)}</code>` : ''}`);
    });
  }

  /** Sends a message to all notification recipients (linked chats + broadcast chats). */
  async broadcast(text: string): Promise<number> {
    const cfg = await this.settings.get('telegram');
    if (!cfg.enabled) return 0;
    const chats = [...new Set([...(await this.links.notificationChats()), ...cfg.broadcastChatIds])];
    await Promise.all(
      chats.map((chatId) =>
        this.queue.add('telegram', { channel: 'telegram', chatId, text }, { attempts: 6, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 500, removeOnFail: 1000 }),
      ),
    );
    return chats.length;
  }

  /** Direct message to one chat (used by the "send test" button). */
  async sendTo(chatId: string, text: string): Promise<void> {
    await this.queue.add('telegram', { channel: 'telegram', chatId, text }, { attempts: 3, backoff: { type: 'exponential', delay: 3_000 }, removeOnComplete: 100, removeOnFail: 100 });
  }

  private async alert(alertId: string, resolved: boolean) {
    const cfg = await this.settings.get('telegram');
    if (!cfg.notifyAlerts) return;
    const alert = await this.prisma.alert.findUnique({ where: { id: alertId }, include: { server: { select: { name: true } } } });
    // These alert types already have a dedicated notification (node status,
    // backup result, agent update result); avoid sending the same news twice.
    if (!alert || DEDICATED_NOTIFICATION_TYPES.has(alert.type)) return;
    await this.broadcast(alertMessage({ title: alert.title, message: alert.message, severity: alert.severity, serverName: alert.server?.name, resolved }, await this.instanceName()));
  }

  private async nodeStatus(serverId: string, online: boolean) {
    const cfg = await this.settings.get('telegram');
    if (!cfg.notifyNodeStatus) return;
    const server = await this.prisma.server.findUnique({ where: { id: serverId }, select: { name: true, nodeId: true } });
    if (!server) return;
    await this.broadcast(nodeStatusMessage(server.name, server.nodeId, online, await this.instanceName()));
  }

  private async instanceName(): Promise<string> {
    return (await this.settings.get('general')).instanceName;
  }
}
