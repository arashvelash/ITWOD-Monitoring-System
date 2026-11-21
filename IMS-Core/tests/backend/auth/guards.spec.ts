import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CsrfGuard, CSRF_MODE_KEY, isAllowedOrigin } from '../../../backend/src/auth/guards/csrf.guard';
import { RolesGuard } from '../../../backend/src/auth/guards/roles.guard';
import { hasMinRole, MIN_ROLE_KEY } from '../../../backend/src/common/decorators/auth.decorators';
import { testConfig } from '../helpers/test-config';

function httpContext(req: Record<string, unknown>): ExecutionContext {
  const headers = (req.headers ?? {}) as Record<string, string>;
  const request = { ...req, get: (name: string) => headers[name.toLowerCase()] };
  return {
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function reflectorWith(values: Record<string, unknown>): Reflector {
  return { getAllAndOverride: (key: string) => values[key] } as unknown as Reflector;
}

describe('isAllowedOrigin', () => {
  it('accepts same host and configured public URL', () => {
    expect(isAllowedOrigin('https://ims.example.test', 'ims.example.test')).toBe(true);
    expect(isAllowedOrigin('https://itwodms.ir', 'backend:3000', 'https://itwodms.ir')).toBe(true);
  });

  it('rejects foreign or malformed origins', () => {
    expect(isAllowedOrigin('https://evil.test', 'ims.example.test', 'https://ims.example.test')).toBe(false);
    expect(isAllowedOrigin('null', 'ims.example.test')).toBe(false);
  });
});

describe('CsrfGuard', () => {
  const guard = (mode: 'origin' | 'token') => new CsrfGuard(reflectorWith({ [CSRF_MODE_KEY]: mode }), testConfig());

  it('passes with matching cookie and header', () => {
    const ctx = httpContext({ headers: { origin: 'https://ims.example.test', host: 'ims.example.test', 'x-csrf-token': 'abc' }, cookies: { ims_csrf: 'abc' } });
    expect(guard('token').canActivate(ctx)).toBe(true);
  });

  it('rejects a missing or mismatching token', () => {
    const missing = httpContext({ headers: { host: 'ims.example.test' }, cookies: { ims_csrf: 'abc' } });
    const wrong = httpContext({ headers: { host: 'ims.example.test', 'x-csrf-token': 'abd' }, cookies: { ims_csrf: 'abc' } });
    expect(() => guard('token').canActivate(missing)).toThrow(ForbiddenException);
    expect(() => guard('token').canActivate(wrong)).toThrow(ForbiddenException);
  });

  it('rejects cross-origin requests even in origin-only mode', () => {
    const ctx = httpContext({ headers: { origin: 'https://evil.test', host: 'ims.example.test' } });
    expect(() => guard('origin').canActivate(ctx)).toThrow('Cross-origin request rejected');
  });
});

describe('RolesGuard', () => {
  it('applies the role hierarchy', () => {
    expect(hasMinRole('ADMIN', 'OPERATOR')).toBe(true);
    expect(hasMinRole('OPERATOR', 'OPERATOR')).toBe(true);
    expect(hasMinRole('VIEWER', 'OPERATOR')).toBe(false);
  });

  it('denies users below the required role and defaults to VIEWER', () => {
    const viewer = httpContext({ user: { role: 'VIEWER' } });
    expect(() => new RolesGuard(reflectorWith({ [MIN_ROLE_KEY]: 'ADMIN' })).canActivate(viewer)).toThrow(ForbiddenException);
    expect(new RolesGuard(reflectorWith({})).canActivate(viewer)).toBe(true);
    expect(() => new RolesGuard(reflectorWith({})).canActivate(httpContext({}))).toThrow(ForbiddenException);
  });
});
