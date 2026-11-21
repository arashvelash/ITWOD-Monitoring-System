/**
 * IMSENC1 archive encryption (docs/PROTOCOL.md §9): chunked AES-256-GCM.
 *
 *   header = "IMSENC1" | 0x01 | chunkSize u32be | noncePrefix(8)
 *   record = length u32be | ciphertext | tag(16)
 *   nonce  = noncePrefix || counter u32be
 *   AAD    = header || counter u32be || final flag
 *
 * Every chunk is authenticated before any plaintext is released, and the final
 * flag detects truncation.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('IMSENC1', 'ascii');
const VERSION = 1;
const HEADER_LEN = 20;
const TAG_LEN = 16;
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;
const MAX_CHUNK_SIZE = 16 * 1024 * 1024;

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

export function parseKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64.trim(), 'base64');
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes (base64)');
  return key;
}

export class ArchiveEncryptor extends Transform {
  private readonly header: Buffer;
  private pending: Buffer[] = [];
  private pendingLen = 0;
  private counter = 0;
  private headerSent = false;

  constructor(
    private readonly key: Buffer,
    private readonly chunkSize = DEFAULT_CHUNK_SIZE,
    private readonly noncePrefix: Buffer = randomBytes(8),
  ) {
    super();
    if (key.length !== 32) throw new Error('Key must be 32 bytes');
    if (noncePrefix.length !== 8) throw new Error('Nonce prefix must be 8 bytes');
    if (chunkSize < 1 || chunkSize > MAX_CHUNK_SIZE) throw new Error('Invalid chunk size');
    this.header = Buffer.concat([MAGIC, Buffer.from([VERSION]), u32(chunkSize), noncePrefix]);
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    try {
      this.sendHeader();
      this.pending.push(chunk);
      this.pendingLen += chunk.length;
      // Keep at least one chunk buffered: only the last slice may carry the final flag.
      while (this.pendingLen > this.chunkSize) {
        const all = Buffer.concat(this.pending);
        this.pushRecord(all.subarray(0, this.chunkSize), false);
        const rest = all.subarray(this.chunkSize);
        this.pending = [rest];
        this.pendingLen = rest.length;
      }
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  override _flush(cb: TransformCallback): void {
    try {
      this.sendHeader();
      this.pushRecord(Buffer.concat(this.pending), true);
      this.pending = [];
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  private sendHeader(): void {
    if (!this.headerSent) {
      this.push(this.header);
      this.headerSent = true;
    }
  }

  private pushRecord(plain: Buffer, final: boolean): void {
    if (this.counter > 0xffffffff) throw new Error('Archive too large');
    const cipher = createCipheriv('aes-256-gcm', this.key, Buffer.concat([this.noncePrefix, u32(this.counter)]));
    cipher.setAAD(Buffer.concat([this.header, u32(this.counter), Buffer.from([final ? 1 : 0])]));
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    this.push(Buffer.concat([u32(plain.length), ct, cipher.getAuthTag()]));
    this.counter++;
  }
}

export class ArchiveDecryptor extends Transform {
  private buffer: Buffer = Buffer.alloc(0);
  private header?: Buffer;
  private chunkSize = 0;
  private noncePrefix = Buffer.alloc(0);
  private counter = 0;
  private finished = false;

  constructor(private readonly key: Buffer) {
    super();
    if (key.length !== 32) throw new Error('Key must be 32 bytes');
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    try {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      this.drain();
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  override _flush(cb: TransformCallback): void {
    try {
      this.drain();
      if (!this.header) throw new Error('Not an IMS encrypted archive (missing header)');
      if (!this.finished || this.buffer.length) throw new Error('Encrypted archive is truncated or has trailing data');
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  private drain(): void {
    if (!this.header) {
      if (this.buffer.length < HEADER_LEN) return;
      const header = this.buffer.subarray(0, HEADER_LEN);
      if (!header.subarray(0, 7).equals(MAGIC) || header[7] !== VERSION) throw new Error('Not an IMS encrypted archive');
      this.chunkSize = header.readUInt32BE(8);
      if (this.chunkSize < 1 || this.chunkSize > MAX_CHUNK_SIZE) throw new Error('Invalid chunk size in header');
      this.noncePrefix = Buffer.from(header.subarray(12, 20));
      this.header = Buffer.from(header);
      this.buffer = this.buffer.subarray(HEADER_LEN);
    }
    for (;;) {
      if (this.buffer.length < 4) return;
      const len = this.buffer.readUInt32BE(0);
      if (len > this.chunkSize) throw new Error('Record larger than chunk size');
      if (this.finished) throw new Error('Data after the final record');
      if (this.buffer.length < 4 + len + TAG_LEN) return;
      const ct = this.buffer.subarray(4, 4 + len);
      const tag = this.buffer.subarray(4 + len, 4 + len + TAG_LEN);
      const plain = this.open(ct, tag, false) ?? this.open(ct, tag, true);
      if (!plain) throw new Error('Authentication failed: wrong key or corrupted archive');
      this.push(plain.data);
      if (plain.final) this.finished = true;
      this.counter++;
      this.buffer = this.buffer.subarray(4 + len + TAG_LEN);
    }
  }

  private open(ct: Buffer, tag: Buffer, final: boolean): { data: Buffer; final: boolean } | null {
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, Buffer.concat([this.noncePrefix, u32(this.counter)]));
      d.setAAD(Buffer.concat([this.header!, u32(this.counter), Buffer.from([final ? 1 : 0])]));
      d.setAuthTag(tag);
      return { data: Buffer.concat([d.update(ct), d.final()]), final };
    } catch {
      return null;
    }
  }
}

/** Decrypts an archive file (used by `ims-agent decrypt`). Output is written atomically. */
export async function decryptArchiveFile(input: string, output: string, keyBase64: string): Promise<void> {
  const tmp = `${output}.partial`;
  try {
    await pipeline(createReadStream(input), new ArchiveDecryptor(parseKey(keyBase64)), createWriteStream(tmp, { mode: 0o600 }));
    await rename(tmp, output);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
