import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { AgentRelease, ReleaseSource } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { RedisLockService } from '../redis/redis-lock.service';
import { DomainEvents } from '../events/domain-events.service';
import { CommandsService } from '../agents/commands.service';
import { sha256Hex, TOKEN_PREFIX } from '../crypto/tokens';
import type { AuthUser } from '../common/types/request';
import { GithubClient } from './github.client';
import { inspectPackage } from './package-inspector';
import { normalizeVersion, sortVersionsDesc } from './versions';

export const MAX_AGENT_PACKAGE_BYTES = 50 * 1024 * 1024;
const SIGNATURE_RE = /^[A-Za-z0-9+/]{86}==$/;
const TOKEN_RE = new RegExp(`^${TOKEN_PREFIX.registration}[A-Za-z0-9_-]{32}$`);

export interface RegisterOptions {
  source: ReleaseSource;
  signature?: string | null;
  releaseNotes?: string | null;
  publishedAt?: Date | null;
  expectedVersion?: string;
  expectedSha256?: string;
}

export type ReleaseView = Omit<AgentRelease, 'storagePath'> & { isLatest: boolean };

function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    let bytes = 0;
    createReadStream(path)
      .on('data', (c) => {
        bytes += (c as Buffer).length;
        h.update(c);
      })
      .on('error', reject)
      .on('end', () => resolve({ sha256: h.digest('hex'), bytes }));
  });
}

/**
 * Registry of agent releases (uploaded or synced from the private GitHub
 * repository). Packages are inspected before they are accepted and stored
 * under DATA_DIR/agent-releases/<version>/. Agents only ever receive
 * packages through signed, authenticated requests and verify the SHA-256
 * (and, when configured, an Ed25519 release signature) themselves.
 */
