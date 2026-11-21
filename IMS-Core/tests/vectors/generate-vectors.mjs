#!/usr/bin/env node
/**
 * Generates the shared protocol test vectors (tests/vectors/protocol-v1.json).
 *
 * The vectors are deterministic (fixed keys, fixed IVs) and are consumed by the
 * test suites of IMS-Core, IMS-Agent and IMS-CPanel-Agent to guarantee that all
 * three implementations produce byte-identical signatures and ciphertexts.
 *
 * Usage: node tests/vectors/generate-vectors.mjs > tests/vectors/protocol-v1.json
 */
import crypto from 'node:crypto';

const bytes = (start, len) => Buffer.from(Array.from({ length: len }, (_, i) => (start + i) & 0xff));
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(data, 'utf8').digest('hex');

const nodeSecret = 'imss_' + bytes(0, 32).toString('base64url');
const seed = bytes(32, 32);
const privateKey = crypto.createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
  format: 'der',
  type: 'pkcs8',
});
const publicKeyRaw = Buffer.from(crypto.createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url');
const sign = (data) => crypto.sign(null, Buffer.from(data, 'utf8'), privateKey).toString('base64');

// HTTP request signing
const http = {
  method: 'POST',
  path: '/api/v1/agent/reports?batch=1',
  timestamp: 1767225600,
  nonce: '0123456789abcdef0123456789abcdef',
  body: '{"reports":[{"type":"heartbeat","data":{"uptimeSec":42}}]}',
};
http.bodySha256 = sha256(http.body);
http.canonical = ['IMS1-HMAC-SHA256', http.method, http.path, String(http.timestamp), http.nonce, http.bodySha256].join('\n');
http.signature = hmac(nodeSecret, http.canonical);
http.keySignature = sign(http.canonical);

const httpEmpty = { method: 'GET', path: '/api/v1/agent/config', timestamp: 1767225601, nonce: 'fedcba9876543210fedcba9876543210', body: '' };
httpEmpty.bodySha256 = sha256('');
httpEmpty.canonical = ['IMS1-HMAC-SHA256', httpEmpty.method, httpEmpty.path, String(httpEmpty.timestamp), httpEmpty.nonce, httpEmpty.bodySha256].join('\n');
httpEmpty.signature = hmac(nodeSecret, httpEmpty.canonical);
httpEmpty.keySignature = sign(httpEmpty.canonical);

// WebSocket auth
const wsAuth = { nodeId: 'ims-node-0001', ts: 1767225602, nonce: 'aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb' };
wsAuth.canonical = ['IMS1-WS-AUTH', wsAuth.nodeId, String(wsAuth.ts), wsAuth.nonce].join('\n');
wsAuth.signature = hmac(nodeSecret, wsAuth.canonical);
wsAuth.keySignature = sign(wsAuth.canonical);

// Command signing
const command = {
  id: '6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f',
  command: 'backup.run',
  issuedAt: 1767225603,
  expiresAt: 1767226503,
  payload: '{"jobId":"11111111-2222-4333-8444-555555555555","runId":"66666666-7777-4888-9999-000000000000"}',
};
command.payloadSha256 = sha256(command.payload);
command.canonical = ['IMS1-COMMAND', command.id, command.command, String(command.issuedAt), String(command.expiresAt), command.payloadSha256].join('\n');
command.signature = hmac(nodeSecret, command.canonical);

// Config secrets envelope (HKDF + AES-256-GCM)
const hkdfKey = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(nodeSecret, 'utf8'), Buffer.from('ims-v1'), Buffer.from('config-secrets'), 32));
const secretsPlain = '{"11111111-2222-4333-8444-555555555555":{"dbPassword":"s3cr3t-P@ss"}}';
const secretsIv = bytes(64, 12);
const c1 = crypto.createCipheriv('aes-256-gcm', hkdfKey, secretsIv);
const secretsData = Buffer.concat([c1.update(secretsPlain, 'utf8'), c1.final()]);
const configSecrets = {
  derivedKeyHex: hkdfKey.toString('hex'),
  plaintext: secretsPlain,
  envelope: { alg: 'A256GCM', iv: secretsIv.toString('base64'), tag: c1.getAuthTag().toString('base64'), data: secretsData.toString('base64') },
};

// Archive encryption format (chunked AES-256-GCM, see docs/PROTOCOL.md §9)
const archiveKey = bytes(96, 32);
const noncePrefix = bytes(128, 8);
const chunkSize = 48;
const archivePlain = Buffer.from('IMS backup archive test payload\n'.repeat(4), 'utf8'); // 128 bytes -> 48 + 48 + 32
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const header = Buffer.concat([Buffer.from('IMSENC1', 'ascii'), Buffer.from([1]), u32(chunkSize), noncePrefix]);
const records = [];
for (let offset = 0, counter = 0; offset < archivePlain.length || counter === 0; offset += chunkSize, counter++) {
  const chunk = archivePlain.subarray(offset, offset + chunkSize);
  const final = offset + chunkSize >= archivePlain.length;
  const c = crypto.createCipheriv('aes-256-gcm', archiveKey, Buffer.concat([noncePrefix, u32(counter)]));
  c.setAAD(Buffer.concat([header, u32(counter), Buffer.from([final ? 1 : 0])]));
  records.push(u32(chunk.length), c.update(chunk), c.final(), c.getAuthTag());
  if (final) break;
}
const archive = {
  keyBase64: archiveKey.toString('base64'),
  noncePrefixHex: noncePrefix.toString('hex'),
  chunkSize,
  plaintextHex: archivePlain.toString('hex'),
  outputHex: Buffer.concat([header, ...records]).toString('hex'),
};

const vectors = {
  version: 1,
  description: 'IMS protocol v1 shared test vectors. Regenerate with tests/vectors/generate-vectors.mjs',
  nodeSecret,
  ed25519: {
    seedHex: seed.toString('hex'),
    publicKeyBase64: publicKeyRaw.toString('base64'),
    fingerprint: 'SHA256:' + sha256(publicKeyRaw),
  },
  http: [http, httpEmpty],
  wsAuth,
  command,
  configSecrets,
  archive,
};

process.stdout.write(JSON.stringify(vectors, null, 2) + '\n');
