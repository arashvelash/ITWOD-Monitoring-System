import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractTarGz } from '../updater/tar-extract';
import { decideBoot, MAX_BOOT_ATTEMPTS, readStateSync, writeStateSync, type UpdateState } from '../updater/update-state';
import { prepareBoot, resolveEntry } from '../updater/launcher';
import { parseUpdatePayload, UpdateService, verifyReleaseSignature } from '../updater/update.service';
import { agentPackage, tarEntry, tempPaths, tgz } from './helpers';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

function writeFile(path: string, data: Buffer): string {
  writeFileSync(path, data);
  return path;
}

/** Installed layout with release 1.0.0 active. */
function installed() {
  const t = tempPaths();
  const v1 = join(t.paths.releasesDir, '1.0.0');
  mkdirSync(join(v1, 'dist'), { recursive: true });
  writeFileSync(join(v1, 'manifest.json'), JSON.stringify({ name: 'ims-agent', version: '1.0.0', entry: 'dist/ims-agent.js' }));
  writeFileSync(join(v1, 'dist', 'ims-agent.js'), '');
  mkdirSync(t.paths.stateDir, { recursive: true });
  symlinkSync(v1, t.paths.currentLink, linkType);
  return { ...t, v1 };
}

function fakeClient(pkg: Buffer) {
  return {
    download: vi.fn(async (_path: string, dest: string) => {
      writeFileSync(dest, pkg);
      return { sha256: sha(pkg), bytes: pkg.length };
    }),
  };
}

const payloadFor = (pkg: Buffer, version = '2.0.0', signature: string | null = null) => ({ version, sha256: sha(pkg), sizeBytes: pkg.length, signature });

describe('extractTarGz', () => {
  it('extracts regular files and directories', async () => {
    const { root } = tempPaths();
    const files = await extractTarGz(writeFile(join(root, 'p.tgz'), agentPackage('2.0.0')), join(root, 'out'));
    expect(files).toEqual(expect.arrayContaining(['manifest.json', 'dist/ims-agent.js', 'installer/install.sh']));
    expect(readFileSync(join(root, 'out', 'dist', 'ims-agent.js'), 'utf8')).toContain('ok 2.0.0');
  });

  it('handles entries larger than one gzip chunk', async () => {
    const { root } = tempPaths();
    const big = Buffer.alloc(700_000, 3);
    await extractTarGz(writeFile(join(root, 'p.tgz'), agentPackage('2.0.0', [tarEntry('./dist/big.bin', big)])), join(root, 'out'));
    expect(readFileSync(join(root, 'out', 'dist', 'big.bin')).equals(big)).toBe(true);
  });

  it('refuses traversal, absolute paths, links and oversized packages', async () => {
    const { root } = tempPaths();
    const cases: [Buffer, RegExp][] = [
      [tgz([tarEntry('../escape.sh', 'x')]), /Unsafe path/],
      [tgz([tarEntry('/etc/passwd', 'x')]), /Unsafe path/],
      [tgz([tarEntry('./a/../../b', 'x')]), /Unsafe path/],
      [tgz([tarEntry('./link', '', '2')]), /Unsupported entry type/],
      [tgz([tarEntry('./dev', '', '3')]), /Unsupported entry type/],
    ];
    for (const [i, [pkg, err]] of cases.entries()) {
      await expect(extractTarGz(writeFile(join(root, `bad${i}.tgz`), pkg), join(root, `out${i}`))).rejects.toThrow(err);
    }
    expect(existsSync(join(root, 'escape.sh'))).toBe(false);
    await expect(extractTarGz(writeFile(join(root, 'big.tgz'), tgz([tarEntry('./x', Buffer.alloc(5000))])), join(root, 'o'), { maxTotalBytes: 1000 })).rejects.toThrow(/size limit/);
  });
});

