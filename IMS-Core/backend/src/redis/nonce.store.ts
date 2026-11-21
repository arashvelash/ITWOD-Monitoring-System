import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from './redis.constants';

/** Replay protection for signed agent requests. */
@Injectable()
export class NonceStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * Atomically records a nonce. Returns `false` when the nonce was already used
   * within the TTL window (i.e. the request is a replay).
   */
  async claim(scope: string, nonce: string, ttlSec: number): Promise<boolean> {
    const result = await this.redis.set(`ims:nonce:${scope}:${nonce}`, '1', 'EX', ttlSec, 'NX');
    return result === 'OK';
  }
}
