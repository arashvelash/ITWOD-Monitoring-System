#!/usr/bin/env node
// ---------------------------------------------------------------------------
// IMS-Agent build & packaging
//
//   node scripts/build.mjs                 bundle dist/ims-agent.js + dist/launcher.js
//   node scripts/build.mjs --package       + release/ims-agent-<version>.tgz (+ .sha256)
//   node scripts/build.mjs --keygen <dir>  create an Ed25519 release signing key pair
//
// Signing: set IMS_RELEASE_SIGNING_KEY=<path to PKCS#8 PEM private key> when
// packaging to also write ims-agent-<version>.tgz.sig (Ed25519 signature over
// the SHA-256 hex digest, verified by agents that pin the public key).
// ---------------------------------------------------------------------------
import { build } from 'esbuild';
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VERSION = process.env.IMS_AGENT_VERSION ?? pkg.version;
const args = process.argv.slice(2);

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(VERSION)) {
  console.error(`Invalid version ${VERSION}`);
  process.exit(1);
}

if (args[0] === '--keygen') {
  const out = resolve(args[1] ?? '.');
  mkdirSync(out, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const priv = join(out, 'ims-release-signing.key');
  if (existsSync(priv)) {
    console.error(`${priv} already exists; refusing to overwrite`);
    process.exit(1);
  }
  writeFileSync(priv, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
  writeFileSync(join(out, 'ims-release-public.key'), raw + '\n');
  console.log(`Private key: ${priv} (keep offline, never commit)`);
  console.log(`Public key (IMS_RELEASE_PUBLIC_KEY / /etc/ims-agent/release-public.key):\n  ${raw}`);
  process.exit(0);
}

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  legalComments: 'none',
  logLevel: 'warning',
  define: { __IMS_AGENT_VERSION__: JSON.stringify(VERSION) },
  // Optional native accelerators of the AWS SDK; the pure-JS paths are used instead.
  external: ['aws-crt', '@aws-sdk/signature-v4-crt'],
};

rmSync(join(ROOT, 'dist'), { recursive: true, force: true });
await build({ ...common, entryPoints: [join(ROOT, 'src/index.ts')], outfile: join(ROOT, 'dist/ims-agent.js'), banner: { js: '#!/usr/bin/env node' } });
await build({ ...common, entryPoints: [join(ROOT, 'updater/launcher.ts')], outfile: join(ROOT, 'dist/launcher.js'), banner: { js: '#!/usr/bin/env node' } });
chmodSync(join(ROOT, 'dist/ims-agent.js'), 0o755);
chmodSync(join(ROOT, 'dist/launcher.js'), 0o755);
console.log(`Built IMS Agent ${VERSION} (${(statSync(join(ROOT, 'dist/ims-agent.js')).size / 1024).toFixed(0)} KiB)`);

if (!args.includes('--package')) process.exit(0);

// ---- package ------------------------------------------------------------------
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const bundle = readFileSync(join(ROOT, 'dist/ims-agent.js'));
const manifest = {
  name: 'ims-agent',
  version: VERSION,
  entry: 'dist/ims-agent.js',
  node: pkg.engines?.node ?? '>=20.19.0',
  builtAt: new Date().toISOString(),
  bundleSha256: sha(bundle),
};

/** Files in the package: [path inside archive, source, mode]. */
const files = [
  ['manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), 0o644],
  ['VERSION', Buffer.from(VERSION + '\n'), 0o644],
  ['dist/ims-agent.js', bundle, 0o755],
  ['dist/launcher.js', readFileSync(join(ROOT, 'dist/launcher.js')), 0o755],
  ['installer/install.sh', readFileSync(join(ROOT, 'installer/install.sh')), 0o755],
  ['installer/uninstall.sh', readFileSync(join(ROOT, 'installer/uninstall.sh')), 0o755],
  ['installer/ecosystem.config.cjs', readFileSync(join(ROOT, 'installer/ecosystem.config.cjs')), 0o644],
  ['installer/ims-agent.sh', readFileSync(join(ROOT, 'installer/ims-agent.sh')), 0o755],
  ['README.md', readFileSync(join(ROOT, 'README.md')), 0o644],
];

// Minimal deterministic ustar writer (no external tar needed on any build OS).
function header(name, size, mode, type) {
  const h = Buffer.alloc(512);
  if (Buffer.byteLength(name) > 100) throw new Error(`Path too long for ustar: ${name}`);
  h.write(name, 0, 100, 'utf8');
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100, 'ascii');
  h.write('0000000\0', 108, 'ascii');
  h.write('0000000\0', 116, 'ascii');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  h.write(Math.floor(Date.parse(manifest.builtAt) / 1000).toString(8).padStart(11, '0') + '\0', 136, 'ascii');
  h.fill(' ', 148, 156);
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.write('root', 265, 'ascii');
  h.write('root', 297, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

const parts = [];
const dirs = new Set();
for (const [name] of files) {
  const segs = name.split('/').slice(0, -1);
  for (let i = 1; i <= segs.length; i++) dirs.add(segs.slice(0, i).join('/') + '/');
}
for (const d of [...dirs].sort()) parts.push(header(d, 0, 0o755, '5'));
for (const [name, data, mode] of files) {
  parts.push(header(name, data.length, mode, '0'), data, Buffer.alloc((512 - (data.length % 512)) % 512));
}
parts.push(Buffer.alloc(1024));
const tgz = gzipSync(Buffer.concat(parts), { level: 9 });

const outDir = join(ROOT, 'release');
mkdirSync(outDir, { recursive: true });
const fileName = `ims-agent-${VERSION}.tgz`;
const out = join(outDir, fileName);
writeFileSync(out, tgz);
const digest = sha(tgz);
writeFileSync(`${out}.sha256`, `${digest}  ${fileName}\n`);

const keyPath = process.env.IMS_RELEASE_SIGNING_KEY;
if (keyPath) {
  const key = createPrivateKey(readFileSync(keyPath, 'utf8'));
  writeFileSync(`${out}.sig`, sign(null, Buffer.from(digest, 'ascii'), key).toString('base64') + '\n');
  console.log(`Signed with ${keyPath}`);
}

console.log(`Package: ${relative(ROOT, out)} (${(tgz.length / 1024).toFixed(0)} KiB)`);
console.log(`SHA-256: ${digest}`);
console.log('Upload it in IMS › Updates › Agent releases, or attach it (with .sha256/.sig) to a GitHub release tagged v' + VERSION);
