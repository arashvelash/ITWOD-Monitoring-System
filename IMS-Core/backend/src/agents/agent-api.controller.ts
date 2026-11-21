import { Body, Controller, Get, Header, HttpCode, Inject, Logger, NotFoundException, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { CurrentNode, Public } from '../common/decorators/auth.decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import type { AuthenticatedNode } from '../common/types/request';
import { getClientContext } from '../common/utils/request-context';
import { SettingsService } from '../settings/settings.service';
import { AgentAuthGuard } from './agent-auth.guard';
import { AgentConfigService } from './agent-config.service';
import { AgentEventsService, REPORT_TYPES } from './agent-events.service';
import { AgentRegistrationService, RegisterInput, registerSchema } from './agent-registration.service';
import { CommandsService } from './commands.service';

const reportsSchema = z
  .object({
    reports: z
      .array(z.object({ type: z.enum(REPORT_TYPES), data: z.unknown() }).strict())
      .min(1)
      .max(100),
  })
  .strict();

/** Only a plain https origin may be templated into the installer (prevents shell injection). */
const SAFE_URL = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

@Controller('agent')
@Public()
export class AgentApiController {
  private readonly logger = new Logger(AgentApiController.name);

  constructor(
    private readonly registration: AgentRegistrationService,
    private readonly agentConfig: AgentConfigService,
    private readonly commands: CommandsService,
    private readonly events: AgentEventsService,
    private readonly settings: SettingsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('register')
  @HttpCode(201)
  @Throttle({ default: { limit: 10, ttl: 900_000, blockDuration: 900_000 } })
  register(@Body(new ZodValidationPipe(registerSchema)) body: RegisterInput, @Req() req: Request) {
    return this.registration.register(body, getClientContext(req));
  }

  @Get('config')
  @UseGuards(AgentAuthGuard)
  @Header('Cache-Control', 'no-store')
  getConfig(@CurrentNode() node: AuthenticatedNode) {
    return this.agentConfig.build(node);
  }

  @Get('commands')
  @UseGuards(AgentAuthGuard)
  @Header('Cache-Control', 'no-store')
  async pollCommands(@CurrentNode() node: AuthenticatedNode) {
    return { commands: await this.commands.poll(node.serverId, node.secret), configVersion: await this.agentConfig.currentVersion(node.serverId) };
  }

  @Post('reports')
  @HttpCode(200)
  @UseGuards(AgentAuthGuard)
  async reports(@Body(new ZodValidationPipe(reportsSchema)) body: z.infer<typeof reportsSchema>, @CurrentNode() node: AuthenticatedNode) {
    const results: { index: number; ok: boolean; error?: string }[] = [];
    for (const [index, report] of body.reports.entries()) {
      try {
        await this.events.dispatch(node, report.type, report.data);
        results.push({ index, ok: true });
      } catch (err) {
        this.logger.warn(`Report ${report.type} from ${node.nodeId} rejected: ${(err as Error).message}`);
        results.push({ index, ok: false, error: 'rejected' });
      }
    }
    return { accepted: results.filter((r) => r.ok).length, results, configVersion: await this.agentConfig.currentVersion(node.serverId) };
  }

  /** Bootstrap installer served at https://<core>/install-agent.sh (via Caddy rewrite). */
  @Get('install/script')
  @Header('Content-Type', 'text/x-shellscript; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async installScript(@Req() req: Request): Promise<string> {
    const candidates = [resolve(__dirname, '../../../assets/install-agent.sh'), resolve(__dirname, '../../../scripts/install-agent.sh')];
    const file = candidates.find((p) => existsSync(p));
    if (!file) throw new NotFoundException('Installer not available');
    const general = await this.settings.get('general');
    const derived = `${req.protocol}://${req.get('host') ?? ''}`;
    const coreUrl = [general.publicUrl, this.config.publicUrl, derived].find((u): u is string => typeof u === 'string' && SAFE_URL.test(u.replace(/\/+$/, ''))) ?? '';
    return readFileSync(file, 'utf8').replace(/__IMS_DEFAULT_CORE_URL__/g, coreUrl.replace(/\/+$/, ''));
  }
}