describe('decideBoot', () => {
  const base: UpdateState = { state: 'pending', version: '2.0.0', previousVersion: '1.0.0', previousTarget: '/x', commandId: 'c', switchedAt: new Date().toISOString(), bootAttempts: 0 };

  it('counts boots of an unconfirmed release and rolls back crash loops', () => {
    let s: UpdateState | null = base;
    for (let i = 1; i <= MAX_BOOT_ATTEMPTS; i++) {
      const d = decideBoot(s);
      expect(d.action).toBe('continue');
      s = d.state;
      expect(s?.bootAttempts).toBe(i);
    }
    expect(decideBoot(s).action).toBe('rollback');
  });

  it('rolls back on request or when never confirmed, otherwise continues', () => {
    expect(decideBoot({ ...base, state: 'rollback-requested' }).action).toBe('rollback');
    expect(decideBoot({ ...base, switchedAt: new Date(Date.now() - 3_600_000).toISOString() }).action).toBe('rollback');
    expect(decideBoot({ ...base, state: 'committed' })).toEqual({ action: 'continue', state: { ...base, state: 'committed' } });
    expect(decideBoot(null)).toEqual({ action: 'continue', state: null });
  });
});

describe('launcher', () => {
  it('restores the previous release after repeated crashes', () => {
    const t = installed();
    const v2 = join(t.paths.releasesDir, '2.0.0');
    mkdirSync(join(v2, 'dist'), { recursive: true });
    writeFileSync(join(v2, 'manifest.json'), JSON.stringify({ name: 'ims-agent', version: '2.0.0', entry: 'dist/ims-agent.js' }));
    const previousTarget = realpathSync(t.paths.currentLink);
    // switch to 2.0.0 as the updater would
    writeStateSync(t.paths.updateStateFile, { state: 'pending', version: '2.0.0', previousVersion: '1.0.0', previousTarget, commandId: 'cmd-1', switchedAt: new Date().toISOString(), bootAttempts: MAX_BOOT_ATTEMPTS });
    expect(prepareBoot(t.paths)).toBe('rolled-back');
    expect(realpathSync(t.paths.currentLink)).toBe(previousTarget);
    expect(readStateSync(t.paths.updateStateFile)).toMatchObject({ state: 'rolled_back', reported: false, error: expect.stringContaining('crashed') });
  });

  it('only loads validated entry points', () => {
    const t = installed();
    expect(resolveEntry(t.paths.currentLink)).toBe(join(realpathSync(t.paths.currentLink), 'dist', 'ims-agent.js'));
    writeFileSync(join(t.v1, 'manifest.json'), JSON.stringify({ name: 'ims-agent', version: '1.0.0', entry: '../../evil.js' }));
    expect(resolveEntry(t.paths.currentLink)).toBe(join(realpathSync(t.paths.currentLink), 'dist', 'ims-agent.js'));
  });
});

// End-to-end check of a real package produced by `npm run package` (skipped when not built).
const releaseDir = join(__dirname, '..', 'release');
const builtPkg = existsSync(releaseDir) ? readdirSync(releaseDir).find((f) => /^ims-agent-\d+\.\d+\.\d+.*\.tgz$/.test(f)) : undefined;
describe.skipIf(!builtPkg)('built package', () => {
  it('extracts with the updater and boots through the launcher', async () => {
    const t = tempPaths();
    const version = /^ims-agent-(.+)\.tgz$/.exec(builtPkg!)![1];
    const target = join(t.paths.releasesDir, version);
    const files = await extractTarGz(join(releaseDir, builtPkg!), target);
    expect(files).toEqual(expect.arrayContaining(['manifest.json', 'dist/ims-agent.js', 'dist/launcher.js', 'installer/install.sh']));
    symlinkSync(target, t.paths.currentLink, linkType);
    const out = execFileSync(process.execPath, [join(target, 'dist', 'launcher.js'), 'version'], {
      env: { ...process.env, IMS_AGENT_INSTALL_DIR: t.paths.installDir, IMS_AGENT_STATE_DIR: t.paths.stateDir, IMS_AGENT_CONFIG_DIR: t.paths.configDir },
      encoding: 'utf8',
    });
    expect(out.trim()).toBe(version);
    const selfTest = execFileSync(process.execPath, [join(target, 'dist', 'ims-agent.js'), 'self-test'], { encoding: 'utf8' });
    expect(selfTest.trim()).toBe(`ok ${version}`);
  });
});

