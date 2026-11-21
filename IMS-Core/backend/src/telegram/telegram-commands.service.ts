import { Inject, Injectable, Logger } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS } from '../redis/redis.constants';
import { hasMinRole } from '../common/decorators/auth.decorators';
import { BackupRunsService } from '../backups/backup-runs.service';
import type { InlineButton, TgCallbackQuery, TgMessage } from './telegram-api';
import { ago, esc, formatBytes, icons } from './telegram-format';
import { TelegramLinksService } from './telegram-links.service';

export interface Reply {
  text: string;
  keyboard?: InlineButton[][];
}

export interface CallbackOutcome {
  answer: string;
  editText?: string;
}

const MAX_COMMANDS_PER_MINUTE = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const HELP: { cmd: string; text: string; role: UserRole }[] = [
  { cmd: '/status', text: 'Infrastructure overview', role: UserRole.VIEWER },
  { cmd: '/servers', text: 'List servers', role: UserRole.VIEWER },
  { cmd: '/server <node-id>', text: 'Details of one server', role: UserRole.VIEWER },
  { cmd: '/alerts', text: 'Open alerts', role: UserRole.VIEWER },
  { cmd: '/backups', text: 'Recent backup runs', role: UserRole.VIEWER },
  { cmd: '/jobs', text: 'Backup jobs', role: UserRole.VIEWER },
  { cmd: '/backup <job-id>', text: 'Run a backup job now (asks for confirmation)', role: UserRole.OPERATOR },
  { cmd: '/unlink', text: 'Disconnect this chat from IMS', role: UserRole.VIEWER },
];

/**
 * Telegram command handling. Only private chats linked to an active IMS user
 * are served, and the user's IMS role applies. There are no destructive
 * commands: the only state-changing action is starting a backup run.
 */
