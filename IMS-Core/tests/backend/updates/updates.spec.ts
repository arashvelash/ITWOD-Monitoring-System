import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync as mkdtempRaw, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentReleasesService } from '../../../backend/src/updates/agent-releases.service';
import { CoreUpdateService } from '../../../backend/src/updates/core-update.service';
import { INTERNAL_KEYS } from '../../../backend/src/settings/settings.registry';
import { sha256Hex } from '../../../backend/src/crypto/tokens';
import { agentPackage, tarEntry } from '../helpers/tar';

const created: string[] = [];
function mkdtempSync(prefix: string): string {
  const d = mkdtempRaw(prefix);
  created.push(d);
  return d;
}
afterAll(() => created.forEach((d) => rmSync(d, { recursive: true, force: true })));

const USER = { id: 'u1', username: 'admin', role: 'ADMIN' } as never;
const S1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const S2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const S3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function releasesFixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'ims-rel-'));
  const releases: any[] = [];
  const commands: any[] = [];
  const tokens: any[] = [];
  const servers = [
    { id: S1, name: 'web-1', type: 'UBUNTU', status: 'ONLINE', agentVersion: '1.0.0' },
    { id: S2, name: 'web-2', type: 'UBUNTU', status: 'ONLINE', agentVersion: '2.0.0' },
    { id: S3, name: 'shared', type: 'CPANEL', status: 'ONLINE', agentVersion: '1.0.0' },
  ];
  const prisma = {
    agentRelease: {
      findMany: async ({ where }: any = {}) => releases.filter((r) => (where?.isRevoked === false ? !r.isRevoked : true)),
      findUnique: async ({ where }: any) => releases.find((r) => r.version === where.version) ?? null,
      create: async ({ data }: any) => {
        const r = { id: `r${releases.length + 1}`, isRevoked: false, createdAt: new Date(), ...data };
        releases.push(r);
        return r;
      },
      update: async ({ where, data }: any) => Object.assign(releases.find((r) => r.id === where.id), data),
    },
    server: { findMany: async ({ where }: any) => servers.filter((s) => where.id.in.includes(s.id)) },
    nodeCommand: { count: async ({ where }: any) => commands.filter((c) => c.serverId === where.serverId && c.type === where.type).length },
    registrationToken: { findUnique: async ({ where }: any) => tokens.find((t) => t.tokenHash === where.tokenHash) ?? null },
  };
  const listeners: Record<string, (cmd: any) => Promise<void>> = {};
  const commandsService = {
    enqueue: jest.fn(async (serverId: string, type: string, payload: any) => {
      const c = { id: `c${commands.length + 1}`, serverId, type, payload };
      commands.push(c);
      return c;
    }),
    onCompleted: (type: string, l: any) => (listeners[type] = l),
  };
  const events = { emit: jest.fn().mockResolvedValue(undefined) };
  const audit = { byUser: jest.fn(), record: jest.fn() };
  const settings = { get: jest.fn(async () => ({ apiBase: 'https://api.github.com', coreRepo: null, agentRepo: null })) };
  const service = new AgentReleasesService(prisma as never, settings as never, {} as never, commandsService as never, events as never, audit as never, {} as never, { dataDir } as never);
  return { service, dataDir, releases, commands, tokens, commandsService, events, listeners };
}

async function stage(service: AgentReleasesService, buf: Buffer): Promise<string> {
  const p = await service.tempFile();
  writeFileSync(p, buf);
  return p;
}

