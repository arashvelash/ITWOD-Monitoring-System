/**
 * Minimal Telegram Bot API client (only the methods IMS needs).
 * The bot token is part of the URL, so it is scrubbed from every error message.
 */
export class TelegramApiError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export class TelegramApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new TelegramApiError(0, this.scrub(`Telegram API unreachable: ${(err as Error).message}`));
    }
    let data: { ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      throw new TelegramApiError(res.status, `Telegram API returned HTTP ${res.status}`);
    }
    if (!data.ok) throw new TelegramApiError(data.error_code ?? res.status, this.scrub(data.description ?? 'Telegram API error'), data.parameters?.retry_after);
    return data.result as T;
  }

  getMe() {
    return this.call<TgUser>('getMe');
  }

  deleteWebhook() {
    return this.call<boolean>('deleteWebhook', { drop_pending_updates: false });
  }

  getUpdates(offset: number, timeoutSec: number) {
    return this.call<TgUpdate[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] }, (timeoutSec + 10) * 1000);
  }

  sendMessage(chatId: string | number, text: string, keyboard?: InlineButton[][]) {
    return this.call<TgMessage>('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }

  editMessageText(chatId: string | number, messageId: number, text: string) {
    return this.call<TgMessage>('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
  }

  answerCallbackQuery(id: string, text?: string) {
    return this.call<boolean>('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
  }

  private scrub(message: string): string {
    return message.split(this.token).join('<token>');
  }
}
