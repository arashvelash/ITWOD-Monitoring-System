import { BadRequestException, Body, Controller, Get, Header, HttpCode, Param, Post, Put, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors, Headers } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import { CurrentUser, Public, RequireRole } from '../common/decorators/auth.decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import type { AuthUser } from '../common/types/request';
import { AgentAuthGuard } from '../agents/agent-auth.guard';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { AgentReleasesService } from './agent-releases.service';
import { CoreUpdateService } from './core-update.service';
import { isValidVersion } from './versions';

const versionSchema = z.string().refine(isValidVersion, 'Invalid version');
const repo = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Use the form owner/repository')
  .nullable();

const githubSchema = z
  .object({
    apiBase: z
      .string()
      .url()
      .refine((u) => u.startsWith('https://'), 'Must use https'),
    coreRepo: repo,
    agentRepo: repo,
    /** New token, null to remove, omitted to keep. */
    token: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_]{20,255}$/, 'Invalid GitHub token')
      .nullable(),
  })
  .partial()
  .strict();

const applySchema = z.object({ version: versionSchema }).strict();
const rolloutSchema = z
  .object({
    version: versionSchema.optional(),
    serverIds: z.array(z.string().uuid()).min(1).max(500),
    force: z.boolean().optional(),
  })
  .strict();
const uploadFieldsSchema = z.object({
  signature: z.string().trim().max(128).optional(),
  releaseNotes: z.string().max(20_000).optional(),
});

@Controller('updates')
export class UpdatesController {
  constructor(
    private readonly core: CoreUpdateService,
    private readonly releases: AgentReleasesService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  // ---- Core -----------------------------------------------------------------

  @Get('core')
  @RequireRole(UserRole.OPERATOR)
  coreInfo() {
    return this.core.info();
  }

  @Post('core/check')
  @HttpCode(200)
  @RequireRole(UserRole.ADMIN)
  @Throttle({ default: { limit: 10, ttl: 600_000 } })
  check(@CurrentUser() user: AuthUser) {
    return this.core.check(user);
  }

  @Post('core/apply')
  @HttpCode(202)
  @RequireRole(UserRole.ADMIN)
  apply(@Body(new ZodValidationPipe(applySchema)) body: z.infer<typeof applySchema>, @CurrentUser() user: AuthUser) {
    return this.core.apply(body.version, user);
  }

  // ---- GitHub source ----------------------------------------------------------

  @Get('github')
  @RequireRole(UserRole.ADMIN)
  async github() {
    return { ...(await this.settings.get('github')), tokenConfigured: await this.settings.hasSecret('github.token') };
  }

  @Put('github')
  @RequireRole(UserRole.ADMIN)
  async updateGithub(@Body(new ZodValidationPipe(githubSchema)) body: z.infer<typeof githubSchema>, @CurrentUser() user: AuthUser) {
    const { token, ...rest } = body;
    if (Object.keys(rest).length) await this.settings.update('github', rest, user.id);
    if (token !== undefined) await this.settings.setSecret('github.token', token, user.id);
    await this.audit.byUser(user, 'settings.update.github', { type: 'settings', id: 'github' }, { fields: Object.keys(body) });
    return this.github();
  }

  // ---- Agent releases ---------------------------------------------------------

  @Get('agents/releases')
  @RequireRole(UserRole.OPERATOR)
  listReleases() {
    return this.releases.list();
  }

  /** Fleet view: every agent's version plus its latest update command. */
  @Get('agents/fleet')
  @RequireRole(UserRole.OPERATOR)
  async fleet() {
    const [servers, latest] = await Promise.all([
      this.prisma.server.findMany({
        where: { status: { in: ['ONLINE', 'OFFLINE'] } },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          nodeId: true,
          type: true,
          status: true,
          agentVersion: true,
          commands: { where: { type: 'agent.update' }, orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true, payload: true, createdAt: true, completedAt: true, errorMessage: true } },
        },
      }),
      this.releases.latest(),
    ]);
    return {
      latestVersion: latest?.version ?? null,
      servers: servers.map(({ commands, ...s }) => ({ ...s, lastUpdate: commands[0] ?? null, upToDate: !!latest && s.agentVersion === latest.version })),
    };
  }

  @Post('agents/releases/sync')
  @HttpCode(200)
  @RequireRole(UserRole.ADMIN)
  @Throttle({ default: { limit: 10, ttl: 600_000 } })
  sync(@CurrentUser() user: AuthUser) {
    return this.releases.syncFromGithub(user);
  }

  @Post('agents/releases/upload')
  @RequireRole(UserRole.ADMIN)
  @UseInterceptors(FileInterceptor('file'))
  async upload(@UploadedFile() file: Express.Multer.File | undefined, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    if (!file) throw new BadRequestException('Attach the agent package as "file"');
    const fields = uploadFieldsSchema.safeParse(body ?? {});
    if (!fields.success) {
      await rm(file.path, { force: true });
      throw new BadRequestException('Invalid upload fields');
    }
    return this.releases.upload(file.path, { signature: fields.data.signature || null, releaseNotes: fields.data.releaseNotes || null }, user);
  }

  @Post('agents/releases/:version/revoke')
  @HttpCode(200)
  @RequireRole(UserRole.ADMIN)
  revoke(@Param('version', new ZodValidationPipe(versionSchema)) version: string, @CurrentUser() user: AuthUser) {
    return this.releases.revoke(version, user);
  }

  @Post('agents/rollout')
  @HttpCode(200)
  @RequireRole(UserRole.ADMIN)
  rollout(@Body(new ZodValidationPipe(rolloutSchema)) body: z.infer<typeof rolloutSchema>, @CurrentUser() user: AuthUser) {
    return this.releases.rollout(body, user);
  }
}

/**
 * Package downloads. The bootstrap installer authenticates with a still
 * unused registration token (it is consumed later by `ims-agent register`);
 * installed agents use their signed node credentials.
 */
@Controller('agent')
@Public()
export class AgentPackagesController {
  constructor(private readonly releases: AgentReleasesService) {}

  @Get('install/package-info')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 20, ttl: 900_000, blockDuration: 900_000 } })
  async installInfo(@Headers('x-ims-registration-token') token: string | undefined) {
    await this.releases.assertInstallToken(token);
    return this.releases.installInfo();
  }

  @Get('install/package')
  @Throttle({ default: { limit: 10, ttl: 900_000, blockDuration: 900_000 } })
  async installPackage(@Headers('x-ims-registration-token') token: string | undefined, @Res({ passthrough: true }) res: Response) {
    await this.releases.assertInstallToken(token);
    const info = await this.releases.installInfo();
    return this.stream(info.version, res);
  }

  @Get('releases/:version/package')
  @UseGuards(AgentAuthGuard)
  async agentPackage(@Param('version') version: string, @Res({ passthrough: true }) res: Response) {
    return this.stream(version, res);
  }

  private async stream(version: string, res: Response): Promise<StreamableFile> {
    const file = await this.releases.packageFile(version);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-IMS-Sha256', file.sha256);
    return new StreamableFile(createReadStream(file.path), { type: 'application/gzip', disposition: `attachment; filename="${file.fileName}"`, length: file.sizeBytes });
  }
}
