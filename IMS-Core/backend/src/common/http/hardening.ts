import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AppConfig } from '../../config/app-config';

/**
 * Express-level settings shared by the real bootstrap and HTTP tests.
 */
export function applyHttpHardening(app: NestExpressApplication, config: Pick<AppConfig, 'trustProxy'>): void {
  // Trust only the reverse proxy (Caddy) on loopback / private Docker networks for X-Forwarded-*.
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  // BigInt columns (sizes, ids) serialise as numbers.
  app.set('json replacer', (_key: string, value: unknown) => (typeof value === 'bigint' ? Number(value) : value));
}
