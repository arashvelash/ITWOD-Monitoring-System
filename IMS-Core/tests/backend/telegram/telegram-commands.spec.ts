import { TelegramCommandsService } from '../../../backend/src/telegram/telegram-commands.service';
import { alertMessage, backupMessage, esc } from '../../../backend/src/telegram/telegram-format';
import type { TgMessage } from '../../../backend/src/telegram/telegram-api';
import { redisOptionsFromUrl } from '../../../backend/src/redis/redis-url';

const JOB_ID = '11111111-2222-4333-8444-555555555555';

function fixture(role: 'ADMIN' | 'OPERATOR' | 'VIEWER' | null, opts: { rateCount?: number } = {}) {
  const link = role
    ? { id: 'l1', chatId: 100n, telegramUserId: 100n, user: { id: 'u1', username: 'arash', role, isActive: true } }
    : null;
  const prisma = {
    telegramLink: { update: jest.fn().mockResolvedValue({}) },
    backupJob: { findMany: jest.fn().mockResolvedValue([{ id: JOB_ID, name: 'Site <files>', server: { name: 'web-01' } }]) },
    server: { groupBy: jest.fn().mockResolvedValue([{ status: 'ONLINE', _count: { _all: 2 } }]), findMany: jest.fn().mockResolvedValue([]) },
    alert: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    backupRun: { groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn().mockResolvedValue([]) },
  };
  const links = {
    findByChat: jest.fn().mockResolvedValue(link),
    consumeCode: jest.fn().mockResolvedValue({ username: 'arash', role: 'VIEWER' }),
    unlinkChat: jest.fn().mockResolvedValue(true),
  };
  const runs = { trigger: jest.fn().mockResolvedValue({ id: 'abcdef12-0000-4000-8000-000000000000' }) };
  let count = opts.rateCount ?? 0;
  const redis = { incr: jest.fn(async () => ++count), expire: jest.fn() };
  const svc = new TelegramCommandsService(prisma as never, links as never, runs as never, redis as never);
  return { svc, prisma, links, runs };
}

const msg = (text: string, over: Partial<TgMessage> = {}): TgMessage => ({
  message_id: 1,
  text,
  from: { id: 100, is_bot: false, first_name: 'A', username: 'arash_tg' },
  chat: { id: 100, type: 'private' },
  ...over,
});

describe('TelegramCommandsService', () => {
  it('ignores group chats and non-commands', async () => {
    const f = fixture('ADMIN');
    expect(await f.svc.handleMessage(msg('/status', { chat: { id: -5, type: 'group' } }))).toBeNull();
    expect(await f.svc.handleMessage(msg('hello'))).toBeNull();
  });

  it('refuses unlinked chats and explains how to link', async () => {
    const f = fixture(null);
    expect((await f.svc.handleMessage(msg('/status')))?.text).toMatch(/not linked/);
    expect((await f.svc.handleMessage(msg('/start')))?.text).toMatch(/\/link IMS-XXXX-XXXX/);
  });

  it('links a chat with a one-time code', async () => {
    const f = fixture(null);
    const reply = await f.svc.handleMessage(msg('/link IMS-ABCD-EFGH'));
    expect(f.links.consumeCode).toHaveBeenCalledWith('IMS-ABCD-EFGH', { chatId: 100n, telegramUserId: 100n, username: 'arash_tg' });
    expect(reply?.text).toMatch(/Linked to IMS user/);
  });

  it('rejects commands from a different Telegram user in a linked chat', async () => {
    const f = fixture('ADMIN');
    const reply = await f.svc.handleMessage(msg('/status', { from: { id: 999, is_bot: false, first_name: 'X' } }));
    expect(reply?.text).toMatch(/not linked/);
  });

  it('answers read-only commands for viewers', async () => {
    const f = fixture('VIEWER');
    expect((await f.svc.handleMessage(msg('/status')))?.text).toMatch(/2 online/);
  });

  it('requires the operator role to start backups', async () => {
    const f = fixture('VIEWER');
    expect((await f.svc.handleMessage(msg(`/backup ${JOB_ID.slice(0, 8)}`)))?.text).toMatch(/operator role/);
  });

  it('asks for confirmation before starting a backup (escaping names)', async () => {
    const f = fixture('OPERATOR');
    const reply = await f.svc.handleMessage(msg(`/backup ${JOB_ID.slice(0, 8)}`));
    expect(reply?.text).toContain('Site &lt;files&gt;');
    expect(reply?.keyboard?.[0]?.[0]?.callback_data).toBe(`run:${JOB_ID}`);
    expect(f.runs.trigger).not.toHaveBeenCalled();
  });

  it('starts the backup only on a confirmed callback from the linked user', async () => {
    const f = fixture('OPERATOR');
    const chat = { id: 100, type: 'private' as const };
    const ok = await f.svc.handleCallback({ id: 'cb', from: { id: 100, is_bot: false, first_name: 'A' }, message: { message_id: 1, chat }, data: `run:${JOB_ID}` });
    expect(ok.answer).toBe('Backup started');
    expect(f.runs.trigger).toHaveBeenCalledWith(JOB_ID, { id: 'u1', username: 'arash' }, 'TELEGRAM');

    const other = await f.svc.handleCallback({ id: 'cb2', from: { id: 555, is_bot: false, first_name: 'B' }, message: { message_id: 1, chat }, data: `run:${JOB_ID}` });
    expect(other.answer).toMatch(/not linked/);
    const junk = await f.svc.handleCallback({ id: 'cb3', from: { id: 100, is_bot: false, first_name: 'A' }, message: { message_id: 1, chat }, data: 'run:../../x' });
    expect(junk.answer).toBe('Unknown action');
    expect(f.runs.trigger).toHaveBeenCalledTimes(1);
  });

  it('rate limits chatty chats', async () => {
    const f = fixture('ADMIN', { rateCount: 25 });
    expect((await f.svc.handleMessage(msg('/status')))?.text).toMatch(/Too many commands/);
  });
});

describe('Telegram message formatting', () => {
  it('escapes HTML in every dynamic value', () => {
    expect(esc('<b>&"')).toBe('&lt;b&gt;&amp;&quot;');
    const text = backupMessage({ jobName: '<script>', serverName: 'a&b', status: 'FAILED', error: '<img src=x>', trigger: 'SCHEDULED' }, 'IMS');
    expect(text).toContain('&lt;script&gt;');
    expect(text).toContain('a&amp;b');
    expect(text).not.toContain('<img');
    expect(alertMessage({ title: 'Disk <90%>', message: 'm', severity: 'CRITICAL', resolved: false }, 'IMS')).toContain('Disk &lt;90%&gt;');
  });
});

describe('redisOptionsFromUrl', () => {
  it('parses credentials and database index', () => {
    expect(redisOptionsFromUrl('redis://:p%40ss@redis:6380/2', { maxRetriesPerRequest: null })).toMatchObject({ host: 'redis', port: 6380, password: 'p@ss', db: 2, maxRetriesPerRequest: null });
    expect(() => redisOptionsFromUrl('http://redis')).toThrow();
  });
});
