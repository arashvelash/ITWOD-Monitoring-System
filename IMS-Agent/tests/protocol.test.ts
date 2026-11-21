import { describe, expect, it } from 'vitest';
import { createPublicKey, verify } from 'node:crypto';
import { canonicalCommand, canonicalHttp, canonicalWsAuth, deriveConfigSecretsKey, hmacHex, openConfigSecrets, signEd25519, verifyCommand } from '../src/protocol';
import { fingerprint, publicKeyOf } from '../src/identity';
import { normalizeCoreUrl, toWsUrl } from '../src/core-url';
import { vectorKey, vectors } from './helpers';

describe('protocol v1 shared vectors', () => {
  const secret: string = vectors.nodeSecret;
  const key = vectorKey();

  it('derives the same public key and fingerprint', () => {
    expect(publicKeyOf(key)).toBe(vectors.ed25519.publicKeyBase64);
    expect(fingerprint(vectors.ed25519.publicKeyBase64)).toBe(vectors.ed25519.fingerprint);
  });

  it.each(vectors.http as any[])('signs $method requests byte-identically', (v: any) => {
    const canonical = canonicalHttp(v.method, v.path, v.timestamp, v.nonce, v.body);
    expect(canonical).toBe(v.canonical);
    expect(hmacHex(secret, canonical)).toBe(v.signature);
    expect(signEd25519(key, canonical)).toBe(v.keySignature);
  });

  it('signs the WebSocket auth frame', () => {
    const w = vectors.wsAuth;
    const canonical = canonicalWsAuth(w.nodeId, w.ts, w.nonce);
    expect(canonical).toBe(w.canonical);
    expect(hmacHex(secret, canonical)).toBe(w.signature);
    expect(verify(null, Buffer.from(canonical), createPublicKey(key), Buffer.from(w.keySignature, 'base64'))).toBe(true);
  });

  it('verifies a genuine command and rejects tampering', () => {
    const c = vectors.command;
    expect(canonicalCommand(c.id, c.command, c.issuedAt, c.expiresAt, c.payload)).toBe(c.canonical);
    const cmd = { type: 'command' as const, id: c.id, command: c.command, issuedAt: c.issuedAt, expiresAt: c.expiresAt, payload: c.payload, signature: c.signature };
    const now = c.issuedAt + 10;
    const ok = verifyCommand(secret, cmd, now);
    expect(ok).toMatchObject({ ok: true, type: 'backup.run' });
    expect(verifyCommand(secret, { ...cmd, payload: c.payload.replace('1111', '2222') }, now)).toEqual({ ok: false, reason: 'invalid signature' });
    expect(verifyCommand('imss_other', cmd, now)).toEqual({ ok: false, reason: 'invalid signature' });
    expect(verifyCommand(secret, cmd, c.expiresAt + 1)).toEqual({ ok: false, reason: 'command expired' });
  });

  it('refuses commands outside the allow-list even when signed', () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const bad = { id: 'x', command: 'shell.exec', issuedAt, expiresAt: issuedAt + 60, payload: '{"cmd":"rm -rf /"}' };
    const signature = hmacHex(vectors.nodeSecret, canonicalCommand(bad.id, bad.command, bad.issuedAt, bad.expiresAt, bad.payload));
    const res = verifyCommand(vectors.nodeSecret, { type: 'command', ...bad, signature });
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toMatch(/not allowed/);
  });

  it('opens the config secrets envelope', () => {
    const cs = vectors.configSecrets;
    expect(deriveConfigSecretsKey(secret).toString('hex')).toBe(cs.derivedKeyHex);
    expect(openConfigSecrets(secret, cs.envelope)).toEqual(JSON.parse(cs.plaintext));
    expect(() => openConfigSecrets('imss_wrong', cs.envelope)).toThrow();
  });
});

describe('Core URL handling', () => {
  it('requires https and strips trailing slashes', () => {
    expect(normalizeCoreUrl('https://itwodms.ir/')).toBe('https://itwodms.ir');
    expect(() => normalizeCoreUrl('http://itwodms.ir', false)).toThrow(/https/);
    expect(() => normalizeCoreUrl('https://user:pw@itwodms.ir')).toThrow();
    expect(normalizeCoreUrl('http://localhost:3000', true)).toBe('http://localhost:3000');
    expect(toWsUrl('https://itwodms.ir', '/ws/agent')).toBe('wss://itwodms.ir/ws/agent');
  });
});
