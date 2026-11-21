import semver from 'semver';

/** Strict SemVer (no build metadata), optionally prefixed with "v". Safe to use in file paths and git refs. */
const VERSION_RE = /^v?(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(-[0-9A-Za-z]+(\.[0-9A-Za-z]+){0,4})?$/;

export function isValidVersion(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 32 && VERSION_RE.test(v) && semver.valid(v.replace(/^v/, '')) !== null;
}

/** "v1.2.3" → "1.2.3". Throws on anything that is not a strict version. */
export function normalizeVersion(v: string): string {
  if (!isValidVersion(v)) throw new Error(`Invalid version: ${String(v).slice(0, 40)}`);
  return v.replace(/^v/, '');
}

export function isNewer(candidate: string, current: string): boolean {
  const c = semver.valid(candidate.replace(/^v/, ''));
  const cur = semver.valid(current.replace(/^v/, ''));
  if (!c) return false;
  if (!cur) return true; // development builds ("0.0.0-dev") accept any release
  return semver.gt(c, cur);
}

export function sortVersionsDesc<T extends { version: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => semver.rcompare(a.version, b.version));
}
