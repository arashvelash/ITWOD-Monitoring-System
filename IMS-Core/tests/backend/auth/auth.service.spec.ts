import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { AuthService } from '../../../backend/src/auth/auth.service';
import { PasswordService } from '../../../backend/src/auth/password.service';
import { TokenService } from '../../../backend/src/auth/token.service';
import { SETTING_SECTIONS } from '../../../backend/src/settings/settings.registry';
import { createFakeAuthPrisma, FakeAuthPrisma } from '../helpers/fake-auth-prisma';
import { testConfig } from '../helpers/test-config';

const ctx = { ip: '203.0.113.10', userAgent: 'jest' };
const PASSWORD = 'a very long admin passphrase';

describe('AuthService', () => {
  let prisma: FakeAuthPrisma;
  let auth: AuthService;
  let tokens: TokenService;
  const passwords = new PasswordService();
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const settings = { get: jest.fn().mockResolvedValue(SETTING_SECTIONS.security.defaults) };
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await passwords.hash(PASSWORD);
  });

  beforeEach(() => {
    prisma = createFakeAuthPrisma();
    prisma.users.push({
      id: randomUUID(),
      username: 'admin',
      displayName: 'Admin',
      email: null,
      passwordHash,
      role: 'ADMIN',
      isActive: true,
      mustChangePassword: false,
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: null,
      createdAt: new Date(),
      passwordChangedAt: new Date(),
    });
    tokens = new TokenService(new JwtService({}), testConfig());
    auth = new AuthService(prisma as never, passwords, tokens, settings as never, audit as never);
    audit.record.mockClear();
  });

  it('logs in with valid credentials and issues verifiable tokens', async () => {
    const issued = await auth.login('Admin', PASSWORD, ctx);
    const claims = tokens.verifyAccessToken(issued.accessToken);
    expect(claims.sub).toBe(prisma.users[0].id);
    expect(claims.role).toBe('ADMIN');
    expect(issued.refreshToken).toMatch(/^imsrt_/);
    expect(issued.csrfToken).toMatch(/^[0-9a-f]{64}$/);
    // Only the hash of the refresh token is stored.
    expect(prisma.refreshTokens[0].tokenHash).not.toBe(issued.refreshToken);
    expect(prisma.refreshTokens[0].tokenHash).toHaveLength(64);
    expect(issued.user).not.toHaveProperty('passwordHash');
  });

  it('rejects unknown users and wrong passwords with the same message', async () => {
    await expect(auth.login('nobody', PASSWORD, ctx)).rejects.toThrow('Invalid username or password');
    await expect(auth.login('admin', 'wrong-password-123', ctx)).rejects.toThrow('Invalid username or password');
  });

  it('locks the account after too many failures, even for the correct password', async () => {
    for (let i = 0; i < SETTING_SECTIONS.security.defaults.maxFailedLogins; i++) {
      await expect(auth.login('admin', `wrong-password-${i}xx`, ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(prisma.users[0].lockedUntil).toBeInstanceOf(Date);
    await expect(auth.login('admin', PASSWORD, ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects disabled users', async () => {
    prisma.users[0].isActive = false;
    await expect(auth.login('admin', PASSWORD, ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rotates refresh tokens and invalidates the old one', async () => {
    const first = await auth.login('admin', PASSWORD, ctx);
    const second = await auth.refresh(first.refreshToken, ctx);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(prisma.refreshTokens.find((t) => t.usedAt)).toBeDefined();
    // The new token keeps working.
    await expect(auth.refresh(second.refreshToken, ctx)).resolves.toHaveProperty('accessToken');
  });

  it('signals a retry when a just-rotated token is reused within the grace window', async () => {
    const first = await auth.login('admin', PASSWORD, ctx);
    await auth.refresh(first.refreshToken, ctx);
    await expect(auth.refresh(first.refreshToken, ctx)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.sessions[0].revokedAt).toBeNull();
  });

  it('revokes the whole session when an old refresh token is replayed after the grace window', async () => {
    const first = await auth.login('admin', PASSWORD, ctx);
    await auth.refresh(first.refreshToken, ctx);
    prisma.refreshTokens[0].usedAt = new Date(Date.now() - 60_000);
    await expect(auth.refresh(first.refreshToken, ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.sessions[0].revokedAt).toBeInstanceOf(Date);
    expect(prisma.sessions[0].revokedReason).toBe('refresh_token_reuse');
  });

  it('rejects expired refresh tokens and revoked sessions', async () => {
    const issued = await auth.login('admin', PASSWORD, ctx);
    prisma.refreshTokens[0].expiresAt = new Date(Date.now() - 1000);
    await expect(auth.refresh(issued.refreshToken, ctx)).rejects.toBeInstanceOf(UnauthorizedException);

    const again = await auth.login('admin', PASSWORD, ctx);
    await auth.logout(again.refreshToken, ctx);
    await expect(auth.refresh(again.refreshToken, ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects malformed refresh tokens without a database lookup', async () => {
    await expect(auth.refresh('not-a-token', ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('changes the password and revokes other sessions', async () => {
    const a = await auth.login('admin', PASSWORD, ctx);
    await auth.login('admin', PASSWORD, ctx);
    const current = tokens.verifyAccessToken(a.accessToken).sid;
    await auth.changePassword(prisma.users[0].id, current, PASSWORD, 'another very long passphrase', ctx);
    const others = prisma.sessions.filter((s) => s.id !== current);
    expect(others.every((s) => s.revokedAt instanceof Date)).toBe(true);
    expect(prisma.sessions.find((s) => s.id === current)?.revokedAt).toBeNull();
    await expect(auth.login('admin', 'another very long passphrase', ctx)).resolves.toBeDefined();
  });
});
