import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { Request } from 'express';
import { CurrentUser, RequireRole } from '../common/decorators/auth.decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import type { AuthUser } from '../common/types/request';
import { getClientContext } from '../common/utils/request-context';
import { ServersService } from './servers.service';
import { CreateServerInput, createServerSchema, ListServersQuery, listServersSchema, UpdateServerInput, updateServerSchema } from './servers.schemas';

@Controller('servers')
export class ServersController {
  constructor(private readonly servers: ServersService) {}

  @Get()
  list(@Query(new ZodValidationPipe(listServersSchema)) q: ListServersQuery) {
    return this.servers.list(q);
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.servers.get(id);
  }

  @Post()
  @RequireRole(UserRole.OPERATOR)
  create(@Body(new ZodValidationPipe(createServerSchema)) body: CreateServerInput, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.servers.create(body, user, getClientContext(req));
  }

  @Patch(':id')
  @RequireRole(UserRole.OPERATOR)
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(updateServerSchema)) body: UpdateServerInput, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.servers.update(id, body, user, getClientContext(req));
  }

  @Post(':id/registration-token')
  @RequireRole(UserRole.OPERATOR)
  issueToken(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.servers.issueToken(id, user, getClientContext(req));
  }

  @Post(':id/revoke')
  @RequireRole(UserRole.ADMIN)
  revoke(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.servers.revoke(id, user, getClientContext(req));
  }

  @Post(':id/decommission')
  @HttpCode(204)
  @RequireRole(UserRole.ADMIN)
  async decommission(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser, @Req() req: Request): Promise<void> {
    await this.servers.decommission(id, user, getClientContext(req));
  }

  @Post(':id/ping')
  @RequireRole(UserRole.OPERATOR)
  ping(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser) {
    return this.servers.ping(id, user);
  }

  @Post(':id/config-sync')
  @RequireRole(UserRole.OPERATOR)
  configSync(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser) {
    return this.servers.requestConfigSync(id, user);
  }

  @Get(':id/commands')
  commands(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.servers.listCommands(id);
  }
}
