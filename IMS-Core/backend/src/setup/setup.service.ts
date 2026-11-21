import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import Redis from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS } from '../redis/redis.constants';
import { SecretBoxService } from '../crypto/secret-box.service';
import { randomHex, safeEqual } from '../crypto/tokens';
import { SettingsService } from '../settings/settings.service';
import { INTERNAL_KEYS } from '../settings/settings.registry';
import { PasswordService } from '../auth/password.service';
import { checkPasswordPolicy } from '../auth/password-policy';
import { AuditService } from '../audit/audit.service';
import type { ClientContext } from '../common/utils/request-context';
import type { SetupInput } from './setup.schemas';

@Injectable()
export class SetupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SetupService.name);
  private initializedCache = false;
  private setupToken: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly passwords: PasswordService,
    private readonly secretBox: SecretBoxService,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.setupToken = config.setupToken ?? randomHex(24);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (await this.isInitialized()) return;
    const source = this.config.setupToken ? 'from IMS_SETUP_TOKEN(_FILE)' : 'generated for this process (changes on restart)';
    this.logger.warn('====================================================================');
    this.logger.warn(' IMS is not initialized yet. Open the dashboard to run the setup wizard.');
    this.logger.warn(` Setup token (${source}):`);
    this.logger.warn(`   ${this.setupToken}`);
    this.logger.warn('====================================================================');
  }

  async isInitialized(): Promise<boolean> {
    if (this.initializedCache) return true;
    const flag = await this.prisma.systemSetting.findUnique({ where: { key: INTERNAL_KEYS.initialized } });
    this.initializedCache = Boolean(flag) || (await this.prisma.user.count()) > 0;
    return this.initializedCache;
  }

  async status() {
    const initialized = await this.isInitialized();
    if (initialized) return { initialized: true, version: this.config.version };

    const [database, migrations, redis] = await Promise.all([this.checkDatabase(), this.checkMigrations(), this.checkRedis()]);
    return {
      initialized: false,
      version: this.config.version,
      checks: {
        database,
        migrations,
        redis,
        masterKey: { ok: true, fingerprint: this.secretBox.keyFingerprint() },
        jwtSecret: { ok: this.config.jwtAccessSecret.length >= 48, length: this.config.jwtAccessSecret.length },
        https: { ok: this.config.cookieSecure, publicUrl: this.config.publicUrl ?? null },
      },
    };
  }

  async initialize(input: SetupInput, ctx: ClientContext) {
    if (await this.isInitialized()) throw new ConflictException('IMS is already initialized');
    if (!safeEqual(input.setupToken, this.setupToken)) {
      await this.audit.record({ actorType: 'SYSTEM', action: 'setup.initialize', success: false, metadata: { reason: 'bad_setup_token' }, context: ctx });
      throw new ForbiddenException('Invalid setup token');
    }
    const policy = checkPasswordPolicy(input.admin.password, input.admin.username);
    if (!policy.ok) {
      throw new BadRequestException({ message: 'Password does not meet the policy', errors: policy.errors.map((m) => ({ path: 'admin.password', message: m })) });
    }

    const passwordHash = await this.passwords.hash(input.admin.password);
    let adminId: string;
    try {
      adminId = await this.prisma.$transaction(async (tx) => {
        // Primary-key insert makes concurrent initialisation attempts fail safely.
        await tx.systemSetting.create({ data: { key: INTERNAL_KEYS.initialized, value: { at: new Date().toISOString() } as Prisma.InputJsonValue } });
        if ((await tx.user.count()) > 0) throw new ConflictException('IMS is already initialized');
        const admin = await tx.user.create({
          data: {
            username: input.admin.username,
            displayName: input.admin.displayName ?? null,
            email: input.admin.email ?? null,
            passwordHash,
            role: UserRole.ADMIN,
          },
        });
        return admin.id;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('IMS is already initialized');
      }
      throw err;
    }
    this.initializedCache = true;

    await this.settings.update('general', { instanceName: input.instance.name, publicUrl: input.instance.publicUrl ?? null, timezone: input.instance.timezone }, adminId);
    if (input.security) await this.settings.update('security', input.security, adminId);
    if (input.telegram) {
      await this.settings.update('telegram', { enabled: input.telegram.enabled && Boolean(input.telegram.botToken) }, adminId);
      if (input.telegram.botToken) await this.settings.setSecret('telegram.botToken', input.telegram.botToken, adminId);
    }

    await this.audit.record({ actorType: 'USER', actorId: adminId, actorName: input.admin.username, action: 'setup.initialize', context: ctx });
    this.logger.log(`Setup completed. Administrator "${input.admin.username}" created.`);
    return { initialized: true };
  }

  private async checkDatabase() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message.slice(0, 200) };
    }
  }

  private async checkMigrations() {
    try {
      const rows = await this.prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*)::bigint AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
      return { ok: Number(rows[0]?.count ?? 0) > 0, applied: Number(rows[0]?.count ?? 0) };
    } catch {
      return { ok: false, applied: 0 };
    }
  }

  private async checkRedis() {
    try {
      return { ok: (await this.redis.ping()) === 'PONG' };
    } catch (err) {
      return { ok: false, error: (err as Error).message.slice(0, 200) };
    }
  }
}
