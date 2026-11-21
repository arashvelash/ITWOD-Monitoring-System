import { execFile } from 'node:child_process';
import { createPublicKey, randomBytes, verify, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat, symlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { CoreClient } from '../src/core-client';
import { readJson, writeJson } from '../src/fs-utils';
import { createLogger } from '../src/logger';
import type { AgentPaths } from '../src/paths';
import { AGENT_VERSION } from '../src/version';
import { extractTarGz } from './tar-extract';
import { COMMIT_DEADLINE_MS, type UpdateState } from './update-state';

const log = createLogger('updater');

const VERSION_RE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(-[0-9A-Za-z]+(\.[0-9A-Za-z]+){0,4})?$/;
const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;

export interface UpdatePayload {
  version: string;
  sha256: string;
  sizeBytes: number;
  signature: string | null;
}

export type ResultReporter = (commandId: string, status: 'SUCCEEDED' | 'FAILED', result?: Record<string, unknown>, error?: string) => Promise<void>;

export interface UpdateServiceOptions {
  currentVersion?: string;
  /** Base64 raw Ed25519 public key; when set every release must be signed. */
  releasePublicKey?: string | null;
  exit?: (code: number) => void;
  selfTest?: (entry: string, version: string) => Promise<void>;
  /** Time the new release must stay connected before it is confirmed. */
  commitDelayMs?: number;
  /** Rollback if the new release has not connected within this time. */
  watchdogMs?: number;
}

export function parseUpdatePayload(raw: Record<string, unknown>): UpdatePayload {
  const version = String(raw.version ?? '');
  const sha256 = String(raw.sha256 ?? '');
  const sizeBytes = Number(raw.sizeBytes);
  const signature = raw.signature === null || raw.signature === undefined || raw.signature === '' ? null : String(raw.signature);
  if (!VERSION_RE.test(version)) throw new Error('Invalid update version');
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Invalid update checksum');
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_PACKAGE_BYTES) throw new Error('Invalid update size');
  if (signature !== null && !/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new Error('Invalid update signature');
  return { version, sha256, sizeBytes, signature };
}

/** Loads the pinned release key (env IMS_RELEASE_PUBLIC_KEY or <config>/release-public.key). */
export function loadReleaseKey(paths: AgentPaths, env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.IMS_RELEASE_PUBLIC_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(paths.releaseKeyFile, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function ed25519Key(rawBase64: string): KeyObject {
  const raw = Buffer.from(rawBase64, 'base64');
  if (raw.length !== 32) throw new Error('Release public key must be 32 bytes (base64)');
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
}

/** Signature scheme shared with the build script: Ed25519 over the ASCII SHA-256 hex digest. */
export function verifyReleaseSignature(publicKeyBase64: string, sha256Hex: string, signatureBase64: string): boolean {
  try {
    return verify(null, Buffer.from(sha256Hex, 'ascii'), ed25519Key(publicKeyBase64), Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}

function defaultSelfTest(entry: string, version: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [entry, 'self-test'], { timeout: 30_000, maxBuffer: 64 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`Self-test of ${version} failed: ${err.message}`));
      if (String(stdout).trim() !== `ok ${version}`) return reject(new Error(`Self-test of ${version} returned unexpected output`));
      resolve();
    });
  });
}

/** Points `link` at `target` atomically (rename over the old link). */
export async function switchLink(link: string, target: string): Promise<void> {
  const next = `${link}.next`;
  await rm(next, { force: true, recursive: true });
  await symlink(target, next, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await rename(next, link);
  } catch (err) {
    // Windows cannot rename over an existing junction (development only).
    if (process.platform !== 'win32') throw err;
    await rm(link, { force: true, recursive: true });
    await rename(next, link);
  }
}

/**
 * Self-update: download → verify (size, SHA-256, optional Ed25519 signature)
 * → extract into releases/<version> → self-test → atomic `current` switch →
 * restart. The new release confirms itself once it is connected to Core;
 * otherwise the launcher restores the previous release (see launcher.ts).
 */
