import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import { UserRole } from '@prisma/client';
import type { AuthUser, AuthenticatedNode } from '../types/request';

export const IS_PUBLIC_KEY = 'ims:isPublic';
export const MIN_ROLE_KEY = 'ims:minRole';
export const ALLOW_PENDING_PASSWORD_CHANGE_KEY = 'ims:allowPendingPasswordChange';

/** Skips dashboard JWT authentication (used for login, setup, health and agent routes). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Minimum role required for a route. Hierarchy: ADMIN > OPERATOR > VIEWER. */
export const RequireRole = (role: UserRole) => SetMetadata(MIN_ROLE_KEY, role);

/** Allows a user whose password must be changed to call this route. */
export const AllowPendingPasswordChange = () => SetMetadata(ALLOW_PENDING_PASSWORD_CHANGE_KEY, true);

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.user) throw new Error('CurrentUser used on an unauthenticated route');
  return req.user;
});

export const CurrentNode = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthenticatedNode => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.node) throw new Error('CurrentNode used on a route without AgentAuthGuard');
  return req.node;
});

const ROLE_RANK: Record<UserRole, number> = { VIEWER: 1, OPERATOR: 2, ADMIN: 3 };

export function hasMinRole(actual: UserRole, required: UserRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}
