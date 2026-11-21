import { SecretBoxService } from '../../../backend/src/crypto/secret-box.service';
import { generateHumanCode, generateToken, safeEqual, sha256Hex, TOKEN_PREFIX } from '../../../backend/src/crypto/tokens';
import { testConfig } from '../helpers/test-config';

describe('SecretBoxService', () => {
  const box = new SecretBoxService(testConfig());

  it('round-trips plaintext with the same context', () => {
    const ct = box.encrypt('db-password-!@#', 'job:1:source');
    expect(ct.startsWith('v1.')).toBe(true);
    expect(ct).not.toContain('db-password');
    expect(box.decrypt(ct, 'job:1:source')).toBe('db-password-!@#');
  });

  it('produces a different ciphertext for every encryption (random IV)', () => {
    expect(box.encrypt('same', 'ctx')).not.toBe(box.encrypt('same', 'ctx'));
  });

  it('rejects a ciphertext moved to another context (AAD binding)', () => {
    const ct = box.encrypt('secret', 'node-secret:A');
    expect(() => box.decrypt(ct, 'node-secret:B')).toThrow();
  });

  it('rejects tampered ciphertext', () => {
    const ct = box.encrypt('secret', 'ctx');
    const parts = ct.split('.');
    const data = Buffer.from(parts[3], 'base64url');
    data[0] ^= 0xff;
    parts[3] = data.toString('base64url');
    expect(() => box.decrypt(parts.join('.'), 'ctx')).toThrow();
  });

  it('rejects ciphertext produced with a different master key', () => {
    const other = new SecretBoxService(testConfig());
    expect(() => other.decrypt(box.encrypt('secret', 'ctx'), 'ctx')).toThrow();
  });

  it('rejects unknown formats', () => {
    expect(() => box.decrypt('v2.a.b.c', 'ctx')).toThrow('Unsupported secret format');
    expect(() => box.decrypt('garbage', 'ctx')).toThrow();
  });

  it('round-trips JSON', () => {
    const ct = box.encryptJson({ a: 1, b: 'x' }, 'ctx');
    expect(box.decryptJson(ct, 'ctx')).toEqual({ a: 1, b: 'x' });
  });
});

describe('token helpers', () => {
  it('generates prefixed high-entropy tokens', () => {
    const t = generateToken(TOKEN_PREFIX.registration, 24);
    expect(t).toMatch(/^imsr_[A-Za-z0-9_-]{32}$/);
    expect(generateToken(TOKEN_PREFIX.registration, 24)).not.toBe(t);
  });

  it('compares strings safely', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('hashes with sha256', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('generates unambiguous human codes', () => {
    expect(generateHumanCode()).toMatch(/^IMS-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });
});
