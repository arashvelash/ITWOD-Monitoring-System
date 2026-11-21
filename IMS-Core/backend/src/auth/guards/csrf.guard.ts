import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { APP_CONFIG, AppConfig } from '../../config/app-config';
import { safeEqual } from '../../crypto/tokens';
import { CSRF_COOKIE, CSRF_HEADER } from '../auth.constants';

export const CSRF_MODE_KEY = 'ims:csrfMode';

/**
 * `origin`  – only verifies the Origin header (login, setup: no CSRF cookie exists yet).
 * `token`   – Origin check + double-submit token (cookie-authenticated endpoints).
 */
export const CsrfProtected = (mode: 'origin' | 'token' = 'token') => SetMetadata(CSRF_MODE_KEY, mode);

export function isAllowedOrigin(origin: string, requestHost: string | undefined, publicUrl?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (publicUrl) {
    try {
      if (parsed.origin === new URL(publicUrl).origin) return true;
    } catch {
      /* ignore invalid configuration */
    }
  }
  return Boolean(requestHost) && parsed.host === requestHost;
}

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const mode = this.reflector.getAllAndOverride<'origin' | 'token'>(CSRF_MODE_KEY, [context.getHandler(), context.getClass()]);
    if (!mode) return true;
    const req = context.switchToHttp().getRequest<Request>();

    // Browsers always send Origin on cross-origin and on same-origin POST requests.
    const origin = req.get('origin');
    if (origin && !isAllowedOrigin(origin, req.get('host'), this.config.publicUrl)) {
      throw new ForbiddenException('Cross-origin request rejected');
    }

    if (mode === 'token') {
      const cookie = (req.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];
      const header = req.get(CSRF_HEADER);
      if (!cookie || !header || !safeEqual(cookie, header)) {
        throw new ForbiddenException('Invalid CSRF token');
      }
    }
    return true;
  }
}
