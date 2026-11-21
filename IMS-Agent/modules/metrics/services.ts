import { execFile } from 'node:child_process';

/** Same rule as Core (settings registry / metrics schema). Leading dashes are rejected so a name can never become an option. */
export const SERVICE_NAME = /^[a-zA-Z0-9@._][a-zA-Z0-9@._-]{0,63}$/;
const MAX_SERVICES = 50;

export interface ServiceState {
  name: string;
  active: boolean;
  state: string;
}

export function validServiceNames(names: readonly string[]): string[] {
  return [...new Set(names.filter((n) => typeof n === 'string' && SERVICE_NAME.test(n)))].slice(0, MAX_SERVICES);
}

/** `systemctl is-active a b c` prints one state per unit, in argument order. */
export function parseIsActive(names: string[], stdout: string): ServiceState[] | null {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length !== names.length) return null;
  return names.map((name, i) => {
    const state = lines[i].slice(0, 32);
    return { name, state, active: state === 'active' || state === 'reloading' };
  });
}

export type ExecFileFn = (file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string }>;

const defaultExec: ExecFileFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: opts.timeout, maxBuffer: 64 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' } }, (err, stdout) => {
      // is-active exits non-zero when any unit is not active; stdout is still complete.
      if (err && typeof (err as NodeJS.ErrnoException).code !== 'number') return reject(err);
      resolve({ stdout: String(stdout) });
    });
  });

/**
 * Queries systemd for the watched services. Uses execFile (no shell) with
 * validated names; returns null when systemd is unavailable so that no false
 * SERVICE_DOWN alerts are raised on hosts without systemctl.
 */
export async function checkServices(names: readonly string[], exec: ExecFileFn = defaultExec): Promise<ServiceState[] | null> {
  const valid = validServiceNames(names);
  if (!valid.length) return [];
  try {
    const { stdout } = await exec('systemctl', ['is-active', '--', ...valid], { timeout: 5_000 });
    return parseIsActive(valid, stdout);
  } catch {
    return null;
  }
}
