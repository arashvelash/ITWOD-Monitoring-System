/**
 * Dependency-injection smoke test: compiles the complete AppModule with the
 * database and Redis replaced by stubs. Catches missing providers, circular
 * imports and wrong injection tokens without any running infrastructure.
 */
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';

process.env.DATABASE_URL = 'postgresql://ims:ims@127.0.0.1:1/ims';
process.env.REDIS_URL = 'redis://127.0.0.1:1/0';
process.env.IMS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.JWT_ACCESS_SECRET = 'x'.repeat(64);
process.env.NODE_ENV = 'test';

// Imported after the environment is prepared (config is read at provider creation).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AppModule } = require('../../../backend/src/app.module');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PrismaService } = require('../../../backend/src/prisma/prisma.service');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { REDIS } = require('../../../backend/src/redis/redis.constants');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { NOTIFICATION_QUEUE } = require('../../../backend/src/notifications/notifications.service');

describe('AppModule wiring', () => {
  it('resolves every provider', async () => {
    const fakeRedis = { on: jest.fn(), quit: jest.fn().mockResolvedValue('OK'), set: jest.fn(), eval: jest.fn(), ping: jest.fn() };
    const fakeQueue = { add: jest.fn(), close: jest.fn().mockResolvedValue(undefined) };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({ $connect: jest.fn(), $disconnect: jest.fn() })
      .overrideProvider(REDIS)
      .useValue(fakeRedis)
      .overrideProvider(getQueueToken(NOTIFICATION_QUEUE))
      .useValue(fakeQueue)
      .compile();

    const names = [
      ['../../../backend/src/servers/servers.service', 'ServersService'],
      ['../../../backend/src/backups/backup-runs.service', 'BackupRunsService'],
      ['../../../backend/src/backups/backup-jobs.service', 'BackupJobsService'],
      ['../../../backend/src/agents/agent-gateway.service', 'AgentGatewayService'],
      ['../../../backend/src/telegram/telegram-bot.service', 'TelegramBotService'],
      ['../../../backend/src/notifications/notifications.service', 'NotificationsService'],
      ['../../../backend/src/alerts/alerts.service', 'AlertsService'],
      ['../../../backend/src/monitoring/monitoring.service', 'MonitoringService'],
      ['../../../backend/src/updates/core-update.service', 'CoreUpdateService'],
      ['../../../backend/src/updates/agent-releases.service', 'AgentReleasesService'],
    ];
    for (const [path, name] of names) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const token = require(path)[name];
      expect(moduleRef.get(token, { strict: false })).toBeDefined();
    }
    await moduleRef.close();
  }, 60_000);
});
