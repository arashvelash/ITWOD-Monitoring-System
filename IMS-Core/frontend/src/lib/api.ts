import { authStore } from './auth-store';
import type { AuthResponse } from './types';

const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly errors?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function readCookie(name: string): string | null {
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

async function parse(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const type = res.headers.get('content-type') ?? '';
  return type.includes('application/json') ? res.json() : res.text();
}

function toError(res: Response, body: unknown): ApiError {
  const b = (body && typeof body === 'object' ? body : {}) as { message?: string; code?: string; errors?: { path: string; message: string }[] };
  return new ApiError(res.status, b.message ?? res.statusText ?? 'Request failed', b.code, b.errors);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let refreshing: Promise<boolean> | null = null;

/**
 * Exchanges the HttpOnly refresh cookie for a new access token.
 * Single-flight: concurrent callers share one request. A 409 means another
 * tab rotated the token a moment ago; the browser already has the new cookie.
 */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(`${BASE}/auth/refresh`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'X-CSRF-Token': readCookie('ims_csrf') ?? '' },
        });
        if (res.ok) {
          const data = (await res.json()) as AuthResponse;
          authStore.setSession(data.accessToken, data.user);
          return true;
        }
        if (res.status === 409 && attempt === 0) {
          await sleep(400);
          continue;
        }
        break;
      }
      authStore.clear();
      return false;
    } catch {
      authStore.clear();
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** Skip the automatic refresh + retry on 401 (used by auth endpoints). */
  noRefresh?: boolean;
  formData?: FormData;
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const url = new URL(BASE + path, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const send = () => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = authStore.get().accessToken;
    if (token) headers.Authorization = `Bearer ${token}`;
    let body: BodyInit | undefined;
    if (opts.formData) body = opts.formData;
    else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    return fetch(url.pathname + url.search, { method, headers, body, credentials: 'same-origin', signal: opts.signal });
  };

  let res = await send();
  if (res.status === 401 && !opts.noRefresh && authStore.get().accessToken) {
    if (await refreshSession()) res = await send();
  }
  const data = await parse(res);
  if (!res.ok) throw toError(res, data);
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) => request<T>('GET', path, { query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
  delete: <T>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, formData: FormData) => request<T>('POST', path, { formData }),
};

export async function login(username: string, password: string): Promise<AuthResponse> {
  const data = await request<AuthResponse>('POST', '/auth/login', { body: { username, password }, noRefresh: true });
  authStore.setSession(data.accessToken, data.user);
  return data;
}

export async function logout(): Promise<void> {
  try {
    await fetch(`${BASE}/auth/logout`, { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': readCookie('ims_csrf') ?? '' } });
  } finally {
    authStore.clear();
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.errors?.length) return err.errors.map((e) => e.message).join(' · ');
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}
