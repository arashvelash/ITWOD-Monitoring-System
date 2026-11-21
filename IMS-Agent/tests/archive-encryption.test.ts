import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ArchiveDecryptor, ArchiveEncryptor, parseKey } from '../modules/crypto/archive-encryption';
import { vectors } from './helpers';

async function run(transform: NodeJS.ReadWriteStream, input: Buffer, pieces = 7): Promise<Buffer> {
  const parts: Buffer[] = [];
  const chunks: Buffer[] = [];
  for (let i = 0; i < input.length; i += pieces) chunks.push(input.subarray(i, i + pieces));
  await pipeline(Readable.from(chunks), transform, async function* (source) {
    for await (const c of source) parts.push(c as Buffer);
  });
  return Buffer.concat(parts);
}

describe('IMSENC1 chunked archive encryption', () => {
  const a = vectors.archive;
  const key = parseKey(a.keyBase64);
  const plain = Buffer.from(a.plaintextHex, 'hex');

  it('produces byte-identical output to the shared vector (any input chunking)', async () => {
    for (const pieces of [1, 5, 48, 1000]) {
      const out = await run(new ArchiveEncryptor(key, a.chunkSize, Buffer.from(a.noncePrefixHex, 'hex')), plain, pieces);
      expect(out.toString('hex')).toBe(a.outputHex);
    }
  });

  it('decrypts the vector and round-trips random data', async () => {
    expect(await run(new ArchiveDecryptor(key), Buffer.from(a.outputHex, 'hex'), 13)).toEqual(plain);
    for (const size of [0, 1, 48, 96, 1000]) {
      const data = randomBytes(size);
      const enc = await run(new ArchiveEncryptor(key, 48), data, 11);
      expect(await run(new ArchiveDecryptor(key), enc, 17)).toEqual(data);
    }
  });

  it('detects tampering, truncation, trailing data and wrong keys', async () => {
    const enc = Buffer.from(a.outputHex, 'hex');
    const flipped = Buffer.from(enc);
    flipped[40] ^= 1;
    await expect(run(new ArchiveDecryptor(key), flipped)).rejects.toThrow(/Authentication failed/);
    // Drop the final record: must not be accepted as a complete archive.
    const firstTwo = enc.subarray(0, 20 + 2 * (4 + 48 + 16));
    await expect(run(new ArchiveDecryptor(key), firstTwo)).rejects.toThrow(/truncated/);
    await expect(run(new ArchiveDecryptor(key), Buffer.concat([enc, Buffer.from([0, 0, 0, 0])]))).rejects.toThrow();
    await expect(run(new ArchiveDecryptor(randomBytes(32)), enc)).rejects.toThrow(/Authentication failed/);
    await expect(run(new ArchiveDecryptor(key), Buffer.from('not an archive at all, definitely'))).rejects.toThrow(/Not an IMS/);
  });

  it('validates keys', () => {
    expect(() => parseKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
