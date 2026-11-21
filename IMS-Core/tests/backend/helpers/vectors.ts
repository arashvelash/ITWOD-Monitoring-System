import { createPrivateKey, sign as edSign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Shared protocol vectors (tests/vectors/protocol-v1.json). */
export const vectors = JSON.parse(readFileSync(resolve(__dirname, '../../vectors/protocol-v1.json'), 'utf8'));

export function vectorPrivateKey(): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(vectors.ed25519.seedHex, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function edSignB64(message: string, key = vectorPrivateKey()): string {
  return edSign(null, Buffer.from(message, 'utf8'), key).toString('base64');
}
