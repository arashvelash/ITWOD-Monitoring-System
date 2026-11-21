import type { RedisOptions } from 'ioredis';

/**
 * Converts a redis:// URL into ioredis options. BullMQ workers require
 * `maxRetriesPerRequest: null` (blocking commands must never time out).
 */
export function redisOptionsFromUrl(url: string, overrides: Partial<RedisOptions> = {}): RedisOptions {
  const u = new URL(url);
  if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') throw new Error('REDIS_URL must use redis:// or rediss://');
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname && u.pathname !== '/' ? Number(u.pathname.slice(1)) : 0,
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    ...overrides,
  };
}
