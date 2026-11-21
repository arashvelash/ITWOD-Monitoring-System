import { createHash } from 'node:crypto';
import { Transform, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { ArchiveEncryptor } from '../crypto/archive-encryption';

export interface PipelineOptions {
  compressionLevel: number;
  encryptionKey?: Buffer;
  signal?: AbortSignal;
  /** Encryption chunk size (tests use small values). */
  chunkSize?: number;
}

export interface PipelineResult {
  sizeBytes: number;
  /** SHA-256 of the stored artifact (after compression and encryption). */
  sha256: string;
}

/** source → gzip → (encrypt) → meter → destination */
export async function runPipeline(input: Readable, output: Writable, opts: PipelineOptions): Promise<PipelineResult> {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      sizeBytes += chunk.length;
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  const level = Math.min(9, Math.max(1, Math.round(opts.compressionLevel || 6)));
  const stages: (Readable | Writable | Transform)[] = [input, createGzip({ level })];
  if (opts.encryptionKey) stages.push(new ArchiveEncryptor(opts.encryptionKey, opts.chunkSize));
  stages.push(meter, output);
  await (pipeline as (...args: unknown[]) => Promise<void>)(...stages, { signal: opts.signal });
  return { sizeBytes, sha256: hash.digest('hex') };
}
