import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Argon2id password hashing (OWASP baseline: m=19 MiB, t=2, p=1).
 * Parameters are embedded in the hash, so they can be raised later and old
 * hashes are transparently upgraded on the next successful login.
 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordService {
  private dummyHash?: Promise<string>;

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, ARGON2_OPTIONS);
    } catch {
      return true;
    }
  }

  /**
   * Performs a verification against a throw-away hash so that requests for
   * unknown usernames take the same time as requests for existing ones.
   */
  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= argon2.hash('ims-dummy-password-for-timing', ARGON2_OPTIONS);
    await this.verify(await this.dummyHash, password);
  }
}