@Injectable()
export class AgentReleasesService implements OnModuleInit {
  private readonly logger = new Logger(AgentReleasesService.name);
  private readonly root: string;
  private readonly tmpDir: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly github: GithubClient,
    private readonly commands: CommandsService,
    private readonly events: DomainEvents,
    private readonly audit: AuditService,
    private readonly locks: RedisLockService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.root = join(config.dataDir, 'agent-releases');
    this.tmpDir = join(config.dataDir, 'tmp');
  }

  onModuleInit(): void {
    this.commands.onCompleted('agent.update', async (cmd) => {
      const version = String((cmd.payload as { version?: unknown })?.version ?? '');
      await this.events.emit('agent.update.finished', {
        serverId: cmd.serverId,
        version,
        succeeded: cmd.status === 'SUCCEEDED',
        ...(cmd.errorMessage ? { error: cmd.errorMessage } : {}),
      });
    });
  }

  /** Temporary upload location on the same filesystem as the release store (atomic rename). */
  async tempFile(): Promise<string> {
    await mkdir(this.tmpDir, { recursive: true, mode: 0o750 });
    return join(this.tmpDir, `upload-${randomUUID()}.tgz`);
  }

  async list(): Promise<ReleaseView[]> {
    const rows = sortVersionsDesc(await this.prisma.agentRelease.findMany());
    const latest = rows.find((r) => !r.isRevoked)?.version;
    return rows.map((r) => publicView(r, latest));
  }

  async latest(): Promise<AgentRelease | null> {
    return sortVersionsDesc(await this.prisma.agentRelease.findMany({ where: { isRevoked: false } }))[0] ?? null;
  }

  /** Validates and stores a package that already sits in a temporary file (the file is moved or deleted). */
  async register(tmpPath: string, opts: RegisterOptions): Promise<AgentRelease> {
    try {
      const { sha256, bytes } = await hashFile(tmpPath);
      if (bytes > MAX_AGENT_PACKAGE_BYTES) throw new BadRequestException('Package is too large');
      if (opts.expectedSha256 && opts.expectedSha256 !== sha256) throw new BadRequestException('Checksum does not match the published SHA-256');
      let manifest;
      try {
        ({ manifest } = await inspectPackage(tmpPath));
      } catch (err) {
        throw new BadRequestException(`Invalid agent package: ${(err as Error).message}`);
      }
      const version = normalizeVersion(manifest.version);
      if (opts.expectedVersion && normalizeVersion(opts.expectedVersion) !== version) {
        throw new BadRequestException(`Package version ${version} does not match release ${opts.expectedVersion}`);
      }
      const signature = opts.signature?.trim() || null;
      if (signature && !SIGNATURE_RE.test(signature)) throw new BadRequestException('Signature must be a base64 Ed25519 signature');

      const existing = await this.prisma.agentRelease.findUnique({ where: { version } });
      if (existing) {
        if (existing.sha256 === sha256) return existing;
        throw new ConflictException(`Version ${version} already exists with different content`);
      }

      const fileName = `ims-agent-${version}.tgz`;
      const dir = join(this.root, version);
      await mkdir(dir, { recursive: true, mode: 0o750 });
      const storagePath = join(dir, fileName);
      await rename(tmpPath, storagePath);
      const release = await this.prisma.agentRelease.create({
        data: { version, fileName, sha256, signature, sizeBytes: BigInt(bytes), source: opts.source, storagePath, releaseNotes: opts.releaseNotes?.slice(0, 20_000) ?? null, publishedAt: opts.publishedAt ?? null },
      });
      this.logger.log(`Registered agent release ${version} (${opts.source}, ${bytes} bytes)`);
      return release;
    } finally {
      await rm(tmpPath, { force: true });
    }
  }

  async upload(tmpPath: string, input: { signature?: string | null; releaseNotes?: string | null }, user: AuthUser) {
    const release = await this.register(tmpPath, { source: 'UPLOAD', ...input });
    await this.audit.byUser(user, 'agent-release.upload', { type: 'agent-release', id: release.version }, { sha256: release.sha256 });
    return this.view(release);
  }

  /** Imports the latest release of the configured agent repository (asset ims-agent-<version>.tgz). */
  async syncFromGithub(user?: AuthUser): Promise<{ status: 'imported' | 'up-to-date' | 'not-configured' | 'no-release'; version?: string }> {
    const { agentRepo } = await this.settings.get('github');
    if (!agentRepo) return { status: 'not-configured' };
    const release = await this.github.latestRelease(agentRepo);
    if (!release || release.draft) return { status: 'no-release' };
    const version = normalizeVersion(release.tag_name);
    if (await this.prisma.agentRelease.findUnique({ where: { version } })) return { status: 'up-to-date', version };

    const name = `ims-agent-${version}.tgz`;
    const asset = release.assets.find((a) => a.name === name);
    if (!asset) throw new BadRequestException(`Release ${release.tag_name} has no asset named ${name}`);
    const shaAsset = release.assets.find((a) => a.name === `${name}.sha256`);
    const sigAsset = release.assets.find((a) => a.name === `${name}.sig`);
    const expectedSha256 = shaAsset ? /^([0-9a-f]{64})\b/.exec((await this.github.assetText(agentRepo, shaAsset)).trim())?.[1] : undefined;
    if (shaAsset && !expectedSha256) throw new BadRequestException(`${shaAsset.name} does not contain a SHA-256 checksum`);
    const signature = sigAsset ? (await this.github.assetText(agentRepo, sigAsset, 512)).trim() : null;

    const tmp = await this.tempFile();
    await this.github.downloadAsset(agentRepo, asset, tmp, MAX_AGENT_PACKAGE_BYTES);
    const saved = await this.register(tmp, {
      source: 'GITHUB',
      expectedVersion: version,
      expectedSha256,
      signature,
      releaseNotes: release.body,
      publishedAt: release.published_at ? new Date(release.published_at) : null,
    });
    if (user) await this.audit.byUser(user, 'agent-release.sync', { type: 'agent-release', id: saved.version });
    else await this.audit.record({ actorType: 'SYSTEM', action: 'agent-release.sync', targetType: 'agent-release', targetId: saved.version });
    return { status: 'imported', version: saved.version };
  }

  @Cron('41 */6 * * *')
  async scheduledSync(): Promise<void> {
    await this.locks.runExclusive('updates.agent-sync', 15 * 60_000, async () => {
      try {
        const r = await this.syncFromGithub();
        if (r.status === 'imported') this.logger.log(`Imported agent release ${r.version} from GitHub`);
      } catch (err) {
        this.logger.warn(`Agent release sync failed: ${(err as Error).message}`);
      }
    });
  }

  async revoke(version: string, user: AuthUser) {
    const v = normalizeVersion(version);
    const release = await this.prisma.agentRelease.findUnique({ where: { version: v } });
    if (!release) throw new NotFoundException('Release not found');
    const updated = await this.prisma.agentRelease.update({ where: { id: release.id }, data: { isRevoked: true } });
    await this.audit.byUser(user, 'agent-release.revoke', { type: 'agent-release', id: v });
    return this.view(updated);
  }

  /** File details for streaming a (non-revoked) package. */
  async packageFile(version: string): Promise<{ path: string; fileName: string; sizeBytes: number; sha256: string }> {
    let v: string;
    try {
      v = normalizeVersion(version);
    } catch {
      throw new NotFoundException('Release not found');
    }
    const release = await this.prisma.agentRelease.findUnique({ where: { version: v } });
    if (!release || release.isRevoked) throw new NotFoundException('Release not found');
    const st = await stat(release.storagePath).catch(() => null);
    if (!st || st.size !== Number(release.sizeBytes)) throw new NotFoundException('Release package is missing on disk');
    return { path: release.storagePath, fileName: release.fileName, sizeBytes: st.size, sha256: release.sha256 };
  }

  /**
   * Validates a registration token for the bootstrap installer without
   * consuming it (registration itself consumes it exactly once).
   */
  async assertInstallToken(raw: string | undefined): Promise<void> {
    if (!raw || !TOKEN_RE.test(raw)) throw new ForbiddenException('Invalid registration token');
    const token = await this.prisma.registrationToken.findUnique({ where: { tokenHash: sha256Hex(raw) }, include: { server: { select: { type: true, status: true } } } });
    const valid = token && !token.usedAt && !token.revokedAt && token.expiresAt > new Date() && token.server.type === 'UBUNTU' && ['PENDING', 'REVOKED'].includes(token.server.status);
    if (!valid) throw new ForbiddenException('Invalid or expired registration token');
  }

  async installInfo() {
    const latest = await this.latest();
    if (!latest) throw new NotFoundException('No agent release is available on this Core yet');
    return { version: latest.version, sha256: latest.sha256, sizeBytes: Number(latest.sizeBytes), fileName: latest.fileName, signature: latest.signature };
  }

  /**
   * Queues signed agent.update commands. Only Ubuntu agents self-update;
   * servers already on the version or with an update in flight are skipped.
   */
  async rollout(input: { version?: string; serverIds: string[]; force?: boolean }, user: AuthUser) {
    const release = input.version ? await this.prisma.agentRelease.findUnique({ where: { version: normalizeVersion(input.version) } }) : await this.latest();
    if (!release || release.isRevoked) throw new NotFoundException('Release not found');
    const servers = await this.prisma.server.findMany({ where: { id: { in: input.serverIds } }, select: { id: true, name: true, type: true, status: true, agentVersion: true } });
    const results: { serverId: string; name?: string; queued: boolean; reason?: string; commandId?: string }[] = [];
    for (const id of input.serverIds) {
      const s = servers.find((x) => x.id === id);
      if (!s) {
        results.push({ serverId: id, queued: false, reason: 'not found' });
        continue;
      }
      const skip =
        s.type !== 'UBUNTU'
          ? 'cPanel agents are updated manually'
          : !['ONLINE', 'OFFLINE'].includes(s.status)
            ? `server is ${s.status.toLowerCase()}`
            : !input.force && s.agentVersion === release.version
              ? 'already on this version'
              : null;
      if (skip) {
        results.push({ serverId: id, name: s.name, queued: false, reason: skip });
        continue;
      }
      const inFlight = await this.prisma.nodeCommand.count({ where: { serverId: id, type: 'agent.update', status: { in: ['PENDING', 'SENT', 'ACKNOWLEDGED'] } } });
      if (inFlight) {
        results.push({ serverId: id, name: s.name, queued: false, reason: 'an update is already in progress' });
        continue;
      }
      const cmd = await this.commands.enqueue(
        id,
        'agent.update',
        { version: release.version, sha256: release.sha256, sizeBytes: Number(release.sizeBytes), signature: release.signature, path: `/api/v1/agent/releases/${release.version}/package` },
        { origin: 'DASHBOARD', createdById: user.id },
      );
      results.push({ serverId: id, name: s.name, queued: true, commandId: cmd.id });
    }
    await this.audit.byUser(user, 'agent-release.rollout', { type: 'agent-release', id: release.version }, { queued: results.filter((r) => r.queued).length, requested: input.serverIds.length });
    return { version: release.version, results };
  }

  private async view(r: AgentRelease): Promise<ReleaseView> {
    return publicView(r, (await this.latest())?.version);
  }
}

/** Never expose filesystem paths through the API. */
function publicView(r: AgentRelease, latestVersion: string | undefined): ReleaseView {
  const copy: Partial<AgentRelease> = { ...r };
  delete copy.storagePath;
  return { ...(copy as Omit<AgentRelease, 'storagePath'>), isLatest: r.version === latestVersion };
}
