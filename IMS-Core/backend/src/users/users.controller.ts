import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { Request } from 'express';
import { CurrentUser, RequireRole } from '../common/decorators/auth.decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import type { AuthUser } from '../common/types/request';
import { getClientContext } from '../common/utils/request-context';
import { UsersService } from './users.service';
import { CreateUserInput, createUserSchema, resetPasswordSchema, UpdateUserInput, updateUserSchema } from './users.schemas';

@Controller('users')
@RequireRole(UserRole.ADMIN)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list() {
    return this.users.list();
  }

  @Post()
  create(@Body(new ZodValidationPipe(createUserSchema)) body: CreateUserInput, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.users.create(body, user, getClientContext(req));
  }

  @Patch(':id')
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(updateUserSchema)) body: UpdateUserInput, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.users.update(id, body, user, getClientContext(req));
  }

  @Post(':id/reset-password')
  @HttpCode(204)
  async resetPassword(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(resetPasswordSchema)) body: { password: string }, @CurrentUser() user: AuthUser, @Req() req: Request): Promise<void> {
    await this.users.resetPassword(id, body.password, user, getClientContext(req));
  }

  @Post(':id/unlock')
  @HttpCode(204)
  async unlock(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser, @Req() req: Request): Promise<void> {
    await this.users.unlock(id, user, getClientContext(req));
  }
}
