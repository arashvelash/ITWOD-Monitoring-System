import { createHash, type KeyObject } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { canonicalHttp, hmacHex, newNonce, signEd25519 } from './protocol';
import { AGENT_VERSION } from './version';

export class CoreHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CoreHttpError';
  }
}

export interface CoreCredentials {
  coreUrl: string;
  nodeId: string;
  nodeSecret: string;
  privateKey: KeyObject;
}

const USER_AGENT = `ims-agent/${AGENT_VERSION} (+linux)`;

/** HTTPS client for the agent API. Every request is signed (docs/PROTOCOL.md §3). */
export class CoreClient {
  constructor(
    private readonly creds: CoreCredentials,
    private readonly timeoutMs = 30_000,
  ) {}

  private signHeaders(method: string, path: string, body: string): Record<string, string> {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = newNonce();
    const canonical = canonicalHttp(method, path, ts, nonce, body);
    return {
      'User-Agent': USER_AGENT,
      'X-IMS-Node-Id': this.creds.nodeId,
      'X-IMS-Timestamp': String(ts),
      'X-IMS-Nonce': nonce,
      'X-IMS-Signature': hmacHex(this.creds.nodeSecret, canonical),
      'X-IMS-Key-Signature': signEd25519(this.creds.privateKey, canonical),
    };
  }

  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { ...this.signHeaders(method, path, raw), Accept: 'application/json' };
    if (raw) headers['Content-Type'] = 'application/json';
    const res = await fetch(this.creds.coreUrl + path, { method, headers, body: raw || undefined, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
    const text = await res.text();
    if (!res.ok) {
      let message = res.statusText;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? message;
      } catch {
        /* non-JSON error */
      }
      throw new CoreHttpError(res.status, `Core responded ${res.status}: ${message}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Streams a download to `dest`, enforcing a size limit and returning the SHA-256. */
  async download(path: string, dest: string, maxBytes: number): Promise<{ sha256: string; bytes: number }> {
    const res = await fetch(this.creds.coreUrl + path, { headers: this.signHeaders('GET', path, ''), signal: AbortSignal.timeout(10 * 60_000), redirect: 'error' });
    if (!res.ok || !res.body) throw new CoreHttpError(res.status, `Download failed with status ${res.status}`);
    const hash = createHash('sha256');
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > maxBytes) return cb(new Error(`Download exceeds ${maxBytes} bytes`));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), meter, createWriteStream(dest, { mode: 0o600 }));
    } catch (err) {
      await rm(dest, { force: true });
      throw err;
    }
    return { sha256: hash.digest('hex'), bytes };
  }
}

export interface RegistrationResponse {
  nodeId: string;
  nodeSecret: string;
  keyFingerprint: string | null;
  heartbeatIntervalSec: number;
  metricsIntervalSec: number;
  wsPath: string;
}

/** Unauthenticated one-time registration call. */
export async function registerWithCore(coreUrl: string, body: Record<string, unknown>): Promise<RegistrationResponse> {
  const res = await fetch(`${coreUrl}/api/v1/agent/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {
      /* keep raw */
    }
    throw new CoreHttpError(res.status, `Registration failed (${res.status}): ${message}`);
  }
  return JSON.parse(text) as RegistrationResponse;
}
