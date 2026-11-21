import { Global, Inject, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { RedisThrottlerStorage } from './redis-throttler.storage';
import { NonceStore } from './nonce.store';
import { RedisLockService } from './redis-lock.service';
import { REDIS } from './redis.constants';

export { REDIS };

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        const logger = new Logger('Redis');
        const client = new Redis(config.redisUrl, {
          maxRetriesPerRequest: 3,
          enableReadyCheck: true,
          connectionName: 'ims-core',
        });
        client.on('error', (err) => logger.error(`Redis error: ${err.message}`));
        client.on('ready', () => logger.log('Connected to Redis'));
        return client;
      },
    },
    RedisThrottlerStorage,
    NonceStore,
    RedisLockService,
  ],
  exports: [REDIS, RedisThrottlerStorage, NonceStore, RedisLockService],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