describe('UpdateService', () => {
  it('validates command payloads strictly', () => {
    expect(() => parseUpdatePayload({ version: '2.0.0;id', sha256: 'a'.repeat(64), sizeBytes: 1 })).toThrow(/version/);
    expect(() => parseUpdatePayload({ version: '2.0.0', sha256: 'xyz', sizeBytes: 1 })).toThrow(/checksum/);
    expect(() => parseUpdatePayload({ version: '2.0.0', sha256: 'a'.repeat(64), sizeBytes: 10 ** 12 })).toThrow(/size/);
    expect(parseUpdatePayload({ version: '2.0.0', sha256: 'a'.repeat(64), sizeBytes: 5, signature: null })).toEqual({ version: '2.0.0', sha256: 'a'.repeat(64), sizeBytes: 5, signature: null });
  });

  it('installs a verified release, switches `current` and restarts', async () => {
    const t = installed();
    const pkg = agentPackage('2.0.0');
    const client = fakeClient(pkg);
    const exit = vi.fn();
    const stop = vi.fn(async () => undefined);
    const selfTest = vi.fn(async () => undefined);
    const svc = new UpdateService(t.paths, client, vi.fn(), { currentVersion: '1.0.0', exit, selfTest, releasePublicKey: null });
    await svc.apply(payloadFor(pkg), 'cmd-1', stop);

    expect(client.download).toHaveBeenCalledWith('/api/v1/agent/releases/2.0.0/package', expect.any(String), pkg.length);
    expect(selfTest).toHaveBeenCalledWith(expect.stringContaining(join('.staging-2.0.0')), '2.0.0');
    expect(realpathSync(t.paths.currentLink)).toBe(realpathSync(join(t.paths.releasesDir, '2.0.0')));
    expect(readStateSync(t.paths.updateStateFile)).toMatchObject({ state: 'pending', version: '2.0.0', previousVersion: '1.0.0', previousTarget: realpathSync(t.v1), commandId: 'cmd-1', bootAttempts: 0 });
    expect(stop).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('rejects tampered downloads and leaves the active release alone', async () => {
    const t = installed();
    const pkg = agentPackage('2.0.0');
    const svc = new UpdateService(t.paths, fakeClient(pkg), vi.fn(), { currentVersion: '1.0.0', exit: vi.fn(), selfTest: async () => undefined, releasePublicKey: null });
    await expect(svc.apply({ ...payloadFor(pkg), sha256: 'b'.repeat(64) }, 'cmd', async () => undefined)).rejects.toThrow(/checksum/);
    const wrongVersion = agentPackage('2.0.1');
    await expect(new UpdateService(t.paths, fakeClient(wrongVersion), vi.fn(), { currentVersion: '1.0.0', exit: vi.fn(), selfTest: async () => undefined, releasePublicKey: null }).apply(payloadFor(wrongVersion), 'cmd', async () => undefined)).rejects.toThrow(/manifest/);
    expect(realpathSync(t.paths.currentLink)).toBe(realpathSync(t.v1));
    expect(readStateSync(t.paths.updateStateFile)).toBeNull();
  });

  it('enforces release signatures when a public key is pinned', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64');
    const pkg = agentPackage('2.0.0');
    const good = sign(null, Buffer.from(sha(pkg), 'ascii'), privateKey).toString('base64');
    expect(verifyReleaseSignature(pub, sha(pkg), good)).toBe(true);
    expect(verifyReleaseSignature(pub, 'c'.repeat(64), good)).toBe(false);

    const t = installed();
    const opts = { currentVersion: '1.0.0', exit: vi.fn(), selfTest: async () => undefined, releasePublicKey: pub };
    await expect(new UpdateService(t.paths, fakeClient(pkg), vi.fn(), opts).apply(payloadFor(pkg), 'cmd', async () => undefined)).rejects.toThrow(/requires signed releases/);
    const forged = sign(null, Buffer.from('0'.repeat(64), 'ascii'), privateKey).toString('base64');
    await expect(new UpdateService(t.paths, fakeClient(pkg), vi.fn(), opts).apply(payloadFor(pkg, '2.0.0', forged), 'cmd', async () => undefined)).rejects.toThrow(/signature verification/);
    await new UpdateService(t.paths, fakeClient(pkg), vi.fn(), opts).apply(payloadFor(pkg, '2.0.0', good), 'cmd', async () => undefined);
    expect(readStateSync(t.paths.updateStateFile)?.state).toBe('pending');
  });

  it('reports an already installed version immediately', async () => {
    const t = installed();
    const report = vi.fn(async () => undefined);
    const pkg = agentPackage('1.0.0');
    await new UpdateService(t.paths, fakeClient(pkg), report, { currentVersion: '1.0.0', exit: vi.fn(), releasePublicKey: null }).apply(payloadFor(pkg, '1.0.0'), 'cmd-9', async () => undefined);
    expect(report).toHaveBeenCalledWith('cmd-9', 'SUCCEEDED', { version: '1.0.0', alreadyInstalled: true });
  });

  it('confirms the new release once it is connected', async () => {
    const t = installed();
    writeStateSync(t.paths.updateStateFile, { state: 'pending', version: '2.0.0', previousVersion: '1.0.0', previousTarget: t.v1, commandId: 'cmd-1', switchedAt: new Date().toISOString(), bootAttempts: 1 });
    const report = vi.fn(async () => undefined);
    const exit = vi.fn();
    const svc = new UpdateService(t.paths, fakeClient(Buffer.alloc(0)), report, { currentVersion: '2.0.0', exit, commitDelayMs: 10, watchdogMs: 10_000, releasePublicKey: null });
    await svc.onStartup();
    await svc.onConnected();
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith('cmd-1', 'SUCCEEDED', { version: '2.0.0', previousVersion: '1.0.0' }));
    expect(readStateSync(t.paths.updateStateFile)?.state).toBe('committed');
    expect(exit).not.toHaveBeenCalled();
  });

  it('requests a rollback when the new release never connects', async () => {
    const t = installed();
    writeStateSync(t.paths.updateStateFile, { state: 'pending', version: '2.0.0', previousVersion: '1.0.0', previousTarget: t.v1, commandId: 'cmd-1', switchedAt: new Date().toISOString(), bootAttempts: 1 });
    const exit = vi.fn();
    const svc = new UpdateService(t.paths, fakeClient(Buffer.alloc(0)), vi.fn(), { currentVersion: '2.0.0', exit, watchdogMs: 20, releasePublicKey: null });
    await svc.onStartup();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(75));
    expect(readStateSync(t.paths.updateStateFile)?.state).toBe('rollback-requested');
  });

  it('reports a rollback exactly once after restarting on the old version', async () => {
    const t = installed();
    writeStateSync(t.paths.updateStateFile, { state: 'rolled_back', version: '2.0.0', previousVersion: '1.0.0', previousTarget: t.v1, commandId: 'cmd-1', switchedAt: new Date().toISOString(), bootAttempts: 4, error: 'crashed', reported: false });
    const report = vi.fn(async () => undefined);
    const svc = new UpdateService(t.paths, fakeClient(Buffer.alloc(0)), report, { currentVersion: '1.0.0', exit: vi.fn(), releasePublicKey: null });
    await svc.onStartup();
    await svc.onStartup();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith('cmd-1', 'FAILED', { version: '2.0.0', rolledBackTo: '1.0.0' }, 'crashed');
  });
});
