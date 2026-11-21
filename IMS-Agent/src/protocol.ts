/**
 * IMS protocol v1 (agent side). Must stay byte-compatible with IMS-Core;
 * verified against the shared vectors in tests/vectors/protocol-v1.json.
 */
import { createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, sign, timingSafeEqual, type KeyObject } from 'node:crypto';

export const SCHEME = {
  http: 'IMS1-HMAC-SHA256',
  ws: 'IMS1-WS-AUTH',
  command: 'IMS1-COMMAND',
} as const;

/** Commands this agent will ever execute. Anything else is rejected. */
export const ALLOWED_COMMANDS = ['ping', 'config.sync', 'monitor.collect', 'backup.run', 'agent.update'] as const;
export type CommandType = (typeof ALLOWED_COMMANDS)[number];

export const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

export function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(message, 'utf8').digest('hex');
}

export function signEd25519(privateKey: KeyObject, message: string): string {
  return sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64');
}

export function canonicalHttp(method: string, path: string, ts: number, nonce: string, body: string | Buffer): string {
  return [SCHEME.http, method.toUpperCase(), path, String(ts), nonce, sha256Hex(body)].join('\n');
}

export function canonicalWsAuth(nodeId: string, ts: number, nonce: string): string {
  return [SCHEME.ws, nodeId, String(ts), nonce].join('\n');
}

export function canonicalCommand(id: string, command: string, issuedAt: number, expiresAt: number, payload: string): string {
  return [SCHEME.command, id, command, String(issuedAt), String(expiresAt), sha256Hex(payload)].join('\n');
}

export interface SignedCommand {
  type: 'command';
  id: string;
  command: string;
  issuedAt: number;
  expiresAt: number;
  payload: string;
  signature: string;
}

export type CommandCheck = { ok: true; type: CommandType; payload: Record<string, unknown> } | { ok: false; reason: string };

/** Verifies authenticity, freshness and allow-listing of a command from Core. */
export function verifyCommand(secret: string, cmd: SignedCommand, nowSec = Math.floor(Date.now() / 1000), maxSkewSec = 300): CommandCheck {
  if (!cmd || typeof cmd.id !== 'string' || typeof cmd.command !== 'string' || typeof cmd.payload !== 'string' || typeof cmd.signature !== 'string') {
    return { ok: false, reason: 'malformed command' };
  }
  if (!Number.isInteger(cmd.issuedAt) || !Number.isInteger(cmd.expiresAt)) return { ok: false, reason: 'malformed timestamps' };
  if (!/^[0-9a-f]{64}$/.test(cmd.signature)) return { ok: false, reason: 'malformed signature' };
  const expected = Buffer.from(hmacHex(secret, canonicalCommand(cmd.id, cmd.command, cmd.issuedAt, cmd.expiresAt, cmd.payload)), 'hex');
  if (!timingSafeEqual(expected, Buffer.from(cmd.signature, 'hex'))) return { ok: false, reason: 'invalid signature' };
  if (cmd.expiresAt < nowSec) return { ok: false, reason: 'command expired' };
  if (cmd.issuedAt > nowSec + maxSkewSec) return { ok: false, reason: 'command issued in the future' };
  if (!(ALLOWED_COMMANDS as readonly string[]).includes(cmd.command)) return { ok: false, reason: `command "${cmd.command}" is not allowed` };
  let payload: unknown;
  try {
    payload = JSON.parse(cmd.payload);
  } catch {
    return { ok: false, reason: 'payload is not JSON' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'payload must be an object' };
  return { ok: true, type: cmd.command as CommandType, payload: payload as Record<string, unknown> };
}

export interface SecretsEnvelope {
  alg: 'A256GCM';
  iv: string;
  tag: string;
  data: string;
}

export function deriveConfigSecretsKey(nodeSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(nodeSecret, 'utf8'), Buffer.from('ims-v1'), Buffer.from('config-secrets'), 32));
}

/** Decrypts the `secrets` envelope of the agent configuration. */
export function openConfigSecrets<T = Record<string, Record<string, string>>>(nodeSecret: string, env: SecretsEnvelope): T {
  if (env.alg !== 'A256GCM') throw new Error('Unsupported secrets algorithm');
  const decipher = createDecipheriv('aes-256-gcm', deriveConfigSecretsKey(nodeSecret), Buffer.from(env.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(env.data, 'base64')), decipher.final()]).toString('utf8');
  return JSON.parse(plain) as T;
}