export class UpdateService {
  private readonly currentVersion: string;
  private readonly exit: (code: number) => void;
  private readonly selfTest: (entry: string, version: string) => Promise<void>;
  private readonly releaseKey: string | null;
  private readonly commitDelayMs: number;
  private readonly watchdogMs: number;
  private applying = false;
  private commitTimer?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;

  constructor(
    private readonly paths: AgentPaths,
    private readonly client: Pick<CoreClient, 'download'>,
    private readonly report: ResultReporter,
    opts: UpdateServiceOptions = {},
  ) {
    this.currentVersion = opts.currentVersion ?? AGENT_VERSION;
    this.exit = opts.exit ?? ((code) => process.exit(code));
    this.selfTest = opts.selfTest ?? defaultSelfTest;
    this.releaseKey = opts.releasePublicKey !== undefined ? opts.releasePublicKey : loadReleaseKey(paths);
    this.commitDelayMs = opts.commitDelayMs ?? 20_000;
    this.watchdogMs = opts.watchdogMs ?? COMMIT_DEADLINE_MS;
  }

  private readState(): Promise<UpdateState | null> {
    return readJson<UpdateState>(this.paths.updateStateFile).catch(() => null);
  }

  private writeState(state: UpdateState): Promise<void> {
    return writeJson(this.paths.updateStateFile, state);
  }

  /** Reports the outcome of an update that finished across a restart. */
  async onStartup(): Promise<void> {
    const state = await this.readState();
    if (!state) return;
    if (state.state === 'rolled_back' && !state.reported) {
      log.warn('Previous update was rolled back', { version: state.version, error: state.error });
      await this.writeState({ ...state, reported: true });
      if (state.commandId) await this.report(state.commandId, 'FAILED', { version: state.version, rolledBackTo: this.currentVersion }, state.error ?? 'Update rolled back');
      return;
    }
    if (state.state !== 'pending') return;
    if (state.version !== this.currentVersion) {
      // The switch did not take effect (e.g. the agent was started outside the launcher).
      const error = `Version ${state.version} did not start; still running ${this.currentVersion}`;
      await this.writeState({ ...state, state: 'rolled_back', error, reported: true, rolledBackAt: new Date().toISOString() });
      if (state.commandId) await this.report(state.commandId, 'FAILED', { version: state.version }, error);
      return;
    }
    log.info('Running a freshly installed release; waiting for Core to confirm it', { version: state.version });
    this.watchdog = setTimeout(() => void this.requestRollback(), this.watchdogMs);
    this.watchdog.unref?.();
  }

  /** Called whenever the realtime link authenticates. */
  async onConnected(): Promise<void> {
    if (this.commitTimer) return;
    const state = await this.readState();
    if (state?.state !== 'pending' || state.version !== this.currentVersion) return;
    this.commitTimer = setTimeout(() => void this.commit().catch((err: Error) => log.error('Commit failed', { error: err.message })), this.commitDelayMs);
    this.commitTimer.unref?.();
  }

  private async commit(): Promise<void> {
    const state = await this.readState();
    if (state?.state !== 'pending' || state.version !== this.currentVersion) return;
    clearTimeout(this.watchdog);
    await this.writeState({ ...state, state: 'committed', committedAt: new Date().toISOString(), reported: true });
    log.info('Update confirmed', { version: state.version, previous: state.previousVersion });
    if (state.commandId) await this.report(state.commandId, 'SUCCEEDED', { version: state.version, previousVersion: state.previousVersion });
    await this.refreshLauncher().catch((err: Error) => log.warn('Launcher refresh failed', { error: err.message }));
    await this.cleanup(state).catch((err: Error) => log.warn('Release cleanup failed', { error: err.message }));
  }

  private async requestRollback(): Promise<void> {
    const state = await this.readState();
    if (state?.state !== 'pending') return;
    const error = `Version ${state.version} could not connect to Core within ${Math.round(this.watchdogMs / 60_000)} minutes`;
    log.error('Requesting rollback', { error });
    await this.writeState({ ...state, state: 'rollback-requested', error });
    this.exit(75);
  }

