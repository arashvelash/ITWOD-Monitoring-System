import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AlertSeverity, AlertStatus, UserRole } from '@prisma/client';
import { z } from 'zod';
import { CurrentUser, RequireRole } from '../common/decorators/auth.decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import type { AuthUser } from '../common/types/request';
import { paginationSchema } from '../common/utils/request-context';
import { AlertsService } from './alerts.service';

const listSchema = paginationSchema.extend({
  status: z.union([z.nativeEnum(AlertStatus), z.literal('ACTIVE')]).optional(),
  severity: z.nativeEnum(AlertSeverity).optional(),
  serverId: z.string().uuid().optional(),
});

@Controller('alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  list(@Query(new ZodValidationPipe(listSchema)) q: z.infer<typeof listSchema>) {
    return this.alerts.list(q);
  }

  @Post(':id/acknowledge')
  @HttpCode(200)
  @RequireRole(UserRole.OPERATOR)
  acknowledge(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser) {
    return this.alerts.acknowledge(id, user);
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @RequireRole(UserRole.OPERATOR)
  resolve(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser) {
    return this.alerts.resolveManually(id, user);
  }
}
