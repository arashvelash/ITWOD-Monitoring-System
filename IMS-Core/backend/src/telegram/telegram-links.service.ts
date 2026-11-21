import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { generateHumanCode, sha256Hex } from '../crypto/tokens';
import type { AuthUser } from '../common/types/request';

const CODE_TTL_MS = 10 * 60_000;

/** Links Telegram chats to IMS users via short-lived one-time codes. */
@Injectable()
export class TelegramLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async createCode(user: AuthUser) {
    // Only one active code per user.
    await this.prisma.telegramLinkCode.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
    const code = generateHumanCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await this.prisma.telegramLinkCode.create({ data: { userId: user.id, codeHash: sha256Hex(code.toUpperCase()), expiresAt } });
    await this.audit.byUser(user, 'telegram.link_code');
    return { code, expiresAt };
  }

  /** Consumes a code sent from a private chat. Returns the linked user or null. */
  async consumeCode(rawCode: string, chat: { chatId: bigint; telegramUserId: bigint; username?: string }) {
    const code = rawCode.trim().toUpperCase();
    if (!/^IMS-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) return null;
    const record = await this.prisma.telegramLinkCode.findUnique({ where: { codeHash: sha256Hex(code) }, include: { user: true } });
    if (!record || record.usedAt || record.expiresAt < new Date() || !record.user.isActive) return null;
    const claimed = await this.prisma.telegramLinkCode.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) return null;

    await this.prisma.telegramLink.upsert({
      where: { chatId: chat.chatId },
      create: { userId: record.userId, chatId: chat.chatId, telegramUserId: chat.telegramUserId, telegramUsername: chat.username?.slice(0, 64) ?? null },
      update: { userId: record.userId, telegramUserId: chat.telegramUserId, telegramUsername: chat.username?.slice(0, 64) ?? null, linkedAt: new Date() },
    });
    await this.audit.record({ actorType: 'TELEGRAM', actorId: record.userId, actorName: record.user.username, action: 'telegram.linked', metadata: { telegramUser: chat.username ?? null } });
    return record.user;
  }

  async findByChat(chatId: bigint) {
    const link = await this.prisma.telegramLink.findUnique({ where: { chatId }, include: { user: true } });
    return link && link.user.isActive ? link : null;
  }

  async unlinkChat(chatId: bigint): Promise<boolean> {
    const res = await this.prisma.telegramLink.deleteMany({ where: { chatId } });
    return res.count > 0;
  }

  async list(user: AuthUser) {
    const links = await this.prisma.telegramLink.findMany({
      where: user.role === UserRole.ADMIN ? {} : { userId: user.id },
      include: { user: { select: { id: true, username: true, role: true } } },
      orderBy: { linkedAt: 'desc' },
    });
    return links.map((l) => ({ ...l, chatId: l.chatId.toString(), telegramUserId: l.telegramUserId.toString() }));
  }

  async update(id: string, notificationsEnabled: boolean, user: AuthUser) {
    await this.assertAccess(id, user);
    await this.prisma.telegramLink.update({ where: { id }, data: { notificationsEnabled } });
  }

  async remove(id: string, user: AuthUser) {
    await this.assertAccess(id, user);
    await this.prisma.telegramLink.delete({ where: { id } });
    await this.audit.byUser(user, 'telegram.unlinked', { type: 'telegram_link', id });
  }

  /** Chats that should receive notifications. */
  async notificationChats(): Promise<string[]> {
    const links = await this.prisma.telegramLink.findMany({ where: { notificationsEnabled: true, user: { isActive: true } }, select: { chatId: true } });
    return links.map((l) => l.chatId.toString());
  }

  async disableNotificationsForChat(chatId: string): Promise<void> {
    await this.prisma.telegramLink.updateMany({ where: { chatId: BigInt(chatId) }, data: { notificationsEnabled: false } });
  }

  private async assertAccess(id: string, user: AuthUser) {
    const link = await this.prisma.telegramLink.findUnique({ where: { id } });
    if (!link) throw new NotFoundException('Link not found');
    if (link.userId !== user.id && user.role !== UserRole.ADMIN) throw new ForbiddenException('Not your link');
  }
}
