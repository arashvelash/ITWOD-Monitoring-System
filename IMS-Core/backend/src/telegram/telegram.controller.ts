import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser, RequireRole } from '../common/decorators/auth.decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import type { AuthUser } from '../common/types/request';
import { getClientContext } from '../common/utils/request-context';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { SETTING_SECTIONS } from '../settings/settings.registry';
import { telegramBotTokenSchema } from '../setup/setup.schemas';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramLinksService } from './telegram-links.service';
import { esc } from './telegram-format';

const configSchema = SETTING_SECTIONS.telegram.schema
  .partial()
  .extend({ botToken: telegramBotTokenSchema.nullable().optional() })
  .strict();

@Controller('telegram')
export class TelegramController {
  constructor(
    private readonly bot: TelegramBotService,
    private readonly links: TelegramLinksService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get('status')
  @RequireRole(UserRole.ADMIN)
  async status(@CurrentUser() user: AuthUser) {
    const [cfg, tokenConfigured, links] = await Promise.all([this.settings.get('telegram'), this.settings.hasSecret('telegram.botToken'), this.links.list(user)]);
    return { ...cfg, tokenConfigured, ...this.bot.getStatus(), links };
  }

  @Put('config')
  @RequireRole(UserRole.ADMIN)
  async configure(@Body(new ZodValidationPipe(configSchema)) body: z.infer<typeof configSchema>, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const { botToken, ...rest } = body;
    if (botToken) {
      try {
        await this.bot.verifyToken(botToken);
      } catch (err) {
        throw new BadRequestException(`Telegram rejected the bot token: ${(err as Error).message}`);
      }
      await this.settings.setSecret('telegram.botToken', botToken, user.id);
    } else if (botToken === null) {
      await this.settings.setSecret('telegram.botToken', null, user.id);
    }
    const updated = await this.settings.update('telegram', rest, user.id);
    await this.audit.byUser(user, 'telegram.configure', { type: 'settings', id: 'telegram' }, { fields: Object.keys(rest), tokenChanged: botToken !== undefined }, getClientContext(req));
    await this.bot.restart();
    return { ...updated, tokenConfigured: await this.settings.hasSecret('telegram.botToken') };
  }

  @Post('test')
  @HttpCode(200)
  @RequireRole(UserRole.ADMIN)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async test(@CurrentUser() user: AuthUser) {
    const api = await this.bot.client();
    if (!api) throw new BadRequestException('Configure a bot token first');
    const own = (await this.links.list(user)).filter((l) => l.userId === user.id);
    if (!own.length) throw new BadRequestException('Link your own Telegram account first (Account › Telegram)');
    for (const link of own) await api.sendMessage(link.chatId, `✅ Test notification from IMS for <b>${esc(user.username)}</b>.`);
    return { sent: own.length };
  }

  @Post('link-code')
  @Throttle({ default: { limit: 10, ttl: 600_000 } })
  async linkCode(@CurrentUser() user: AuthUser) {
    const { code, expiresAt } = await this.links.createCode(user);
    return { code, expiresAt, botUsername: this.bot.getStatus().bot?.username ?? null };
  }

  @Get('links')
  listLinks(@CurrentUser() user: AuthUser) {
    return this.links.list(user);
  }

  @Patch('links/:id')
  @HttpCode(204)
  async updateLink(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(z.object({ notificationsEnabled: z.boolean() }).strict())) body: { notificationsEnabled: boolean }, @CurrentUser() user: AuthUser): Promise<void> {
    await this.links.update(id, body.notificationsEnabled, user);
  }

  @Delete('links/:id')
  @HttpCode(204)
  async removeLink(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser): Promise<void> {
    await this.links.remove(id, user);
  }
}
