import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { SettingsService } from '../settings/settings.service';
import { INTERNAL_KEYS } from '../settings/settings.registry';
import { RedisLockService } from '../redis/redis-lock.service';
import { TelegramApi, TelegramApiError, TgUpdate, TgUser } from './telegram-api';
import { TelegramCommandsService } from './telegram-commands.service';

const LOCK = 'telegram.poller';
const LOCK_TTL_MS = 90_000;
const POLL_TIMEOUT_SEC = 25;

export interface BotStatus {
  running: boolean;
  bot: { id: number; username: string; firstName: string } | null;
  lastError: string | null;
}

/**
 * Long-polling Telegram bot. Long polling needs no inbound webhook, so Core
 * does not have to expose anything extra. A Redis lock guarantees only one
 * backend instance polls at a time.
 */
@Injectable()
export class TelegramBotService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TelegramBotService.name);
  private api: TelegramApi | null = null;
  private generation = 0;
  private status: BotStatus = { running: false, bot: null, lastError: null };

  constructor(
    private readonly settings: SettingsService,
    private readonly locks: RedisLockService,
    private readonly commands: TelegramCommandsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    void this.restart();
  }

  onApplicationShutdown(): void {
    this.generation++;
  }

  getStatus(): BotStatus {
    return { ...this.status };
  }

  /** API client for sending messages (null when the bot is not configured). */
  async client(): Promise<TelegramApi | null> {
    if (this.api) return this.api;
    const token = await this.settings.getSecret('telegram.botToken');
    return token ? new TelegramApi(this.config.telegramApiBase, token) : null;
  }

  /** Validates a token without storing it. */
  async verifyToken(token: string): Promise<TgUser> {
    return new TelegramApi(this.config.telegramApiBase, token).getMe();
  }

  /** (Re)starts polling according to the current settings. */
  async restart(): Promise<void> {
    const generation = ++this.generation;
    this.api = null;
    this.status = { running: false, bot: null, lastError: null };
    const cfg = await this.settings.get('telegram').catch(() => null);
    const token = await this.settings.getSecret('telegram.botToken').catch(() => null);
    if (!cfg?.enabled || !token) return;
    this.api = new TelegramApi(this.config.telegramApiBase, token);
    void this.loop(generation, this.api);
  }

  private async loop(generation: number, api: TelegramApi): Promise<void> {
    let backoff = 5_000;
    while (generation === this.generation) {
      const lockToken = await this.locks.acquire(LOCK, LOCK_TTL_MS).catch(() => null);
      if (!lockToken) {
        await sleep(30_000); // another instance is polling
        continue;
      }
      try {
        const me = await api.getMe();
        this.status = { running: true, bot: { id: me.id, username: me.username ?? '', firstName: me.first_name }, lastError: null };
        await api.deleteWebhook();
        this.logger.log(`Telegram bot @${me.username} polling`);
        let offset = (await this.settings.getInternal<number>(INTERNAL_KEYS.telegramOffset)) ?? 0;
        while (generation === this.generation) {
          await this.locks.extend(LOCK, lockToken, LOCK_TTL_MS);
          const updates = await api.getUpdates(offset, POLL_TIMEOUT_SEC);
          for (const update of updates) {
            offset = update.update_id + 1;
            await this.process(api, update);
          }
          if (updates.length) await this.settings.setInternal(INTERNAL_KEYS.telegramOffset, offset);
          backoff = 5_000;
        }
      } catch (err) {
        const message = (err as Error).message;
        this.status = { ...this.status, running: false, lastError: message };
        const wait = err instanceof TelegramApiError && err.retryAfterSec ? err.retryAfterSec * 1000 : backoff;
        this.logger.warn(`Telegram polling error: ${message}; retrying in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        backoff = Math.min(backoff * 2, 5 * 60_000);
      } finally {
        await this.locks.release(LOCK, lockToken).catch(() => undefined);
      }
    }
    this.status = { ...this.status, running: false };
  }

  private async process(api: TelegramApi, update: TgUpdate): Promise<void> {
    try {
      if (update.message) {
        const reply = await this.commands.handleMessage(update.message);
        if (reply) await api.sendMessage(update.message.chat.id, reply.text, reply.keyboard);
      } else if (update.callback_query) {
        const cb = update.callback_query;
        const outcome = await this.commands.handleCallback(cb);
        await api.answerCallbackQuery(cb.id, outcome.answer).catch(() => undefined);
        if (outcome.editText && cb.message) await api.editMessageText(cb.message.chat.id, cb.message.message_id, outcome.editText).catch(() => undefined);
      }
    } catch (err) {
      this.logger.error(`Failed to handle Telegram update ${update.update_id}: ${(err as Error).message}`);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());
