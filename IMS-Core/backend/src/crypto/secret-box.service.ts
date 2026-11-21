import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { APP_CONFIG, AppConfig } from '../config/app-config';

const VERSION = 'v1';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Authenticated encryption for secrets stored in the database
 * (node secrets, DB passwords, S3 keys, Telegram / GitHub tokens, ...).
 *
 * Format: `v1.<iv>.<tag>.<ciphertext>` (base64url parts), AES-256-GCM.
 *
 * `context` is bound as additional authenticated data (AAD), so a ciphertext
 * copied from one row/column to another fails to decrypt. Always pass a
 * stable, row-specific context such as `node-secret:<serverId>`.
 */
@Injectable()
export class SecretBoxService {
  private readonly key: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = config.masterKey;
  }

  encrypt(plaintext: string, context: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv, { authTagLength: TAG_LENGTH });
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
  }

  decrypt(payload: string, context: string): string {
    const parts = payload.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new Error('Unsupported secret format');
    }
    const [, ivB64, tagB64, dataB64] = parts;
    const iv = Buffer.from(ivB64, 'base64url');
    const tag = Buffer.from(tagB64, 'base64url');
    if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
      throw new Error('Corrupted secret payload');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
  }

  encryptJson(value: unknown, context: string): string {
    return this.encrypt(JSON.stringify(value), context);
  }

  decryptJson<T>(payload: string, context: string): T {
    return JSON.parse(this.decrypt(payload, context)) as T;
  }

  /** Short, non-reversible fingerprint of the master key for display in the setup wizard. */
  keyFingerprint(): string {
    return createHash('sha256').update(this.key).digest('hex').slice(0, 16);
  }
}
