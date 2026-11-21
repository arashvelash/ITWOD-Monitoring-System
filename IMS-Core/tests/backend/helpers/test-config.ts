import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../../../backend/src/config/app-config';

/** Builds a complete AppConfig for unit tests (no environment access). */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    env: 'test',
    isProduction: false,
    version: '1.0.0-test',
    port: 3000,
    host: '127.0.0.1',
    publicUrl: 'https://ims.example.test',
    databaseUrl: 'postgresql://test:test@localhost:5432/test',
    redisUrl: 'redis://localhost:6379/0',
    masterKey: randomBytes(32),
    jwtAccessSecret: 'x'.repeat(64),
    setupToken: 'setup-token-for-tests-0123456789',
    accessTokenTtlSec: 900,
    dataDir: './data-test',
    logLevel: 'error',
    trustProxy: 'loopback',
    cookieSecure: true,
    telegramApiBase: 'https://api.telegram.org',
    ...overrides,
  };
}