@Injectable()
export class TelegramCommandsService {
  private readonly logger = new Logger(TelegramCommandsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly links: TelegramLinksService,
    private readonly runs: BackupRunsService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async handleMessage(msg: TgMessage): Promise<Reply | null> {
    const text = msg.text?.trim();
    if (!text || !text.startsWith('/') || !msg.from || msg.from.is_bot) return null;
    // Commands are only accepted in 1:1 chats; groups receive notifications only.
    if (msg.chat.type !== 'private') return null;
    if (!(await this.withinRateLimit(msg.chat.id))) return { text: '⏱ Too many commands. Please wait a minute.' };

    const [rawCommand, ...args] = text.split(/\s+/);
    const command = rawCommand.toLowerCase().replace(/@\w+$/, '');
    const chatId = BigInt(msg.chat.id);

    if (command === '/link') return this.link(args[0] ?? '', chatId, msg);

    const link = await this.links.findByChat(chatId);
    if (!link || link.telegramUserId !== BigInt(msg.from.id)) {
      return command === '/start' || command === '/help'
        ? { text: this.unlinkedHelp() }
        : { text: '🔒 This chat is not linked to IMS. Send /start for instructions.' };
    }
    await this.prisma.telegramLink.update({ where: { id: link.id }, data: { lastCommandAt: new Date() } }).catch(() => undefined);
    const role = link.user.role;

    switch (command) {
      case '/start':
      case '/help':
        return { text: this.help(link.user.username, role) };
      case '/unlink':
        await this.links.unlinkChat(chatId);
        return { text: '👋 This chat was unlinked from IMS.' };
      case '/status':
        return this.status();
      case '/servers':
        return this.servers();
      case '/server':
        return this.server(args[0]);
      case '/alerts':
        return this.alerts();
      case '/backups':
        return this.recentRuns();
      case '/jobs':
        return this.jobs();
      case '/backup':
        if (!hasMinRole(role, UserRole.OPERATOR)) return { text: '⛔ Starting backups requires the operator role.' };
        return this.confirmBackup(args[0]);
      default:
        return { text: 'Unknown command. Send /help for the list of commands.' };
    }
  }

  async handleCallback(cb: TgCallbackQuery): Promise<CallbackOutcome> {
    const chat = cb.message?.chat;
    if (!chat || chat.type !== 'private' || !cb.data) return { answer: 'Not allowed' };
    const link = await this.links.findByChat(BigInt(chat.id));
    if (!link || link.telegramUserId !== BigInt(cb.from.id)) return { answer: 'This chat is not linked to IMS' };

    if (cb.data === 'cancel') return { answer: 'Cancelled', editText: '✖️ Cancelled.' };
    const match = /^run:([0-9a-f-]{36})$/.exec(cb.data);
    if (!match || !UUID.test(match[1])) return { answer: 'Unknown action' };
    if (!hasMinRole(link.user.role, UserRole.OPERATOR)) return { answer: 'Operator role required' };

    try {
      const run = await this.runs.trigger(match[1], { id: link.user.id, username: link.user.username }, 'TELEGRAM');
      return { answer: 'Backup started', editText: `⏳ Backup started (run <code>${esc(run.id.slice(0, 8))}</code>). You will be notified when it finishes.` };
    } catch (err) {
      return { answer: 'Could not start the backup', editText: `❌ ${esc((err as Error).message)}` };
    }
  }

  private async link(code: string, chatId: bigint, msg: TgMessage): Promise<Reply> {
    const user = await this.links.consumeCode(code, { chatId, telegramUserId: BigInt(msg.from!.id), username: msg.from!.username });
    if (!user) return { text: '❌ Invalid or expired link code. Generate a new one in IMS → Account → Telegram.' };
    return { text: `✅ Linked to IMS user <b>${esc(user.username)}</b>.\n\n${this.help(user.username, user.role)}` };
  }

  private unlinkedHelp(): string {
    return ['👋 <b>ITWOD Monitoring System</b>', '', 'To use this bot, link your IMS account:', '1. Open IMS → Account → Telegram', '2. Generate a link code', '3. Send <code>/link IMS-XXXX-XXXX</code> here'].join('\n');
  }

  private help(username: string, role: UserRole): string {
    const lines = HELP.filter((h) => hasMinRole(role, h.role)).map((h) => `${esc(h.cmd)} — ${esc(h.text)}`);
    return [`<b>IMS bot</b> · signed in as ${esc(username)} (${role.toLowerCase()})`, '', ...lines].join('\n');
  }

  private async status(): Promise<Reply> {
    const since = new Date(Date.now() - 86_400_000);
    const [servers, alerts, critical, runs] = await Promise.all([
      this.prisma.server.groupBy({ by: ['status'], _count: { _all: true }, where: { status: { in: ['ONLINE', 'OFFLINE', 'PENDING'] } } }),
      this.prisma.alert.count({ where: { status: { not: 'RESOLVED' } } }),
      this.prisma.alert.count({ where: { status: { not: 'RESOLVED' }, severity: 'CRITICAL' } }),
      this.prisma.backupRun.groupBy({ by: ['status'], _count: { _all: true }, where: { createdAt: { gte: since } } }),
    ]);
    const c = (rows: { status: string; _count: { _all: number } }[], s: string) => rows.find((r) => r.status === s)?._count._all ?? 0;
    return {
      text: [
        '📊 <b>Status</b>',
        `Servers: 🟢 ${c(servers, 'ONLINE')} online · 🔴 ${c(servers, 'OFFLINE')} offline · 🟡 ${c(servers, 'PENDING')} pending`,
        `Alerts: ${alerts} open${critical ? ` (🔥 ${critical} critical)` : ''}`,
        `Backups (24h): ✅ ${c(runs, 'SUCCESS')} · ❌ ${c(runs, 'FAILED')} · ⏳ ${c(runs, 'RUNNING') + c(runs, 'QUEUED')}`,
      ].join('\n'),
    };
  }

  private async servers(): Promise<Reply> {
    const list = await this.prisma.server.findMany({ where: { status: { not: 'DECOMMISSIONED' } }, orderBy: { name: 'asc' }, take: 40 });
    if (!list.length) return { text: 'No servers yet.' };
    return { text: ['🖥 <b>Servers</b>', ...list.map((s) => `${icons.status[s.status] ?? '•'} <b>${esc(s.name)}</b> <code>${esc(s.nodeId)}</code> · ${ago(s.lastHeartbeatAt)}`)].join('\n') };
  }

  private async server(query?: string): Promise<Reply> {
    if (!query) return { text: 'Usage: /server <node-id>, e.g. /server ims-node-0001' };
    const q = query.slice(0, 64);
    const s = await this.prisma.server.findFirst({ where: { OR: [{ nodeId: q }, { name: { equals: q, mode: 'insensitive' } }] } });
    if (!s) return { text: 'Server not found.' };
    const m = (s.latestMetrics ?? {}) as { cpu?: { percent?: number }; memory?: { totalBytes?: number; usedBytes?: number }; disks?: { mount: string; totalBytes: number; usedBytes: number }[] };
    const mem = m.memory?.totalBytes ? Math.round(((m.memory.usedBytes ?? 0) / m.memory.totalBytes) * 100) : null;
    const disks = (m.disks ?? []).slice(0, 5).map((d) => `  ${esc(d.mount)}: ${d.totalBytes ? Math.round((d.usedBytes / d.totalBytes) * 100) : 0}%`);
    return {
      text: [
        `${icons.status[s.status] ?? '•'} <b>${esc(s.name)}</b> <code>${esc(s.nodeId)}</code>`,
        `Host: ${esc(s.hostname ?? '—')} · ${esc(s.osDetails ?? s.operatingSystem)}`,
        `Agent: ${esc(s.agentVersion ?? '—')} · last seen ${ago(s.lastHeartbeatAt)}`,
        `CPU: ${m.cpu?.percent !== undefined ? `${Math.round(m.cpu.percent)}%` : '—'} · RAM: ${mem !== null ? `${mem}%` : '—'}`,
        ...(disks.length ? ['Disks:', ...disks] : []),
      ].join('\n'),
    };
  }

  private async alerts(): Promise<Reply> {
    const list = await this.prisma.alert.findMany({ where: { status: { not: 'RESOLVED' } }, orderBy: { lastSeenAt: 'desc' }, take: 15, include: { server: { select: { name: true } } } });
    if (!list.length) return { text: '✅ No open alerts.' };
    return { text: ['🚨 <b>Open alerts</b>', ...list.map((a) => `${icons.severity[a.severity] ?? '•'} ${esc(a.title)}${a.server ? ` · ${esc(a.server.name)}` : ''} · ${ago(a.lastSeenAt)}`)].join('\n') };
  }

  private async recentRuns(): Promise<Reply> {
    const list = await this.prisma.backupRun.findMany({ orderBy: { createdAt: 'desc' }, take: 10, include: { job: { select: { name: true } }, server: { select: { name: true } } } });
    if (!list.length) return { text: 'No backup runs yet.' };
    return { text: ['🗄 <b>Recent backups</b>', ...list.map((r) => `${icons.run[r.status] ?? '•'} ${esc(r.job.name)} · ${esc(r.server.name)} · ${formatBytes(r.sizeBytes)} · ${ago(r.createdAt)}`)].join('\n') };
  }

  private async jobs(): Promise<Reply> {
    const list = await this.prisma.backupJob.findMany({ where: { archivedAt: null }, orderBy: { name: 'asc' }, take: 30, include: { server: { select: { name: true } } } });
    if (!list.length) return { text: 'No backup jobs yet.' };
    return {
      text: [
        '📦 <b>Backup jobs</b>',
        ...list.map((j) => `${j.enabled ? '▶️' : '⏸'} <code>${j.id.slice(0, 8)}</code> ${esc(j.name)} · ${esc(j.server.name)} · last ${j.lastRunStatus ? (icons.run[j.lastRunStatus] ?? '') : '—'}`),
        '',
        'Run one with /backup &lt;job-id&gt;',
      ].join('\n'),
    };
  }

  private async confirmBackup(idPrefix?: string): Promise<Reply> {
    const prefix = (idPrefix ?? '').toLowerCase();
    if (!/^[0-9a-f-]{8,36}$/.test(prefix)) return { text: 'Usage: /backup <job-id> (see /jobs)' };
    const matches = await this.prisma.backupJob.findMany({ where: { archivedAt: null }, select: { id: true, name: true, server: { select: { name: true } } } });
    const found = matches.filter((j) => j.id.startsWith(prefix));
    if (found.length !== 1) return { text: found.length ? 'That id matches several jobs, use more characters.' : 'Backup job not found.' };
    const job = found[0];
    return {
      text: `Run backup <b>${esc(job.name)}</b> on <b>${esc(job.server.name)}</b> now?`,
      keyboard: [[{ text: '▶️ Run now', callback_data: `run:${job.id}` }, { text: 'Cancel', callback_data: 'cancel' }]],
    };
  }

  private async withinRateLimit(chatId: number): Promise<boolean> {
    try {
      const key = `ims:tg:rate:${chatId}`;
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, 60);
      return count <= MAX_COMMANDS_PER_MINUTE;
    } catch (err) {
      this.logger.warn(`Rate limiter unavailable: ${(err as Error).message}`);
      return true;
    }
  }
}
