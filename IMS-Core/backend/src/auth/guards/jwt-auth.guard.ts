import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { ALLOW_PENDING_PASSWORD_CHANGE_KEY, IS_PUBLIC_KEY } from '../../common/decorators/auth.decorators';
import { TokenService } from '../token.service';

/**
 * Global guard: every route requires a valid access token unless marked @Public().
 * The session is checked on every request so revocation takes effect immediately.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.get('authorization') ?? '';
    const match = /^Bearer\s+([A-Za-z0-9._-]+)$/.exec(header);
    if (!match) throw new UnauthorizedException('Authentication required');

    let claims;
    try {
      claims = this.tokens.verifyAccessToken(match[1]);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const session = await this.prisma.session.findUnique({ where: { id: claims.sid }, include: { user: true } });
    const now = new Date();
    // Password changes and admin resets revoke sessions, so this check also covers them.
    if (!session || session.userId !== claims.sub || session.revokedAt || session.absoluteExpiresAt <= now || !session.user.isActive) {
      throw new UnauthorizedException('Session is no longer valid');
    }

    const { user } = session;
    req.user = {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      sessionId: session.id,
      mustChangePassword: user.mustChangePassword,
    };

    if (user.mustChangePassword) {
      const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD_CHANGE_KEY, [context.getHandler(), context.getClass()]);
      if (!allowed) throw new ForbiddenException({ message: 'Password change required', code: 'PASSWORD_CHANGE_REQUIRED' });
    }
    return true;
  }
}
