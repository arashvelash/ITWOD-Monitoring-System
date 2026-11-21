import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import type { ClientContext } from '../common/utils/request-context';
import { generateToken, randomHex, sha256Hex, TOKEN_PREFIX } from '../crypto/tokens';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { checkPasswordPolicy } from './password-policy';
import { REFRESH_REUSE_GRACE_MS } from './auth.constants';

export interface PublicUser {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  role: User['role'];
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface IssuedTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
  csrfToken: string;
  user: PublicUser;
}

const INVALID_CREDENTIALS = 'Invalid username or password';

export function toPublicUser(u: User): PublicUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    email: u.email,
    role: u.role,
    mustChangePassword: u.mustChangePassword,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
  };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async login(usernameRaw: string, password: string, ctx: ClientContext): Promise<IssuedTokens> {
    const username = usernameRaw.trim().toLowerCase();
    const security = await this.settings.get('security');
    const user = await this.prisma.user.findUnique({ where: { username } });
    const now = new Date();

    if (!user) {
      await this.passwords.verifyDummy(password);
      await this.audit.record({ actorType: 'USER', actorName: username.slice(0, 64), action: 'auth.login', success: false, metadata: { reason: 'unknown_user' }, context: ctx });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (user.lockedUntil && user.lockedUntil > now) {
      await this.passwords.verifyDummy(password);
      await this.audit.record({ actorType: 'USER', actorId: user.id, actorName: user.username, action: 'auth.login', success: false, metadata: { reason: 'locked' }, context: ctx });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const valid = await this.passwords.verify(user.passwordHash, password);
    if (!valid) {
      const attempts = user.failedLoginAttempts + 1;
      const lock = attempts >= security.maxFailedLogins;
      await this.prisma.user.update({
        where: { id: user.id },
        data: lock
          ? { failedLoginAttempts: 0, lockedUntil: new Date(now.getTime() + security.lockoutMinutes * 60_000) }
          : { failedLoginAttempts: attempts },
      });
      await this.audit.record({ actorType: 'USER', actorId: user.id, actorName: user.username, action: lock ? 'auth.lockout' : 'auth.login', success: false, metadata: { reason: 'bad_password', attempts }, context: ctx });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (!user.isActive) {
      await this.audit.record({ actorType: 'USER', actorId: user.id, actorName: user.username, action: 'auth.login', success: false, metadata: { reason: 'disabled' }, context: ctx });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const passwordHash = this.passwords.needsRehash(user.passwordHash) ? await this.passwords.hash(password) : undefined;
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: now, lastLoginIp: ctx.ip, ...(passwordHash ? { passwordHash } : {}) },
    });

    const absoluteExpiresAt = new Date(now.getTime() + security.sessionAbsoluteDays * 86_400_000);
    const session = await this.prisma.session.create({
      data: { userId: user.id, ipAddress: ctx.ip, userAgent: ctx.userAgent, absoluteExpiresAt },
    });
    const refresh = await this.createRefreshToken(session.id, absoluteExpiresAt, security.sessionIdleHours);

    await this.audit.record({ actorType: 'USER', actorId: user.id, actorName: user.username, action: 'auth.login', metadata: { sessionId: session.id }, context: ctx });

    return {
      accessToken: this.tokens.signAccessToken(user.id, session.id, user.role),
      expiresIn: this.tokens.accessTtlSec,
      refreshToken: refresh.token,
      refreshExpiresAt: refresh.expiresAt,
      csrfToken: randomHex(32),
      user: toPublicUser(updated),
    };
  }

  async refresh(refreshToken: string, ctx: ClientContext): Promise<IssuedTokens> {
    if (!refreshToken?.startsWith(TOKEN_PREFIX.refresh)) throw new UnauthorizedException('Invalid session');
    const tokenHash = sha256Hex(refreshToken);
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { session: { include: { user: true } } },
    });
    if (!record) throw new UnauthorizedException('Invalid session');

    const now = new Date();
    const { session } = record;

    if (record.usedAt) {
      if (now.getTime() - record.usedAt.getTime() <= REFRESH_REUSE_GRACE_MS && !session.revokedAt) {
        // Another tab rotated the token a moment ago; the browser already holds the new cookie.
        throw new ConflictException({ message: 'Refresh token already rotated, retry', code: 'REFRESH_RACE' });
      }
      await this.revokeSession(session.id, 'refresh_token_reuse');
      await this.audit.record({ actorType: 'USER', actorId: session.userId, actorName: session.user.username, action: 'auth.refresh_reuse_detected', success: false, metadata: { sessionId: session.id }, context: ctx });
      this.logger.warn(`Refresh token reuse detected for session ${session.id}; session revoked`);
      throw new UnauthorizedException('Invalid session');
    }

    if (record.expiresAt <= now || session.revokedAt || session.absoluteExpiresAt <= now || !session.user.isActive) {
      throw new UnauthorizedException('Session expired');
    }

    // Claim the token atomically; a concurrent request that loses the race gets the retry signal.
    const claimed = await this.prisma.refreshToken.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: now } });
    if (claimed.count !== 1) {
      throw new ConflictException({ message: 'Refresh token already rotated, retry', code: 'REFRESH_RACE' });
    }

    const security = await this.settings.get('security');
    const refresh = await this.createRefreshToken(session.id, session.absoluteExpiresAt, security.sessionIdleHours);
    await this.prisma.session.update({ where: { id: session.id }, data: { lastUsedAt: now, ipAddress: ctx.ip, userAgent: ctx.userAgent } });

    return {
      accessToken: this.tokens.signAccessToken(session.userId, session.id, session.user.role),
      expiresIn: this.tokens.accessTtlSec,
      refreshToken: refresh.token,
      refreshExpiresAt: refresh.expiresAt,
      csrfToken: randomHex(32),
      user: toPublicUser(session.user),
    };
  }

  /** Revokes the session that owns the given refresh token (idempotent). */
  async logout(refreshToken: string | undefined, ctx: ClientContext): Promise<void> {
    if (!refreshToken) return;
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256Hex(refreshToken) }, include: { session: { include: { user: true } } } });
    if (!record) return;
    await this.revokeSession(record.sessionId, 'logout');
    await this.audit.record({ actorType: 'USER', actorId: record.session.userId, actorName: record.session.user.username, action: 'auth.logout', metadata: { sessionId: record.sessionId }, context: ctx });
  }

  async changePassword(userId: string, currentSessionId: string, currentPassword: string, newPassword: string, ctx: ClientContext): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (!(await this.passwords.verify(user.passwordHash, currentPassword))) {
      await this.audit.record({ actorType: 'USER', actorId: user.id, actorName: user.username, action: 'auth.password_change', success: false, context: ctx });
      throw new BadRequestException('Current password is incorrect');
    }
    if (currentPassword === newPassword) throw new BadRequestException('New password must be different from the current password');
    const policy = checkPasswordPolicy(newPassword, user.username);
    if (!policy.ok) throw new BadRequestException({ message: 'Password does not meet the policy', errors: policy.errors.map((m) => ({ path: 'newPassword', message: m })) });

    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await this.passwords.hash(newPassword), passwordChangedAt: new Date(), mustChangePassword: false },
    });
    // Keep the current session, sign out everywhere else.
    await this.prisma.session.updateMany({
      where: { userId: user.id, revokedAt: null, id: { not: currentSessionId } },
      data: { revokedAt: new Date(), revokedReason: 'password_changed' },
    });
    await this.audit.record({ actorType: 'USER', actorId: user.id, actorName: user.username, action: 'auth.password_change', context: ctx });
  }

  async listSessions(userId: string, currentSessionId: string) {
    const sessions = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, absoluteExpiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      select: { id: true, ipAddress: true, userAgent: true, createdAt: true, lastUsedAt: true, absoluteExpiresAt: true },
    });
    return sessions.map((s) => ({ ...s, current: s.id === currentSessionId }));
  }

  async revokeOwnSession(userId: string, sessionId: string): Promise<void> {
    const result = await this.prisma.session.updateMany({ where: { id: sessionId, userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'user_revoked' } });
    if (result.count === 0) throw new NotFoundException('Session not found');
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
  }

  async revokeAllSessions(userId: string, reason: string): Promise<void> {
    await this.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
  }

  private async createRefreshToken(sessionId: string, absoluteExpiresAt: Date, idleHours: number) {
    const token = generateToken(TOKEN_PREFIX.refresh, 32);
    const idleExpiry = Date.now() + idleHours * 3_600_000;
    const expiresAt = new Date(Math.min(idleExpiry, absoluteExpiresAt.getTime()));
    await this.prisma.refreshToken.create({ data: { sessionId, tokenHash: sha256Hex(token), expiresAt } });
    return { token, expiresAt };
  }
}
