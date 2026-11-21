import { parseArchiveTime } from './naming';

export interface ArchiveEntry {
  name: string;
}

export interface RetentionPolicy {
  count: number;
  days: number | null;
}

/**
 * Decides which archives of a job may be removed.
 *
 * Safety rules:
 *  - only names matching the IMS pattern for this job slug are considered;
 *  - the newest archive is always kept (even if older than `days`);
 *  - nothing is removed when the policy is invalid.
 */
export function selectForDeletion<T extends ArchiveEntry>(slug: string, entries: T[], policy: RetentionPolicy, now = new Date()): T[] {
  if (!Number.isInteger(policy.count) || policy.count < 1) return [];
  const dated = entries
    .map((e) => ({ e, t: parseArchiveTime(slug, e.name) }))
    .filter((x): x is { e: T; t: Date } => x.t !== null)
    .sort((a, b) => b.t.getTime() - a.t.getTime());
  if (dated.length <= 1) return [];

  const cutoff = policy.days ? now.getTime() - policy.days * 86_400_000 : null;
  return dated
    .filter((x, index) => {
      if (index === 0) return false;
      if (index >= policy.count) return true;
      return cutoff !== null && x.t.getTime() < cutoff;
    })
    .map((x) => x.e);
}
