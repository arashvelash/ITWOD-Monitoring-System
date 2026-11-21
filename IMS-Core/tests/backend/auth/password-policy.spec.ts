import { checkPasswordPolicy, usernameSchema } from '../../../backend/src/auth/password-policy';
import { PasswordService } from '../../../backend/src/auth/password.service';

describe('password policy', () => {
  it('accepts a long passphrase', () => {
    expect(checkPasswordPolicy('correct horse battery staple', 'admin').ok).toBe(true);
  });

  it('rejects short, common, repeated and username-containing passwords', () => {
    expect(checkPasswordPolicy('short', 'x').ok).toBe(false);
    expect(checkPasswordPolicy('password1234').ok).toBe(false);
    expect(checkPasswordPolicy('zzzzzzzzzzzzzz').ok).toBe(false);
    expect(checkPasswordPolicy('my-arash-password-2026', 'arash').ok).toBe(false);
  });

  it('normalises usernames', () => {
    expect(usernameSchema.parse('  Admin.User ')).toBe('admin.user');
    expect(usernameSchema.safeParse('a').success).toBe(false);
    expect(usernameSchema.safeParse('bad name').success).toBe(false);
  });
});

describe('PasswordService (argon2id)', () => {
  const svc = new PasswordService();

  it('hashes with argon2id and verifies', async () => {
    const hash = await svc.hash('a long enough passphrase');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(svc.verify(hash, 'a long enough passphrase')).resolves.toBe(true);
    await expect(svc.verify(hash, 'wrong passphrase!!')).resolves.toBe(false);
    expect(svc.needsRehash(hash)).toBe(false);
  });

  it('never throws on malformed hashes', async () => {
    await expect(svc.verify('not-a-hash', 'x')).resolves.toBe(false);
  });
});
