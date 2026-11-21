import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeMasterKey, loadConfig } from '../../../backend/src/config/app-config';

const base = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://ims:pw@postgres:5432/ims',
  REDIS_URL: 'redis://:pw@redis:6379/0',
  IMS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  JWT_ACCESS_SECRET: 'j'.repeat(64),
  IMS_VERSION: '9.9.9',
};

describe('loadConfig', () => {
  it('loads a valid configuration with secure defaults', () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.isProduction).toBe(true);
    expect(cfg.cookieSecure).toBe(true);
    expect(cfg.accessTokenTtlSec).toBe(900);
    expect(cfg.masterKey).toHaveLength(32);
    expect(cfg.version).toBe('9.9.9');
  });

  it('reads secrets from *_FILE variables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ims-cfg-'));
    const keyFile = join(dir, 'master_key');
    const jwtFile = join(dir, 'jwt');
    writeFileSync(keyFile, Buffer.alloc(32, 1).toString('hex') + '\n');
    writeFileSync(jwtFile, 'k'.repeat(80));
    const { IMS_MASTER_KEY: _k, JWT_ACCESS_SECRET: _j, ...rest } = base;
    const cfg = loadConfig({ ...rest, IMS_MASTER_KEY_FILE: keyFile, JWT_ACCESS_SECRET_FILE: jwtFile });
    expect(cfg.masterKey.equals(Buffer.alloc(32, 1))).toBe(true);
    expect(cfg.jwtAccessSecret).toBe('k'.repeat(80));
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails fast on missing or weak secrets', () => {
    expect(() => loadConfig({ ...base, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
    const { DATABASE_URL: _d, ...noDb } = base;
    expect(() => loadConfig(noDb)).toThrow(/DATABASE_URL/);
  });

  it('rejects a master key with the wrong length', () => {
    expect(() => decodeMasterKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });

  it('parses boolean-ish COOKIE_SECURE', () => {
    expect(loadConfig({ ...base, COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
  });
});
