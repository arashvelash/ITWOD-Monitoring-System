import { createDecipheriv } from 'node:crypto';
import {
  canonicalCommand,
  canonicalHttpRequest,
  canonicalWsAuth,
  deriveConfigSecretsKey,
  ed25519Fingerprint,
  hmacHex,
  isTimestampFresh,
  sealConfigSecrets,
  signCommand,
  verifyEd25519,
  verifyHmacHex,
} from '../../../backend/src/crypto/node-protocol';
import { vectors } from '../helpers/vectors';

describe('protocol v1 vectors', () => {
  const secret: string = vectors.nodeSecret;

  it.each(vectors.http as any[])('signs HTTP $method requests identically', (v: any) => {
    const canonical = canonicalHttpRequest(v.method, v.path, v.timestamp, v.nonce, v.body);
    expect(canonical).toBe(v.canonical);
    expect(hmacHex(secret, canonical)).toBe(v.signature);
    expect(verifyHmacHex(secret, canonical, v.signature)).toBe(true);
    expect(verifyEd25519(vectors.ed25519.publicKeyBase64, canonical, v.keySignature)).toBe(true);
  });

  it('builds the WebSocket auth canonical string', () => {
    const w = vectors.wsAuth;
    const canonical = canonicalWsAuth(w.nodeId, w.ts, w.nonce);
    expect(canonical).toBe(w.canonical);
    expect(hmacHex(secret, canonical)).toBe(w.signature);
    expect(verifyEd25519(vectors.ed25519.publicKeyBase64, canonical, w.keySignature)).toBe(true);
  });

  it('signs commands identically', () => {
    const c = vectors.command;
    expect(canonicalCommand(c.id, c.command, c.issuedAt, c.expiresAt, c.payload)).toBe(c.canonical);
    const signed = signCommand(secret, { id: c.id, command: c.command, issuedAt: c.issuedAt, expiresAt: c.expiresAt, payload: c.payload });
    expect(signed.signature).toBe(c.signature);
  });

  it('derives the config secrets key and seals deterministically with a fixed IV', () => {
    const cs = vectors.configSecrets;
    expect(deriveConfigSecretsKey(secret).toString('hex')).toBe(cs.derivedKeyHex);
    const sealed = sealConfigSecrets(secret, cs.plaintext, Buffer.from(cs.envelope.iv, 'base64'));
    expect(sealed).toEqual(cs.envelope);
    const d = createDecipheriv('aes-256-gcm', deriveConfigSecretsKey(secret), Buffer.from(sealed.iv, 'base64'));
    d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    expect(Buffer.concat([d.update(Buffer.from(sealed.data, 'base64')), d.final()]).toString('utf8')).toBe(cs.plaintext);
  });

  it('computes the key fingerprint', () => {
    expect(ed25519Fingerprint(vectors.ed25519.publicKeyBase64)).toBe(vectors.ed25519.fingerprint);
  });
});

describe('protocol verification edge cases', () => {
  const v = vectors.http[0];

  it('rejects modified messages and malformed signatures', () => {
    expect(verifyHmacHex(vectors.nodeSecret, v.canonical + 'x', v.signature)).toBe(false);
    expect(verifyHmacHex(vectors.nodeSecret, v.canonical, 'zz')).toBe(false);
    expect(verifyHmacHex('imss_wrong', v.canonical, v.signature)).toBe(false);
    expect(verifyEd25519(vectors.ed25519.publicKeyBase64, v.canonical + 'x', v.keySignature)).toBe(false);
    expect(verifyEd25519('not-a-key', v.canonical, v.keySignature)).toBe(false);
    expect(verifyEd25519(vectors.ed25519.publicKeyBase64, v.canonical, 'AAAA')).toBe(false);
  });

  it('enforces the clock skew window', () => {
    const now = 1_767_225_600;
    expect(isTimestampFresh(now, now)).toBe(true);
    expect(isTimestampFresh(now - 299, now)).toBe(true);
    expect(isTimestampFresh(now - 301, now)).toBe(false);
    expect(isTimestampFresh(now + 301, now)).toBe(false);
    expect(isTimestampFresh(1.5, now)).toBe(false);
  });
});
