import type { CookieOptions } from 'express';

export const CSRF_COOKIE = 'ims_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const AUTH_COOKIE_PATH = '/api/v1/auth';

/** `__Secure-` prefix requires the Secure attribute, so it is only used over HTTPS. */
export function refreshCookieName(secure: boolean): string {
  return secure ? '__Secure-ims_rt' : 'ims_rt';
}

export function refreshCookieOptions(secure: boolean, maxAgeMs: number): CookieOptions {
  return { httpOnly: true, secure, sameSite: 'strict', path: AUTH_COOKIE_PATH, maxAge: maxAgeMs };
}

/** Readable by the SPA (double-submit pattern), therefore not HttpOnly. */
export function csrfCookieOptions(secure: boolean, maxAgeMs: number): CookieOptions {
  return { httpOnly: false, secure, sameSite: 'strict', path: '/', maxAge: maxAgeMs };
}

/** Multi-tab grace window: reuse of a just-rotated refresh token is not treated as theft. */
export const REFRESH_REUSE_GRACE_MS = 15_000;