  async apply(raw: Record<string, unknown>, commandId: string, stop: () => Promise<void>): Promise<void> {
    if (this.applying) throw new Error('An update is already in progress');
    const payload = parseUpdatePayload(raw);
    if (payload.version === this.currentVersion) {
      await this.report(commandId, 'SUCCEEDED', { version: payload.version, alreadyInstalled: true });
      return;
    }
    const existing = await this.readState();
    if (existing?.state === 'pending' || existing?.state === 'rollback-requested') throw new Error('A previous update has not finished yet');
    if (this.releaseKey) {
      if (!payload.signature) throw new Error('This agent requires signed releases, but the release has no signature');
    }

    this.applying = true;
    const staging = join(this.paths.releasesDir, `.staging-${payload.version}-${randomBytes(4).toString('hex')}`);
    const download = join(this.paths.downloadsDir, `ims-agent-${payload.version}.tgz`);
    try {
      await mkdir(this.paths.downloadsDir, { recursive: true, mode: 0o700 });
      await mkdir(this.paths.releasesDir, { recursive: true, mode: 0o755 });
      log.info('Downloading release', { version: payload.version, bytes: payload.sizeBytes });
      const got = await this.client.download(`/api/v1/agent/releases/${payload.version}/package`, download, payload.sizeBytes);
      if (got.bytes !== payload.sizeBytes || got.sha256 !== payload.sha256) throw new Error('Downloaded package does not match the published size/checksum');
      if (this.releaseKey && !verifyReleaseSignature(this.releaseKey, got.sha256, payload.signature ?? '')) throw new Error('Release signature verification failed');

      await extractTarGz(download, staging);
      const manifest = JSON.parse(await readFile(join(staging, 'manifest.json'), 'utf8')) as { name?: string; version?: string; entry?: string };
      if (manifest.name !== 'ims-agent' || manifest.version !== payload.version) throw new Error('Package manifest does not match the requested version');
      const entry = join(staging, ...String(manifest.entry ?? 'dist/ims-agent.js').split('/'));
      if (!existsSync(entry)) throw new Error('Package entry point is missing');
      await this.selfTest(entry, payload.version);

      const final = join(this.paths.releasesDir, payload.version);
      await rm(final, { recursive: true, force: true });
      await rename(staging, final);
      const previousTarget = await realpath(this.paths.currentLink).catch(() => null);
      await this.writeState({
        state: 'pending',
        version: payload.version,
        previousVersion: this.currentVersion,
        previousTarget,
        commandId,
        switchedAt: new Date().toISOString(),
        bootAttempts: 0,
      });
      await switchLink(this.paths.currentLink, final);
      log.info('Release installed; restarting into the new version', { version: payload.version });
    } catch (err) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    } finally {
      await rm(download, { force: true }).catch(() => undefined);
      this.applying = false;
    }
    await stop();
    this.exit(0);
  }

  /** Keeps the launcher in sync with the confirmed release. */
  private async refreshLauncher(): Promise<void> {
    const source = join(this.paths.currentLink, 'dist', 'launcher.js');
    if (!existsSync(source)) return;
    const target = join(this.paths.installDir, 'launcher.js');
    const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
    await copyFile(source, tmp);
    await rename(tmp, target);
  }

  /** Keeps the active and the previous release; removes older ones and stale staging dirs. */
  private async cleanup(state: UpdateState): Promise<void> {
    const keep = new Set([state.version, state.previousTarget ? basename(state.previousTarget) : state.previousVersion]);
    for (const name of await readdir(this.paths.releasesDir)) {
      const full = join(this.paths.releasesDir, name);
      if (name.startsWith('.staging-') || (VERSION_RE.test(name) && !keep.has(name))) {
        const s = await stat(full).catch(() => null);
        if (s?.isDirectory()) await rm(full, { recursive: true, force: true });
      }
    }
  }
}
