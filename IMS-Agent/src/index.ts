/**
 * ims-agent command line interface.
 *
 *   ims-agent run                          start the agent (PM2 runs this via the launcher)
 *   ims-agent register --core-url <url>    one-time registration (token from IMS_REGISTRATION_TOKEN
 *                                          or --token-file); never pass the token as an argument
 *   ims-agent status                       show identity and local state
 *   ims-agent decrypt <in> <out> --key-file <file>   decrypt an encrypted backup archive
 *   ims-agent self-test                    load all modules and exit (used by the updater)
 *   ims-agent version
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { Agent } from './agent';
import { registerWithCore } from './core-client';
import { normalizeCoreUrl } from './core-url';
import { fingerprint, generateNodeKey, loadIdentity, savePrivateKey, saveIdentity } from './identity';
import { createLogger } from './logger';
import { agentPaths } from './paths';
import { osPrettyName } from './system-info';
import { AGENT_TYPE, AGENT_VERSION } from './version';
import { readJson } from './fs-utils';
import { decryptArchiveFile } from '../modules/crypto/archive-encryption';

const log = createLogger('cli');

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  const prefixed = args.find((a) => a.startsWith(`${name}=`));
  return prefixed?.slice(name.length + 1);
}

async function register(args: string[]): Promise<void> {
  const paths = agentPaths();
  const coreUrl = normalizeCoreUrl(arg(args, '--core-url') ?? '');
  const tokenFile = arg(args, '--token-file');
  const token = (tokenFile ? await readFile(tokenFile, 'utf8') : (process.env.IMS_REGISTRATION_TOKEN ?? '')).trim();
  if (!/^imsr_[A-Za-z0-9_-]{32}$/.test(token)) throw new Error('Provide a valid registration token via IMS_REGISTRATION_TOKEN or --token-file');

  const existing = await loadIdentity(paths).catch(() => null);
  if (existing && !args.includes('--force')) {
    throw new Error(`Agent is already registered as ${existing.nodeId}. Use --force to re-register with a new token.`);
  }

  const { privateKey, publicKeyBase64 } = generateNodeKey();
  const res = await registerWithCore(coreUrl, {
    registrationToken: token,
    publicKey: publicKeyBase64,
    agentType: AGENT_TYPE,
    agentVersion: AGENT_VERSION.replace(/^0\.0\.0-dev$/, '0.0.0'),
    hostname: os.hostname().slice(0, 255),
    os: osPrettyName().slice(0, 255),
    arch: process.arch,
  });
  if (res.keyFingerprint && res.keyFingerprint !== fingerprint(publicKeyBase64)) {
    throw new Error('Core returned an unexpected key fingerprint; aborting');
  }
  await savePrivateKey(paths, privateKey);
  await saveIdentity(paths, { version: 1, nodeId: res.nodeId, coreUrl, nodeSecret: res.nodeSecret, keyFingerprint: res.keyFingerprint, registeredAt: new Date().toISOString() });
  process.stdout.write(`Registered as ${res.nodeId}\nKey fingerprint: ${res.keyFingerprint}\n`);
}

async function status(): Promise<void> {
  const paths = agentPaths();
  const identity = await loadIdentity(paths);
  const cache = await readJson<{ configVersion: number; jobs: unknown[] }>(paths.configCacheFile).catch(() => null);
  const update = await readJson(paths.updateStateFile).catch(() => null);
  process.stdout.write(
    JSON.stringify(
      {
        version: AGENT_VERSION,
        registered: Boolean(identity),
        nodeId: identity?.nodeId,
        coreUrl: identity?.coreUrl,
        keyFingerprint: identity?.keyFingerprint,
        configVersion: cache?.configVersion ?? null,
        jobs: cache?.jobs.length ?? 0,
        updateState: update,
      },
      null,
      2,
    ) + '\n',
  );
}

async function run(): Promise<void> {
  const agent = await Agent.fromDisk();
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('Shutting down', { signal });
    void agent.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error('Unhandled rejection', { error: reason instanceof Error ? reason.message : String(reason) }));
  await agent.start();
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command = 'run', ...args] = argv;
  switch (command) {
    case 'run':
      return run();
    case 'register':
      return register(args);
    case 'status':
      return status();
    case 'decrypt': {
      const [input, output] = args;
      const keyFile = arg(args, '--key-file');
      if (!input || !output || !keyFile) throw new Error('usage: ims-agent decrypt <input> <output> --key-file <file>');
      await decryptArchiveFile(input, output, (await readFile(keyFile, 'utf8')).trim());
      process.stdout.write(`Decrypted to ${output}\n`);
      return;
    }
    case 'self-test':
      process.stdout.write(`ok ${AGENT_VERSION}\n`);
      return;
    case 'version':
    case '--version':
      process.stdout.write(`${AGENT_VERSION}\n`);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// Executed directly (node ims-agent.js ...) rather than through the launcher.
if (require.main === module) {
  main().catch((err: Error) => {
    process.stderr.write(`ims-agent: ${err.message}\n`);
    process.exit(1);
  });
}
