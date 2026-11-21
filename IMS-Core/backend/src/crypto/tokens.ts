import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Well-known token prefixes (helps secret scanners and humans identify leaks). */
export const TOKEN_PREFIX = {
  registration: 'imsr_',
  nodeSecret: 'imss_',
  refresh: 'imsrt_',
  telegramLink: 'IMS-',
} as const;

/** Generates `<prefix><base64url(bytes)>` using a CSPRNG. */
export function generateToken(prefix: string, bytes: number): string {
  return prefix + randomBytes(bytes).toString('base64url');
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Constant-time string comparison that does not leak length differences
 * (both sides are hashed to a fixed length first).
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** Human friendly one-time code, e.g. IMS-7K3Q-9XWD (no ambiguous characters). */
export function generateHumanCode(prefix: string = TOKEN_PREFIX.telegramLink, groups = 2, groupLength = 4): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const parts: string[] = [];
  for (let g = 0; g < groups; g++) {
    const buf = randomBytes(groupLength);
    let part = '';
    for (let i = 0; i < groupLength; i++) part += alphabet[buf[i] % alphabet.length];
    parts.push(part);
  }
  return prefix + parts.join('-');
}
