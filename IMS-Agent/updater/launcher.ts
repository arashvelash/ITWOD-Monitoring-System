/**
 * Stable entry point started by PM2 (/opt/ims-agent/launcher.js).
 *
 * It deliberately contains no agent logic: it decides which release to run
 * (rolling back a new release that crash-loops or never confirms itself),
 * then loads <current>/dist/ims-agent.js and calls its main(). Because the
 * launcher itself only changes after a release has been confirmed, a broken
 * release can never break the rollback path.
 */
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { agentPaths, type AgentPaths } from '../src/paths';
import { decideBoot, readStateSync, writeStateSync } from './update-state';

function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, scope: 'launcher', msg, ...fields });
  (level === 'info' ? process.stdout : process.stderr).write(line + '\n');
}

export function switchLinkSync(link: string, target: string): void {
  const next = `${link}.next`;
  rmSync(next, { force: true, recursive: true });
  symlinkSync(target, next, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    renameSync(next, link);
  } catch (err) {
    if (process.platform !== 'win32') throw err;
    rmSync(link, { force: true, recursive: true });
    renameSync(next, link);
  }
}

/** Applies crash-loop / confirmation rules before any agent code is loaded. */
export function prepareBoot(paths: AgentPaths, now: number = Date.now()): 'continue' | 'rolled-back' {
  const state = readStateSync(paths.updateStateFile);
  const decision = decideBoot(state, now);
  if (decision.action === 'continue') {
    if (decision.state && state && decision.state.bootAttempts !== state.bootAttempts) writeStateSync(paths.updateStateFile, decision.state);
    return 'continue';
  }
  const { state: st, reason } = decision;
  const rolledBackAt = new Date(now).toISOString();
  if (st.previousTarget && existsSync(st.previousTarget)) {
    switchLinkSync(paths.currentLink, st.previousTarget);
    writeStateSync(paths.updateStateFile, { ...st, state: 'rolled_back', error: reason, reported: false, rolledBackAt });
    log('warn', 'Rolled back to the previous release', { from: st.version, to: st.previousVersion, reason });
  } else {
    writeStateSync(paths.updateStateFile, { ...st, state: 'rolled_back', error: `${reason} (no previous release available)`, reported: false, rolledBackAt });
    log('error', 'Rollback impossible: previous release is missing', { version: st.version });
  }
  return 'rolled-back';
}

/** Absolute path of the active release's entry point (validated manifest `entry`). */
export function resolveEntry(currentLink: string): string {
  const dir = realpathSync(currentLink);
  let entry = 'dist/ims-agent.js';
  try {
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { entry?: unknown };
    if (typeof m.entry === 'string' && /^[A-Za-z0-9._/-]{1,128}$/.test(m.entry) && !m.entry.split('/').includes('..')) entry = m.entry;
  } catch {
    /* development layout without manifest */
  }
  return join(dir, ...entry.split('/'));
}

export function launch(argv: string[] = process.argv.slice(2)): void {
  const paths = agentPaths();
  const command = argv[0] ?? 'run';
  if (command === 'run') prepareBoot(paths);
  const entry = resolveEntry(paths.currentLink);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(entry) as { main?: (args: string[]) => Promise<void> };
  if (typeof mod.main !== 'function') throw new Error(`${entry} does not export main()`);
  mod.main(argv.length ? argv : ['run']).catch((err: Error) => {
    process.stderr.write(`ims-agent: ${err.message}\n`);
    process.exit(1);
  });
}

if (require.main === module) {
  try {
    launch();
  } catch (err) {
    log('error', 'Launcher failed', { error: (err as Error).message });
    process.exit(1);
  }
}
