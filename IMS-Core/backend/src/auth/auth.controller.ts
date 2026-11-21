import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { AllowPendingPasswordChange, CurrentUser, Public } from '../common/decorators/auth.decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import type { AuthUser } from '../common/types/request';
import { getClientContext } from '../common/utils/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService, IssuedTokens, toPublicUser } from './auth.service';
import { CsrfGuard, CsrfProtected } from './guards/csrf.guard';
import { CSRF_COOKIE, csrfCookieOptions, refreshCookieName, refreshCookieOptions, AUTH_COOKIE_PATH } from './auth.constants';
import { passwordSchema } from './password-policy';

const loginSchema = z.object({ username: z.string().trim().min(1).max(64), password: passwordSchema }).strict();
const changePasswordSchema = z.object({ currentPassword: passwordSchema, newPassword: passwordSchema }).strict();

@Controller('auth')
@UseGuards(CsrfGuard)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @CsrfProtected('origin')
  @Throttle({ default: { limit: 10, ttl: 60_000, blockDuration: 300_000 } })
  async login(@Body(new ZodValidationPipe(loginSchema)) body: z.infer<typeof loginSchema>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const issued = await this.auth.login(body.username, body.password, getClientContext(req));
    return this.respondWithTokens(res, issued);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @CsrfProtected('token')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req.cookies as Record<string, string> | undefined)?.[refreshCookieName(this.config.cookieSecure)];
    try {
      const issued = await this.auth.refresh(token ?? '', getClientContext(req));
      return this.respondWithTokens(res, issued);
    } catch (err) {
      const status = (err as { getStatus?: () => number }).getStatus?.();
      if (status === 401) this.clearCookies(res);
      throw err;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  @CsrfProtected('token')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = (req.cookies as Record<string, string> | undefined)?.[refreshCookieName(this.config.cookieSecure)];
    await this.auth.logout(token, getClientContext(req));
    this.clearCookies(res);
  }

  @Get('me')
  @AllowPendingPasswordChange()
  async me(@CurrentUser() user: AuthUser) {
    const record = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    return toPublicUser(record);
  }

  @Post('change-password')
  @HttpCode(204)
  @AllowPendingPasswordChange()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async changePassword(@Body(new ZodValidationPipe(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>, @CurrentUser() user: AuthUser, @Req() req: Request): Promise<void> {
    await this.auth.changePassword(user.id, user.sessionId, body.currentPassword, body.newPassword, getClientContext(req));
  }

  @Get('sessions')
  @AllowPendingPasswordChange()
  sessions(@CurrentUser() user: AuthUser) {
    return this.auth.listSessions(user.id, user.sessionId);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeSession(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser): Promise<void> {
    await this.auth.revokeOwnSession(user.id, id);
  }

  private respondWithTokens(res: Response, issued: IssuedTokens) {
    const secure = this.config.cookieSecure;
    const maxAge = Math.max(0, issued.refreshExpiresAt.getTime() - Date.now());
    res.cookie(refreshCookieName(secure), issued.refreshToken, refreshCookieOptions(secure, maxAge));
    res.cookie(CSRF_COOKIE, issued.csrfToken, csrfCookieOptions(secure, maxAge));
    res.setHeader('Cache-Control', 'no-store');
    return { accessToken: issued.accessToken, expiresIn: issued.expiresIn, user: issued.user };
  }

  private clearCookies(res: Response) {
    const secure = this.config.cookieSecure;
    res.clearCookie(refreshCookieName(secure), { path: AUTH_COOKIE_PATH, httpOnly: true, secure, sameSite: 'strict' });
    res.clearCookie(CSRF_COOKIE, { path: '/', secure, sameSite: 'strict' });
  }
}
