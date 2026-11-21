import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectPackage } from '../../../backend/src/updates/package-inspector';
import { isNewer, isValidVersion, normalizeVersion, sortVersionsDesc } from '../../../backend/src/updates/versions';
import { agentPackage, tarEntry, tgz } from '../helpers/tar';

const dir = mkdtempSync(join(tmpdir(), 'ims-pkg-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
function write(buf: Buffer): string {
  const p = join(dir, `p${++n}.tgz`);
  writeFileSync(p, buf);
  return p;
}

describe('versions', () => {
  it('accepts strict semver only (safe for paths and git refs)', () => {
    for (const v of ['1.0.0', 'v2.10.3', '1.0.0-rc.1']) expect(isValidVersion(v)).toBe(true);
    for (const v of ['1.0', '01.0.0', '1.0.0+build', '../1.0.0', '1.0.0;rm', 'v1.0.0 ', 'latest', '']) expect(isValidVersion(v)).toBe(false);
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3');
    expect(() => normalizeVersion('1.2')).toThrow();
  });

  it('compares versions', () => {
    expect(isNewer('1.2.0', '1.1.9')).toBe(true);
    expect(isNewer('1.2.0', '1.2.0')).toBe(false);
    expect(isNewer('1.2.0-rc.1', '1.2.0')).toBe(false);
    expect(isNewer('1.0.0', '0.0.0-dev')).toBe(true);
    expect(sortVersionsDesc([{ version: '1.9.0' }, { version: '1.10.0' }, { version: '1.2.0' }]).map((r) => r.version)).toEqual(['1.10.0', '1.9.0', '1.2.0']);
  });
});

describe('inspectPackage', () => {
  it('reads the manifest and entry list of a valid package', async () => {
    const r = await inspectPackage(write(agentPackage('1.4.0')));
    expect(r.manifest).toMatchObject({ name: 'ims-agent', version: '1.4.0', entry: 'dist/ims-agent.js' });
    expect(r.entries).toEqual(expect.arrayContaining(['manifest.json', 'dist/ims-agent.js', 'installer/install.sh']));
  });

  it('handles data split across gzip chunks (large entries)', async () => {
    const big = tarEntry('./dist/big.bin', Buffer.alloc(300_000, 7));
    const r = await inspectPackage(write(agentPackage('1.4.1', [big])));
    expect(r.entries).toContain('dist/big.bin');
  });

  it('rejects path traversal, absolute paths and escaping links', async () => {
    await expect(inspectPackage(write(agentPackage('1.0.0', [tarEntry('../evil.sh', 'x')])))).rejects.toThrow(/Unsafe path/);
    await expect(inspectPackage(write(agentPackage('1.0.0', [tarEntry('/etc/cron.d/x', 'x')])))).rejects.toThrow(/Unsafe path/);
    await expect(inspectPackage(write(agentPackage('1.0.0', [tarEntry('./link', '', '2', '../../etc/passwd')])))).rejects.toThrow(/Unsafe link/);
  });

  // Cross-repository check: a package built by IMS-Agent/scripts/build.mjs is accepted by Core.
  const built = join(__dirname, '../../../../IMS-Agent/release');
  const builtPkg = existsSync(built) ? readdirSync(built).find((f) => /^ims-agent-\d+\.\d+\.\d+.*\.tgz$/.test(f)) : undefined;
  (builtPkg ? it : it.skip)('accepts the package produced by the IMS-Agent build script', async () => {
    const r = await inspectPackage(join(built, builtPkg!));
    expect(r.manifest.name).toBe('ims-agent');
    expect(r.entries).toEqual(expect.arrayContaining(['dist/ims-agent.js', 'dist/launcher.js', 'installer/install.sh', 'installer/ecosystem.config.cjs']));
  });

  it('requires a valid manifest and the installer', async () => {
    await expect(inspectPackage(write(tgz([tarEntry('./installer/install.sh', 'x')])))).rejects.toThrow(/no manifest/);
    const noInstaller = tgz([tarEntry('./manifest.json', JSON.stringify({ name: 'ims-agent', version: '1.0.0', entry: 'dist/ims-agent.js' })), tarEntry('./dist/ims-agent.js', 'x')]);
    await expect(inspectPackage(write(noInstaller))).rejects.toThrow(/installer\/install.sh/);
    const wrongName = tgz([tarEntry('./manifest.json', JSON.stringify({ name: 'other', version: '1.0.0', entry: 'a.js' }))]);
    await expect(inspectPackage(write(wrongName))).rejects.toThrow();
    await expect(inspectPackage(write(Buffer.from('not a gzip file')))).rejects.toThrow(/gzip/);
  });
});
