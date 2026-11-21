import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { createGunzip } from 'node:zlib';

export interface ExtractLimits {
  maxEntries?: number;
  maxTotalBytes?: number;
}

function cString(buf: Buffer): string {
  const nul = buf.indexOf(0);
  return buf.subarray(0, nul < 0 ? buf.length : nul).toString('utf8');
}

function octal(buf: Buffer): number {
  const s = cString(buf).trim();
  const n = s ? parseInt(s, 8) : 0;
  if (!Number.isFinite(n) || n < 0) throw new Error('Corrupt tar header');
  return n;
}

/**
 * Minimal, strict .tar.gz extractor for release packages. Only regular files
 * and directories are accepted: links, devices, absolute paths and ".."
 * segments abort the extraction. setuid/setgid bits are never applied.
 */
export function extractTarGz(file: string, destDir: string, limits: ExtractLimits = {}): Promise<string[]> {
  const maxEntries = limits.maxEntries ?? 2_000;
  const maxTotal = limits.maxTotalBytes ?? 200 * 1024 * 1024;
  const root = resolve(destDir);

  return new Promise((resolvePromise, reject) => {
    const written: string[] = [];
    let buf: Buffer = Buffer.alloc(0);
    let total = 0;
    let longName: string | null = null;
    let body: { remaining: number; pad: number; out: WriteStream | null; capture: Buffer[] | null } | null = null;
    let padLeft = 0;
    let settled = false;
    const input = createReadStream(file);
    const gunzip = createGunzip();
    let chain: Promise<void> = Promise.resolve();

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      body?.out?.destroy();
      input.destroy();
      gunzip.destroy();
      reject(err);
    };

    const safePath = (name: string): string => {
      const clean = name.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
      if (!clean) return '';
      if (clean.startsWith('/') || clean.split('/').some((p) => p === '..' || p === '')) throw new Error(`Unsafe path in package: ${name}`);
      const full = resolve(root, ...clean.split('/'));
      if (full !== root && !full.startsWith(root + sep)) throw new Error(`Unsafe path in package: ${name}`);
      return full;
    };

    const header = async (h: Buffer) => {
      if (h.every((b) => b === 0)) return;
      const type = String.fromCharCode(h[156] ?? 0);
      const size = octal(h.subarray(124, 136));
      const mode = octal(h.subarray(100, 108)) & 0o755;
      const ustar = h.subarray(257, 262).toString('ascii') === 'ustar';
      const prefix = ustar ? cString(h.subarray(345, 500)) : '';
      const name = longName ?? (prefix ? `${prefix}/${cString(h.subarray(0, 100))}` : cString(h.subarray(0, 100)));
      longName = null;
      const pad = (512 - (size % 512)) % 512;

      if (type === 'L') {
        if (size > 4096) throw new Error('Invalid long name');
        body = { remaining: size, pad, out: null, capture: [] };
        return;
      }
      if (type === 'x' || type === 'g') {
        body = { remaining: size, pad, out: null, capture: null };
        return;
      }
      if (type !== '0' && type !== '\0' && type !== '5') throw new Error(`Unsupported entry type "${type}" for ${name}`);
      if (written.length >= maxEntries) throw new Error('Package has too many entries');
      const target = safePath(name);
      if (type === '5') {
        if (target) await mkdir(target, { recursive: true, mode: 0o755 });
        return;
      }
      if (!target) throw new Error('File entry without a name');
      total += size;
      if (total > maxTotal) throw new Error('Package exceeds the extraction size limit');
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      const out = createWriteStream(target, { mode: mode || 0o644 });
      written.push(target);
      if (size === 0) {
        await new Promise<void>((r, j) => out.end((err?: Error | null) => (err ? j(err) : r())));
        return;
      }
      body = { remaining: size, pad, out, capture: null };
    };

    const pump = async () => {
      for (;;) {
        if (settled) return;
        if (padLeft > 0) {
          const take = Math.min(padLeft, buf.length);
          if (!take) return;
          buf = buf.subarray(take);
          padLeft -= take;
          continue;
        }
        if (body) {
          const take = Math.min(body.remaining, buf.length);
          if (!take && body.remaining > 0) return;
          const part = buf.subarray(0, take);
          buf = buf.subarray(take);
          body.remaining -= take;
          if (body.capture) body.capture.push(part);
          if (body.out && take && !body.out.write(part)) await new Promise<void>((r) => body!.out!.once('drain', () => r()));
          if (body.remaining > 0) return;
          const done = body;
          body = null;
          padLeft = done.pad;
          if (done.capture) longName = cString(Buffer.concat(done.capture));
          if (done.out) await new Promise<void>((r, j) => done.out!.end((err?: Error | null) => (err ? j(err) : r())));
          continue;
        }
        if (buf.length < 512) return;
        const h = buf.subarray(0, 512);
        buf = buf.subarray(512);
        await header(h);
      }
    };

    gunzip.on('data', (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      gunzip.pause();
      chain = chain
        .then(pump)
        .then(() => {
          if (!settled) gunzip.resume();
        })
        .catch((err: Error) => fail(err));
    });
    gunzip.on('end', () => {
      chain
        .then(pump)
        .then(() => {
          if (settled) return;
          if (body) throw new Error('Truncated package');
          settled = true;
          resolvePromise(written.map((p) => p.slice(root.length + 1).split(sep).join('/')));
        })
        .catch((err: Error) => fail(err));
    });
    gunzip.on('error', (e) => fail(new Error(`Not a valid gzip archive: ${e.message}`)));
    input.on('error', (e) => fail(e));
    input.pipe(gunzip);
  });
}
