import { BadRequestException, ConflictException, Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { CoreUpdateStatus } from '@prisma/client';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { INTERNAL_KEYS } from '../settings/settings.registry';
import { AuditService } from '../audit/audit.service';
import { RedisLockService } from '../redis/redis-lock.service';
import { DomainEvents } from '../events/domain-events.service';
import type { AuthUser } from '../common/types/request';
import { GithubClient } from './github.client';
import { isNewer, isValidVersion, normalizeVersion } from './versions';

/**
 * File contract with the host-side updater (scripts/update.sh, run by the
 * ims-updater systemd path unit). The backend container has no Docker socket
 * and no shell access to the host: it can only *request* an update of a
 * released version by writing request.json; the host validates everything again.
 *
 *   DATA_DIR/update/request.json   written by Core   { id, version, requestedAt, requestedBy }
 *   DATA_DIR/update/status.json    written by host   { id, state, step, message, ... }
 *   DATA_DIR/update/updater.json   written by host   { installed, installedAt, version }
 *   DATA_DIR/update/last-run.log   written by host   log of the latest run
 */
export const updaterStatusSchema = z.object({
  id: z.string().uuid().optional(),
  state: z.enum(['idle', 'queued', 'running', 'succeeded', 'failed', 'rolled_back']),
  step: z.string().max(64).optional(),
  message: z.string().max(2000).optional(),
  fromVersion: z.string().max(32).optional(),
  targetVersion: z.string().max(32).optional(),
  startedAt: z.string().max(40).optional(),
  finishedAt: z.string().max(40).optional(),
  updatedAt: z.string().max(40).optional(),
});

export type UpdaterStatus = z.infer<typeof updaterStatusSchema>;

interface LatestCoreRelease {
  version: string | null;
  notes: string | null;
  publishedAt: string | null;
  checkedAt: string;
}

const STATE_TO_STATUS: Record<UpdaterStatus['state'], CoreUpdateStatus | null> = {
  idle: null,
  queued: 'RUNNING',
  running: 'RUNNING',
  succeeded: 'SUCCEEDED',
  failed: 'FAILED',
  rolled_back: 'ROLLED_BACK',
};

const FINAL: CoreUpdateStatus[] = ['SUCCEEDED', 'FAILED', 'ROLLED_BACK'];
const PICKUP_TIMEOUT_MS = 30 * 60_000;

@Injectable()
export class CoreUpdateService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CoreUpdateService.name);
  private readonly dir: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly github: GithubClient,
    private readonly audit: AuditService,
    private readonly locks: RedisLockService,
    private readonly events: DomainEvents,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.dir = join(config.dataDir, 'update');
  }

  async onApplicationBootstrap(): Promise<void> {
    // After a restart caused by an update, record the outcome right away.
    await this.syncStatus().catch((err: Error) => this.logger.warn(`Update status sync failed: ${err.message}`));
  }

  private path(name: 'request.json' | 'status.json' | 'updater.json' | 'last-run.log'): string {
    return join(this.dir, name);
  }

  async readStatus(): Promise<UpdaterStatus | null> {
    try {
      const parsed = updaterStatusSchema.safeParse(JSON.parse(await readFile(this.path('status.json'), 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  updaterInstalled(): boolean {
    return existsSync(this.path('updater.json'));
  }

  async info() {
    await this.syncStatus().catch(() => undefined);
    const [latest, github, history, status] = await Promise.all([
      this.settings.getInternal<LatestCoreRelease>(INTERNAL_KEYS.latestCoreRelease),
      this.settings.get('github'),
      this.prisma.coreUpdate.findMany({ orderBy: { requestedAt: 'desc' }, take: 20, select: { id: true, fromVersion: true, toVersion: true, status: true, currentStep: true, requestedAt: true, startedAt: true, finishedAt: true, errorMessage: true } }),
      this.readStatus(),
    ]);
    const latestVersion = latest?.version && isValidVersion(latest.version) ? latest.version : null;
    return {
      currentVersion: this.config.version,
      latestVersion,
      latestCheckedAt: latest?.checkedAt ?? null,
      latestPublishedAt: latest?.publishedAt ?? null,
      latestReleaseNotes: latest?.notes ?? null,
      updateAvailable: latestVersion ? isNewer(latestVersion, this.config.version) : false,
      repoConfigured: Boolean(github.coreRepo),
      updaterInstalled: this.updaterInstalled(),
      requestPending: existsSync(this.path('request.json')),
      status,
      history,
    };
  }

  async check(user?: AuthUser) {
    const { coreRepo } = await this.settings.get('github');
    if (!coreRepo) throw new BadRequestException('Configure the Core repository in Updates › GitHub first');
    const release = await this.github.latestRelease(coreRepo);
    const value: LatestCoreRelease = {
      version: release && !release.draft && isValidVersion(release.tag_name) ? normalizeVersion(release.tag_name) : null,
      notes: release?.body?.slice(0, 20_000) ?? null,
      publishedAt: release?.published_at ?? null,
      checkedAt: new Date().toISOString(),
    };
    await this.settings.setInternal(INTERNAL_KEYS.latestCoreRelease, value);
    if (user) await this.audit.byUser(user, 'core-update.check', { type: 'core', id: value.version ?? 'none' });
    return this.info();
  }

  @Cron('23 */6 * * *')
  async scheduledCheck(): Promise<void> {
    await this.locks.runExclusive('updates.core-check', 5 * 60_000, async () => {
      const { coreRepo } = await this.settings.get('github');
      if (!coreRepo) return;
      await this.check().catch((err: Error) => this.logger.warn(`Core release check failed: ${err.message}`));
    });
  }

  /** Requests an update to a known, newer release. The host updater does the rest. */
  async apply(version: string, user: AuthUser) {
    const target = normalizeVersion(version);
    if (!this.updaterInstalled()) throw new BadRequestException('The host updater is not installed. Run "sudo ./scripts/install-updater.sh" on the Core host.');
    const latest = await this.settings.getInternal<LatestCoreRelease>(INTERNAL_KEYS.latestCoreRelease);
    if (!latest?.version || latest.version !== target) throw new BadRequestException('Only the latest published release can be installed. Check for updates first.');
    if (!isNewer(target, this.config.version)) throw new BadRequestException(`Core is already on ${this.config.version}`);

    const inFlight = await this.prisma.coreUpdate.findFirst({ where: { status: { in: ['REQUESTED', 'RUNNING'] } } });
    if (inFlight || existsSync(this.path('request.json'))) throw new ConflictException('An update is already in progress');

    const row = await this.prisma.coreUpdate.create({ data: { fromVersion: this.config.version, toVersion: target, status: 'REQUESTED', requestedById: user.id } });
    await mkdir(this.dir, { recursive: true, mode: 0o750 });
    const tmp = this.path('request.json') + '.tmp';
    await writeFile(tmp, JSON.stringify({ id: row.id, version: target, requestedAt: row.requestedAt.toISOString(), requestedBy: user.username }) + '\n', { mode: 0o640 });
    await rename(tmp, this.path('request.json'));
    await this.audit.byUser(user, 'core-update.request', { type: 'core', id: target }, { from: this.config.version });
    this.logger.log(`Core update to ${target} requested by ${user.username}`);
    return row;
  }

  /** Mirrors the host updater's status file into the core_updates history. */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async syncStatus(): Promise<void> {
    const status = await this.readStatus();
    if (status?.id) {
      const row = await this.prisma.coreUpdate.findUnique({ where: { id: status.id } });
      const mapped = STATE_TO_STATUS[status.state];
      if (row && mapped && !FINAL.includes(row.status) && (row.status !== mapped || row.currentStep !== (status.step ?? null))) {
        const final = FINAL.includes(mapped);
        const log = final ? await readFile(this.path('last-run.log'), 'utf8').then((t) => t.slice(-16_000)).catch(() => null) : undefined;
        const updated = await this.prisma.coreUpdate.update({
          where: { id: row.id },
          data: {
            status: mapped,
            currentStep: status.step ?? null,
            startedAt: row.startedAt ?? (status.startedAt ? new Date(status.startedAt) : new Date()),
            ...(final ? { finishedAt: status.finishedAt ? new Date(status.finishedAt) : new Date(), log } : {}),
            ...(mapped !== 'SUCCEEDED' && status.message ? { errorMessage: status.message.slice(0, 2000) } : {}),
          },
        });
        if (final) {
          this.logger.log(`Core update ${updated.fromVersion} → ${updated.toVersion} finished: ${mapped}`);
          await this.events.emit('core.update.finished', { fromVersion: updated.fromVersion, toVersion: updated.toVersion, status: mapped, message: status.message });
        }
      }
    }
    // A request nobody picked up (updater stopped/uninstalled) must not block future updates forever.
    const stale = await this.prisma.coreUpdate.findMany({ where: { status: 'REQUESTED', requestedAt: { lt: new Date(Date.now() - PICKUP_TIMEOUT_MS) } } });
    for (const s of stale) {
      await this.prisma.coreUpdate.update({ where: { id: s.id }, data: { status: 'FAILED', finishedAt: new Date(), errorMessage: 'The host updater did not pick up the request within 30 minutes.' } });
      await rm(this.path('request.json'), { force: true }).catch(() => undefined);
    }
  }
}
