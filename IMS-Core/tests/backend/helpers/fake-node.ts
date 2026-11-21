import { randomBytes } from 'node:crypto';
import { SecretBoxService } from '../../../backend/src/crypto/secret-box.service';
import { NodeAuthService } from '../../../backend/src/agents/node-auth.service';
import { canonicalHttpRequest, canonicalWsAuth, hmacHex } from '../../../backend/src/crypto/node-protocol';
import { testConfig } from './test-config';
import { edSignB64, vectors } from './vectors';

export const SERVER_ID = '11111111-2222-4333-8444-555555555555';
export const NODE_ID = 'ims-node-0001';

/** Builds a NodeAuthService backed by an in-memory server/credential and nonce store. */
export function createNodeAuthFixture(overrides: { publicKey?: string | null; status?: string; revoked?: boolean } = {}) {
  const box = new SecretBoxService(testConfig());
  const server = {
    id: SERVER_ID,
    nodeId: NODE_ID,
    type: 'UBUNTU',
    status: overrides.status ?? 'ONLINE',
    credential: {
      serverId: SERVER_ID,
      secretEncrypted: box.encrypt(vectors.nodeSecret, `node-secret:${SERVER_ID}`),
      publicKey: overrides.publicKey === undefined ? vectors.ed25519.publicKeyBase64 : overrides.publicKey,
      revokedAt: overrides.revoked ? new Date() : null,
    },
  };
  const used = new Set<string>();
  const prisma = {
    server: { findUnique: async ({ where }: { where: { nodeId: string } }) => (where.nodeId === NODE_ID ? server : null) },
    nodeCredential: {
      findUnique: async () => server.credential,
      update: async () => server.credential,
    },
  };
  const nonces = { claim: async (scope: string, nonce: string) => (used.has(scope + nonce) ? false : (used.add(scope + nonce), true)) };
  const service = new NodeAuthService(prisma as never, box, nonces as never);
  return { service, server, box };
}

export const nowSec = () => Math.floor(Date.now() / 1000);
export const newNonce = () => randomBytes(16).toString('hex');

export function signHttp(method: string, path: string, body: string, opts: { ts?: number; nonce?: string; secret?: string; withKey?: boolean } = {}) {
  const ts = opts.ts ?? nowSec();
  const nonce = opts.nonce ?? newNonce();
  const canonical = canonicalHttpRequest(method, path, ts, nonce, body);
  return {
    method,
    path,
    body,
    headers: {
      nodeId: NODE_ID,
      timestamp: String(ts),
      nonce,
      signature: hmacHex(opts.secret ?? vectors.nodeSecret, canonical),
      keySignature: opts.withKey === false ? undefined : edSignB64(canonical),
    },
  };
}

export function signWsAuth(opts: { ts?: number; nonce?: string } = {}) {
  const ts = opts.ts ?? nowSec();
  const nonce = opts.nonce ?? newNonce();
  const canonical = canonicalWsAuth(NODE_ID, ts, nonce);
  return { type: 'auth', nodeId: NODE_ID, ts, nonce, signature: hmacHex(vectors.nodeSecret, canonical), keySignature: edSignB64(canonical), agentVersion: '1.0.0' };
}
