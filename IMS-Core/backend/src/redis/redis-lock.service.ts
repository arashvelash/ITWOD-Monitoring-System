import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { randomBytes } from 'node:crypto';
import { REDIS } from './redis.constants';

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * Minimal distributed lock (single Redis instance) used to make sure periodic
 * jobs (offline detection, cleanup, Telegram polling) run on one backend
 * instance at a time.
 */
@Injectable()
export class RedisLockService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async acquire(name: string, ttlMs: number): Promise<string | null> {
    const token = randomBytes(16).toString('hex');
    const ok = await this.redis.set(`ims:lock:${name}`, token, 'PX', ttlMs, 'NX');
    return ok === 'OK' ? token : null;
  }

  async extend(name: string, token: string, ttlMs: number): Promise<boolean> {
    const script = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`;
    return Number(await this.redis.eval(script, 1, `ims:lock:${name}`, token, ttlMs)) === 1;
  }

  async release(name: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE_SCRIPT, 1, `ims:lock:${name}`, token);
  }

  /** Runs `fn` only if the lock could be acquired; otherwise returns undefined. */
  async runExclusive<T>(name: string, ttlMs: number, fn: () => Promise<T>): Promise<T | undefined> {
    const token = await this.acquire(name, ttlMs);
    if (!token) return undefined;
    try {
      return await fn();
    } finally {
      await this.release(name, token).catch(() => undefined);
    }
  }
}
