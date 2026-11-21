import { readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * Persistent self-update state (update-state.json), shared by the running
 * agent and the launcher:
 *
 *   pending             new release is active but not yet confirmed
 *   rollback-requested  new release could not reach Core in time → launcher rolls back
 *   rolled_back         launcher restored the previous release; result not yet reported
 *   committed           new release confirmed (connected to Core and stable)
 */
export type UpdatePhase = 'pending' | 'rollback-requested' | 'rolled_back' | 'committed';

export interface UpdateState {
  state: UpdatePhase;
  version: string;
  previousVersion: string;
  /** Absolute release directory `current` pointed to before the switch. */
  previousTarget: string | null;
  commandId: string | null;
  switchedAt: string;
  bootAttempts: number;
  error?: string;
  reported?: boolean;
  committedAt?: string;
  rolledBackAt?: string;
}

/** Crash loops: the new release is rolled back after this many boots without a commit. */
export const MAX_BOOT_ATTEMPTS = 3;
/** The new release must confirm itself (connected + stable) within this window. */
export const COMMIT_DEADLINE_MS = 5 * 60_000;

export function readStateSync(file: string): UpdateState | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as UpdateState;
  } catch {
    return null;
  }
}

export function writeStateSync(file: string, state: UpdateState): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

export type BootDecision = { action: 'continue'; state: UpdateState | null } | { action: 'rollback'; state: UpdateState; reason: string };

/**
 * Pure launcher decision taken before the agent code is loaded. Counting
 * boots here (not in the agent) also catches releases that crash on import.
 */
export function decideBoot(state: UpdateState | null, now: number = Date.now()): BootDecision {
  if (!state) return { action: 'continue', state: null };
  if (state.state === 'rollback-requested') {
    return { action: 'rollback', state, reason: state.error ?? `Version ${state.version} could not connect to Core` };
  }
  if (state.state !== 'pending') return { action: 'continue', state };
  const next: UpdateState = { ...state, bootAttempts: (state.bootAttempts ?? 0) + 1 };
  if (next.bootAttempts > MAX_BOOT_ATTEMPTS) {
    return { action: 'rollback', state: next, reason: `Version ${state.version} crashed ${state.bootAttempts} times after the update` };
  }
  const switched = Date.parse(state.switchedAt);
  if (Number.isFinite(switched) && now - switched > COMMIT_DEADLINE_MS * 2) {
    return { action: 'rollback', state: next, reason: `Version ${state.version} was not confirmed within ${Math.round((COMMIT_DEADLINE_MS * 2) / 60_000)} minutes` };
  }
  return { action: 'continue', state: next };
}
