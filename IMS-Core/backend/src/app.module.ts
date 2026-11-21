import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { RedisThrottlerStorage } from './redis/redis-throttler.storage';
import { CryptoModule } from './crypto/crypto.module';
import { AuditModule } from './audit/audit.module';
import { SettingsModule } from './settings/settings.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { SetupModule } from './setup/setup.module';
import { UsersModule } from './users/users.module';
import { HealthModule } from './health/health.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { AgentsModule } from './agents/agents.module';
import { ServersModule } from './servers/servers.module';
import { EventsModule } from './events/domain-events.service';
import { ProjectsModule } from './projects/projects.module';
import { BackupsModule } from './backups/backups.module';
import { TelegramModule } from './telegram/telegram.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AlertsModule } from './alerts/alerts.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { UpdatesModule } from './updates/updates.module';
import { APP_CONFIG, AppConfig } from './config/app-config';
import { redisOptionsFromUrl } from './redis/redis-url';

@Module({
  imports: [
    // Infrastructure
    ConfigModule,
    PrismaModule,
    RedisModule,
    CryptoModule,
    ScheduleModule.forRoot(),
    BullModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        connection: redisOptionsFromUrl(config.redisUrl, { maxRetriesPerRequest: null }),
        prefix: 'ims:bull',
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [RedisThrottlerStorage],
      useFactory: (storage: RedisThrottlerStorage) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }],
        storage,
      }),
    }),
    // Core platform
    AuditModule,
    SettingsModule,
    AuthModule,
    SetupModule,
    UsersModule,
    HealthModule,
    DashboardModule,
    // Infrastructure management
    EventsModule,
    AgentsModule,
    ServersModule,
    ProjectsModule,
    BackupsModule,
    // Monitoring
    AlertsModule,
    MonitoringModule,
    // Updates
    UpdatesModule,
    // Communication
    TelegramModule,
    NotificationsModule,
  ],
  providers: [
    // Order matters: rate limit -> authenticate -> authorise.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
