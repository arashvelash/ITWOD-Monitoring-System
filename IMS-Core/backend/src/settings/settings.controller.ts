import { BadRequestException, Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { Request } from 'express';
import { CurrentUser, RequireRole } from '../common/decorators/auth.decorators';
import type { AuthUser } from '../common/types/request';
import { getClientContext } from '../common/utils/request-context';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from './settings.service';
import { SETTING_SECTIONS, SettingSection } from './settings.registry';

/** Sections editable through the generic endpoint. Telegram and GitHub have dedicated endpoints. */
const EDITABLE: SettingSection[] = ['general', 'security', 'monitoring'];

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequireRole(UserRole.OPERATOR)
  getAll() {
    return this.settings.getAll();
  }

  @Put(':section')
  @RequireRole(UserRole.ADMIN)
  async update(@Param('section') section: string, @Body() body: unknown, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (!EDITABLE.includes(section as SettingSection)) {
      throw new BadRequestException('This settings section cannot be edited here');
    }
    const key = section as SettingSection;
    const partial = SETTING_SECTIONS[key].schema.partial().safeParse(body);
    if (!partial.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: partial.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const updated = await this.settings.update(key, partial.data as never, user.id);
    await this.audit.byUser(user, `settings.update.${key}`, { type: 'settings', id: key }, { fields: Object.keys(partial.data) }, getClientContext(req));
    return updated;
  }
}
