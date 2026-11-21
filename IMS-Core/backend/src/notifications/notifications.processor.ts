import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { TelegramApiError } from '../telegram/telegram-api';
import { TelegramBotService } from '../telegram/telegram-bot.service';
import { TelegramLinksService } from '../telegram/telegram-links.service';
import { NOTIFICATION_QUEUE, TelegramNotificationJob } from './notifications.service';

/** Delivers queued notifications. Failed attempts are retried with exponential back-off. */
@Processor(NOTIFICATION_QUEUE, { concurrency: 2, limiter: { max: 25, duration: 1000 } })
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(
    private readonly bot: TelegramBotService,
    private readonly links: TelegramLinksService,
  ) {
    super();
  }

  async process(job: Job<TelegramNotificationJob>): Promise<void> {
    const api = await this.bot.client();
    if (!api) return; // Telegram was disabled after the job was queued.
    try {
      await api.sendMessage(job.data.chatId, job.data.text);
    } catch (err) {
      if (err instanceof TelegramApiError && err.code === 403) {
        // The user blocked the bot or left the chat: stop notifying it instead of retrying.
        this.logger.warn(`Chat ${job.data.chatId} blocked the bot; disabling its notifications`);
        await this.links.disableNotificationsForChat(job.data.chatId);
        return;
      }
      if (err instanceof TelegramApiError && err.code === 400) {
        this.logger.warn(`Telegram rejected a notification: ${err.message}`);
        return;
      }
      throw err;
    }
  }
}
