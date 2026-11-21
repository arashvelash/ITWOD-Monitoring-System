import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { readJson, writeFileAtomic, writeJson } from './fs-utils';
import type { AgentPaths } from './paths';

/** Persistent node identity written at registration (identity.json, 0600). */
export interface Identity {
  version: 1;
  nodeId: string;
  coreUrl: string;
  nodeSecret: string;
  keyFingerprint: string | null;
  registeredAt: string;
}

export function generateNodeKey(): { privateKey: KeyObject; publicKeyBase64: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKeyBase64: rawPublicKeyBase64(publicKey) };
}

export function rawPublicKeyBase64(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('Not an Ed25519 key');
  return Buffer.from(jwk.x, 'base64url').toString('base64');
}

export function fingerprint(publicKeyBase64: string): string {
  return 'SHA256:' + createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex');
}

export async function savePrivateKey(paths: AgentPaths, key: KeyObject): Promise<void> {
  await writeFileAtomic(paths.privateKeyFile, key.export({ format: 'pem', type: 'pkcs8' }) as string, 0o600);
}

export async function loadPrivateKey(paths: AgentPaths): Promise<KeyObject> {
  await assertPrivate(paths.privateKeyFile);
  return createPrivateKey(await readFile(paths.privateKeyFile, 'utf8'));
}

export function publicKeyOf(privateKey: KeyObject): string {
  return rawPublicKeyBase64(createPublicKey(privateKey));
}

export async function loadIdentity(paths: AgentPaths): Promise<Identity | null> {
  const id = await readJson<Identity>(paths.identityFile);
  if (!id) return null;
  await assertPrivate(paths.identityFile);
  if (id.version !== 1 || !/^ims-node-\d{4,}$/.test(id.nodeId) || !id.nodeSecret?.startsWith('imss_') || !id.coreUrl) {
    throw new Error(`Identity file ${paths.identityFile} is invalid`);
  }
  return id;
}

export async function saveIdentity(paths: AgentPaths, identity: Identity): Promise<void> {
  await writeJson(paths.identityFile, identity, 0o600);
}

/** Refuses to use secret files that other users can read (POSIX only). */
async function assertPrivate(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const s = await stat(path);
  if (s.mode & 0o077) {
    throw new Error(`${path} must not be accessible by group/others (chmod 600 ${path})`);
  }
}
