import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { z } from 'zod';
import { isValidVersion } from './versions';

/** manifest.json at the root of every agent package (written by IMS-Agent/scripts/build.mjs). */
export const manifestSchema = z.object({
  name: z.literal('ims-agent'),
  version: z.string().refine(isValidVersion, 'invalid version'),
  entry: z.string().max(128),
  node: z.string().max(32).optional(),
  builtAt: z.string().max(40).optional(),
  bundleSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

export type AgentManifest = z.infer<typeof manifestSchema>;

export interface PackageInspection {
  manifest: AgentManifest;
  entries: string[];
}

const REQUIRED_ENTRIES = ['installer/install.sh'];
const MAX_ENTRIES = 5_000;
const MAX_CAPTURE_BYTES = 64 * 1024;

type State =
  | { kind: 'header' }
  | { kind: 'body'; remaining: number; pad: number; sink: Buffer[] | null; done: (data: Buffer | null) => void }
  | { kind: 'pad'; remaining: number };

function cleanName(name: string): string {
  return name.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
}

function cString(buf: Buffer): string {
  const nul = buf.indexOf(0);
  return buf.subarray(0, nul < 0 ? buf.length : nul).toString('utf8');
}

function parseOctal(buf: Buffer): number {
  const s = cString(buf).trim();
  const n = s ? parseInt(s, 8) : 0;
  if (!Number.isFinite(n) || n < 0) throw new Error('Corrupt tar header');
  return n;
}

/**
 * Streams a .tgz once and returns its manifest and entry names without
 * extracting anything to disk. Absolute paths and ".." segments are refused,
 * so a malicious package is rejected before any agent ever downloads it.
 */
export function inspectPackage(file: string): Promise<PackageInspection> {
  return new Promise((resolve, reject) => {
    const entries = new Set<string>();
    let manifestRaw: Buffer | null = null;
    let longName: string | null = null;
    let state: State = { kind: 'header' };
    let buf: Buffer = Buffer.alloc(0);
    let settled = false;

    const input = createReadStream(file);
    const gunzip = createGunzip();

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      input.destroy();
      gunzip.destroy();
      reject(err);
    };

    const startBody = (size: number, capture: boolean, done: (data: Buffer | null) => void) => {
      if (capture && size > MAX_CAPTURE_BYTES) throw new Error('Metadata entry too large');
      if (size === 0) {
        done(capture ? Buffer.alloc(0) : null);
        state = { kind: 'header' };
        return;
      }
      state = { kind: 'body', remaining: size, pad: (512 - (size % 512)) % 512, sink: capture ? [] : null, done };
    };

    const onHeader = (h: Buffer) => {
      if (h.every((b) => b === 0)) return; // end-of-archive padding
      const type = String.fromCharCode(h[156] ?? 0);
      const size = parseOctal(h.subarray(124, 136));
      const ustar = h.subarray(257, 262).toString('ascii') === 'ustar';
      const prefix = ustar ? cString(h.subarray(345, 500)) : '';
      const base = cString(h.subarray(0, 100));
      const name = cleanName(longName ?? (prefix ? `${prefix}/${base}` : base));
      longName = null;

      if (type === 'L') {
        startBody(size, true, (d) => (longName = d ? cString(d) : null));
        return;
      }
      if (type === 'x' || type === 'g' || type === 'K') {
        startBody(size, false, () => undefined);
        return;
      }
      if (name.startsWith('/') || name.split('/').includes('..')) throw new Error(`Unsafe path in package: ${name}`);
      if (type === '1' || type === '2') {
        const target = cString(h.subarray(157, 257));
        if (target.startsWith('/') || target.split('/').includes('..')) throw new Error(`Unsafe link in package: ${name}`);
      }
      if (name) entries.add(name);
      if (entries.size > MAX_ENTRIES) throw new Error('Package has too many entries');
      const isManifest = (type === '0' || type === '\0') && name === 'manifest.json';
      startBody(size, isManifest, (d) => {
        if (isManifest) manifestRaw = d;
      });
    };

    gunzip.on('data', (chunk: Buffer) => {
      if (settled) return;
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      try {
        for (;;) {
          if (state.kind === 'header') {
            if (buf.length < 512) break;
            const header = buf.subarray(0, 512);
            buf = buf.subarray(512);
            onHeader(header);
          } else if (state.kind === 'body') {
            const take = Math.min(state.remaining, buf.length);
            if (take === 0) break;
            state.sink?.push(buf.subarray(0, take));
            buf = buf.subarray(take);
            state.remaining -= take;
            if (state.remaining > 0) break;
            const { sink, pad, done } = state;
            done(sink ? Buffer.concat(sink) : null);
            state = pad > 0 ? { kind: 'pad', remaining: pad } : { kind: 'header' };
          } else {
            const take = Math.min(state.remaining, buf.length);
            if (take === 0) break;
            buf = buf.subarray(take);
            state.remaining -= take;
            if (state.remaining > 0) break;
            state = { kind: 'header' };
          }
        }
      } catch (err) {
        fail(err as Error);
      }
    });

    gunzip.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        if (!manifestRaw) throw new Error('Package has no manifest.json');
        const manifest = manifestSchema.parse(JSON.parse((manifestRaw as Buffer).toString('utf8')));
        for (const required of [...REQUIRED_ENTRIES, cleanName(manifest.entry)]) {
          if (!entries.has(required)) throw new Error(`Package is missing ${required}`);
        }
        resolve({ manifest, entries: [...entries] });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    gunzip.on('error', (e) => fail(new Error(`Not a valid gzip archive: ${e.message}`)));
    input.on('error', (e) => fail(e));
    input.pipe(gunzip);
  });
}
