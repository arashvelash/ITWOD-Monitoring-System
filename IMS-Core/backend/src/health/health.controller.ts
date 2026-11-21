import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import Redis from 'ioredis';
import { Public } from '../common/decorators/auth.decorators';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS } from '../redis/redis.constants';

@Controller('health')
@Public()
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Liveness: the process is up and serving requests. */
  @Get()
  live() {
    return { status: 'ok', version: this.config.version };
  }

  /** Readiness: dependencies are reachable. Used by Docker health checks and the updater. */
  @Get('ready')
  async ready() {
    const [db, redis] = await Promise.all([
      this.prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      this.redis.ping().then((r) => r === 'PONG').catch(() => false),
    ]);
    const body = { status: db && redis ? 'ok' : 'degraded', version: this.config.version, checks: { database: db, redis } };
    if (!db || !redis) throw new ServiceUnavailableException(body);
    return body;
  }
}
