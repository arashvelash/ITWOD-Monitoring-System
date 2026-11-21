/**
 * IMS agent protocol v1 primitives (see docs/PROTOCOL.md).
 *
 * These functions are pure and deterministic so they can be verified against
 * the shared test vectors in tests/vectors/protocol-v1.json.
 */
import { createCipheriv, createHash, createHmac, createPublicKey, hkdfSync, randomBytes, timingSafeEqual, verify } from 'node:crypto';

export const PROTOCOL = {
  httpScheme: 'IMS1-HMAC-SHA256',
  wsScheme: 'IMS1-WS-AUTH',
  commandScheme: 'IMS1-COMMAND',
  maxClockSkewSec: 300,
  nonceTtlSec: 900,
  noncePattern: /^[0-9a-f]{32}$/,
  hkdfSalt: 'ims-v1',
  hkdfInfo: 'config-secrets',
} as const;

const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export function canonicalHttpRequest(method: string, path: string, timestamp: number | string, nonce: string, body: string | Buffer): string {
  return [PROTOCOL.httpScheme, method.toUpperCase(), path, String(timestamp), nonce, sha256Hex(body ?? '')].join('\n');
}

export function canonicalWsAuth(nodeId: string, ts: number | string, nonce: string): string {
  return [PROTOCOL.wsScheme, nodeId, String(ts), nonce].join('\n');
}

export function canonicalCommand(id: string, command: string, issuedAt: number, expiresAt: number, payload: string): string {
  return [PROTOCOL.commandScheme, id, command, String(issuedAt), String(expiresAt), sha256Hex(payload)].join('\n');
}

/** HMAC-SHA256 keyed with the UTF-8 bytes of the node secret, lowercase hex. */
export function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(message, 'utf8').digest('hex');
}

export function verifyHmacHex(secret: string, message: string, signatureHex: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(signatureHex)) return false;
  const expected = Buffer.from(hmacHex(secret, message), 'hex');
  return timingSafeEqual(expected, Buffer.from(signatureHex, 'hex'));
}

/** Validates that a string is a base64 raw 32-byte Ed25519 public key. */
export function parseEd25519PublicKey(publicKeyB64: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(publicKeyB64)) return null;
  const raw = Buffer.from(publicKeyB64, 'base64');
  return raw.length === 32 ? raw : null;
}

export function ed25519Fingerprint(publicKeyB64: string): string {
  const raw = parseEd25519PublicKey(publicKeyB64);
  if (!raw) throw new Error('Invalid Ed25519 public key');
  return 'SHA256:' + sha256Hex(raw);
}

export function verifyEd25519(publicKeyB64: string, message: string, signatureB64: string): boolean {
  const raw = parseEd25519PublicKey(publicKeyB64);
  if (!raw || typeof signatureB64 !== 'string') return false;
  const signature = Buffer.from(signatureB64, 'base64');
  if (signature.length !== 64) return false;
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
    return verify(null, Buffer.from(message, 'utf8'), key, signature);
  } catch {
    return false;
  }
}

export function isTimestampFresh(timestampSec: number, nowSec = Math.floor(Date.now() / 1000)): boolean {
  return Number.isInteger(timestampSec) && Math.abs(nowSec - timestampSec) <= PROTOCOL.maxClockSkewSec;
}

/** Key used to protect secrets inside the agent config payload. */
export function deriveConfigSecretsKey(nodeSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(nodeSecret, 'utf8'), Buffer.from(PROTOCOL.hkdfSalt), Buffer.from(PROTOCOL.hkdfInfo), 32));
}

export interface SecretsEnvelope {
  alg: 'A256GCM';
  iv: string;
  tag: string;
  data: string;
}

export function sealConfigSecrets(nodeSecret: string, plaintext: string, iv: Buffer = randomBytes(12)): SecretsEnvelope {
  const cipher = createCipheriv('aes-256-gcm', deriveConfigSecretsKey(nodeSecret), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { alg: 'A256GCM', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
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

export function signCommand(nodeSecret: string, cmd: Omit<SignedCommand, 'type' | 'signature'>): SignedCommand {
  const signature = hmacHex(nodeSecret, canonicalCommand(cmd.id, cmd.command, cmd.issuedAt, cmd.expiresAt, cmd.payload));
  return { type: 'command', ...cmd, signature };
}