describe('AgentReleasesService', () => {
  it('registers inspected packages and stores them by version', async () => {
    const f = releasesFixture();
    const pkg = agentPackage('2.1.0');
    const tmp = await stage(f.service, pkg);
    const view = await f.service.upload(tmp, { signature: null }, USER);
    expect(view).toMatchObject({ version: '2.1.0', sha256: createHash('sha256').update(pkg).digest('hex'), isLatest: true, source: 'UPLOAD' });
    expect(view).not.toHaveProperty('storagePath');
    expect(existsSync(tmp)).toBe(false);
    expect(readFileSync(join(f.dataDir, 'agent-releases', '2.1.0', 'ims-agent-2.1.0.tgz')).equals(pkg)).toBe(true);

    // Same content again is idempotent; different content under the same version is refused.
    await expect(f.service.register(await stage(f.service, pkg), { source: 'UPLOAD' })).resolves.toMatchObject({ version: '2.1.0' });
    const different = agentPackage('2.1.0', [tarEntry('./extra.txt', 'changed')]);
    await expect(f.service.register(await stage(f.service, different), { source: 'UPLOAD' })).rejects.toThrow(/different content/);
    expect(f.releases).toHaveLength(1);
  });

  it('rejects invalid packages, checksum and version mismatches', async () => {
    const f = releasesFixture();
    await expect(f.service.register(await stage(f.service, Buffer.from('junk')), { source: 'UPLOAD' })).rejects.toThrow(/Invalid agent package/);
    await expect(f.service.register(await stage(f.service, agentPackage('1.0.0')), { source: 'GITHUB', expectedSha256: 'f'.repeat(64) })).rejects.toThrow(/Checksum/);
    await expect(f.service.register(await stage(f.service, agentPackage('1.0.0')), { source: 'GITHUB', expectedVersion: 'v1.0.1' })).rejects.toThrow(/does not match/);
    await expect(f.service.register(await stage(f.service, agentPackage('1.0.0')), { source: 'UPLOAD', signature: 'not-base64!' })).rejects.toThrow(/Signature/);
    expect(f.releases).toHaveLength(0);
  });

  it('rolls out only to eligible Ubuntu agents', async () => {
    const f = releasesFixture();
    await f.service.upload(await stage(f.service, agentPackage('2.0.0')), {}, USER);
    const r = await f.service.rollout({ serverIds: [S1, S2, S3, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'] }, USER);
    expect(r.version).toBe('2.0.0');
    expect(r.results.map((x) => [x.serverId, x.queued])).toEqual([
      [S1, true],
      [S2, false],
      [S3, false],
      ['dddddddd-dddd-4ddd-8ddd-dddddddddddd', false],
    ]);
    expect(f.commandsService.enqueue).toHaveBeenCalledWith(S1, 'agent.update', expect.objectContaining({ version: '2.0.0', path: '/api/v1/agent/releases/2.0.0/package' }), expect.anything());
    // A second rollout does not stack another update on top of the one in flight.
    const again = await f.service.rollout({ serverIds: [S1] }, USER);
    expect(again.results[0]).toMatchObject({ queued: false, reason: 'an update is already in progress' });
  });

  it('turns agent.update completions into domain events', async () => {
    const f = releasesFixture();
    f.service.onModuleInit();
    await f.listeners['agent.update']({ serverId: S1, status: 'FAILED', payload: { version: '2.0.0' }, errorMessage: 'rolled back' });
    expect(f.events.emit).toHaveBeenCalledWith('agent.update.finished', { serverId: S1, version: '2.0.0', succeeded: false, error: 'rolled back' });
  });

  it('accepts only unused, unexpired registration tokens of Ubuntu servers for installer downloads', async () => {
    const f = releasesFixture();
    const raw = 'imsr_' + 'a'.repeat(32);
    const future = new Date(Date.now() + 60_000);
    f.tokens.push({ tokenHash: sha256Hex(raw), usedAt: null, revokedAt: null, expiresAt: future, server: { type: 'UBUNTU', status: 'PENDING' } });
    await expect(f.service.assertInstallToken(raw)).resolves.toBeUndefined();
    await expect(f.service.assertInstallToken(undefined)).rejects.toThrow();
    await expect(f.service.assertInstallToken('imsr_short')).rejects.toThrow();
    f.tokens[0].usedAt = new Date();
    await expect(f.service.assertInstallToken(raw)).rejects.toThrow(/expired/);
  });

  it('never serves revoked or unknown versions', async () => {
    const f = releasesFixture();
    await f.service.upload(await stage(f.service, agentPackage('3.0.0')), {}, USER);
    await expect(f.service.packageFile('3.0.0')).resolves.toMatchObject({ fileName: 'ims-agent-3.0.0.tgz' });
    await f.service.revoke('3.0.0', USER);
    await expect(f.service.packageFile('3.0.0')).rejects.toThrow(/not found/);
    await expect(f.service.packageFile('../../etc/passwd')).rejects.toThrow(/not found/);
  });
});

function coreFixture(version = '1.0.0') {
  const dataDir = mkdtempSync(join(tmpdir(), 'ims-core-upd-'));
  const internal = new Map<string, unknown>();
  const updates: any[] = [];
  const prisma = {
    coreUpdate: {
      findFirst: async ({ where }: any) => updates.find((u) => where.status.in.includes(u.status)) ?? null,
      findMany: async ({ where }: any = {}) =>
        updates.filter((u) => (!where?.status || u.status === where.status) && (!where?.requestedAt || u.requestedAt < where.requestedAt.lt)),
      findUnique: async ({ where }: any) => updates.find((u) => u.id === where.id) ?? null,
      create: async ({ data }: any) => {
        const u = { id: '11111111-2222-4333-8444-55555555555' + updates.length, requestedAt: new Date(), startedAt: null, currentStep: null, ...data };
        updates.push(u);
        return u;
      },
      update: async ({ where, data }: any) => Object.assign(updates.find((u) => u.id === where.id), data),
    },
  };
  const settings = {
    get: jest.fn(async () => ({ apiBase: 'https://api.github.com', coreRepo: 'itwod/ims-core', agentRepo: null })),
    getInternal: jest.fn(async (k: string) => internal.get(k) ?? null),
    setInternal: jest.fn(async (k: string, v: unknown) => void internal.set(k, v)),
  };
  const github = { latestRelease: jest.fn() };
  const events = { emit: jest.fn().mockResolvedValue(undefined) };
  const audit = { byUser: jest.fn() };
  const service = new CoreUpdateService(prisma as never, settings as never, github as never, audit as never, {} as never, events as never, { dataDir, version } as never);
  const updateDir = join(dataDir, 'update');
  return { service, dataDir, updateDir, internal, updates, github, events };
}

describe('CoreUpdateService', () => {
  it('stores the latest release found on GitHub', async () => {
    const f = coreFixture();
    f.github.latestRelease.mockResolvedValue({ tag_name: 'v1.1.0', draft: false, body: 'notes', published_at: '2026-09-01T00:00:00Z', assets: [] });
    const info = await f.service.check(USER);
    expect(info).toMatchObject({ currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true, updaterInstalled: false });
  });

  it('only requests known newer releases when the host updater is installed', async () => {
    const f = coreFixture();
    f.internal.set(INTERNAL_KEYS.latestCoreRelease, { version: '1.1.0', checkedAt: new Date().toISOString() });
    await expect(f.service.apply('1.1.0', USER)).rejects.toThrow(/host updater/);

    mkdirSync(f.updateDir, { recursive: true });
    writeFileSync(join(f.updateDir, 'updater.json'), '{"installed":true}');
    await expect(f.service.apply('1.2.0', USER)).rejects.toThrow(/latest published release/);
    await expect(f.service.apply('1.1.0;reboot', USER)).rejects.toThrow(/Invalid version/);

    const row = await f.service.apply('v1.1.0', USER);
    const request = JSON.parse(readFileSync(join(f.updateDir, 'request.json'), 'utf8'));
    expect(request).toEqual({ id: row.id, version: '1.1.0', requestedAt: expect.any(String), requestedBy: 'admin' });
    await expect(f.service.apply('1.1.0', USER)).rejects.toThrow(/already in progress/);
  });

  it('mirrors the host status file into the history and announces the result', async () => {
    const f = coreFixture();
    f.internal.set(INTERNAL_KEYS.latestCoreRelease, { version: '1.1.0', checkedAt: new Date().toISOString() });
    mkdirSync(f.updateDir, { recursive: true });
    writeFileSync(join(f.updateDir, 'updater.json'), '{}');
    const row = await f.service.apply('1.1.0', USER);

    writeFileSync(join(f.updateDir, 'status.json'), JSON.stringify({ id: row.id, state: 'running', step: 'migrate' }));
    await f.service.syncStatus();
    expect(f.updates[0]).toMatchObject({ status: 'RUNNING', currentStep: 'migrate' });

    writeFileSync(join(f.updateDir, 'last-run.log'), 'health check failed\n');
    writeFileSync(join(f.updateDir, 'status.json'), JSON.stringify({ id: row.id, state: 'rolled_back', step: 'rollback', message: 'health check failed' }));
    await f.service.syncStatus();
    expect(f.updates[0]).toMatchObject({ status: 'ROLLED_BACK', errorMessage: 'health check failed', log: 'health check failed\n' });
    expect(f.events.emit).toHaveBeenCalledWith('core.update.finished', expect.objectContaining({ toVersion: '1.1.0', status: 'ROLLED_BACK' }));

    // Final states are never overwritten by a later, stale status file.
    writeFileSync(join(f.updateDir, 'status.json'), JSON.stringify({ id: row.id, state: 'running' }));
    await f.service.syncStatus();
    expect(f.updates[0].status).toBe('ROLLED_BACK');
  });

  it('fails requests the updater never picked up', async () => {
    const f = coreFixture();
    f.updates.push({ id: '99999999-2222-4333-8444-555555555555', status: 'REQUESTED', requestedAt: new Date(Date.now() - 3_600_000) });
    mkdirSync(f.updateDir, { recursive: true });
    writeFileSync(join(f.updateDir, 'request.json'), '{}');
    await f.service.syncStatus();
    expect(f.updates[0].status).toBe('FAILED');
    expect(existsSync(join(f.updateDir, 'request.json'))).toBe(false);
  });
});
