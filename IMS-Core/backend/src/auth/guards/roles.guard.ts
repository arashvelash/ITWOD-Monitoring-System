import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import type { Request } from 'express';
import { hasMinRole, IS_PUBLIC_KEY, MIN_ROLE_KEY } from '../../common/decorators/auth.decorators';

/** Global guard enforcing @RequireRole(). Authenticated routes default to VIEWER. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const required = this.reflector.getAllAndOverride<UserRole>(MIN_ROLE_KEY, targets) ?? UserRole.VIEWER;
    const { user } = context.switchToHttp().getRequest<Request>();
    if (!user || !hasMinRole(user.role, required)) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}
