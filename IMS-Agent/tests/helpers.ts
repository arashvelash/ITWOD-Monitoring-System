import { afterAll } from 'vitest';
import { createPrivateKey, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { agentPaths } from '../src/paths';

export const vectors = JSON.parse(readFileSync(resolve(__dirname, 'vectors/protocol-v1.json'), 'utf8'));

export function vectorKey(): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(vectors.ed25519.seedHex, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** One ustar entry (header + padded data) for package fixtures. */
export function tarEntry(name: string, content: string | Buffer = '', type = '0', mode = 0o644): Buffer {
  const data = Buffer.from(content);
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100, 'ascii');
  h.write('0000000\0', 108, 'ascii');
  h.write('0000000\0', 116, 'ascii');
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  h.write('00000000000\0', 136, 'ascii');
  h.fill(' ', 148, 156);
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

export function tgz(entries: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

/** A minimal but structurally complete agent release package. */
export function agentPackage(version: string, extra: Buffer[] = []): Buffer {
  return tgz([
    tarEntry('./', '', '5', 0o755),
    tarEntry('./manifest.json', JSON.stringify({ name: 'ims-agent', version, entry: 'dist/ims-agent.js' })),
    tarEntry('./dist/', '', '5', 0o755),
    tarEntry('./dist/ims-agent.js', `exports.main = async () => { process.stdout.write('ok ${version}\\n'); };\n`, '0', 0o755),
    tarEntry('./dist/launcher.js', '// launcher\n', '0', 0o755),
    tarEntry('./installer/install.sh', '#!/bin/sh\n', '0', 0o755),
    ...extra,
  ]);
}

/** Isolated agent directory layout under the OS temp dir. */
const tempRoots: string[] = [];
// Test files are isolated, so this hook runs once per file that uses tempPaths().
afterAll(() => {
  for (const d of tempRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

export function tempPaths() {
  const root = mkdtempSync(join(tmpdir(), 'ims-agent-test-'));
  tempRoots.push(root);
  return {
    root,
    paths: agentPaths({
      IMS_AGENT_CONFIG_DIR: join(root, 'etc'),
      IMS_AGENT_STATE_DIR: join(root, 'state'),
      IMS_AGENT_INSTALL_DIR: join(root, 'opt'),
      IMS_AGENT_BACKUP_DIR: join(root, 'backups'),
    }),
  };
}
