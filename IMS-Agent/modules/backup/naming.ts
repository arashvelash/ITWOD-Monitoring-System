/**
 * Archive naming. Retention only ever touches files matching this exact
 * pattern for the job's slug, so IMS can never delete files it did not create.
 *
 *   ims-<slug>-<YYYYMMDDTHHMMSSZ>.<tar.gz|sql.gz>[.enc]
 */
export type ArchiveKind = 'tar.gz' | 'sql.gz';

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function timestampTag(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function archiveName(slug: string, kind: ArchiveKind, encrypted: boolean, at: Date): string {
  if (!SLUG.test(slug)) throw new Error('Invalid job slug');
  return `ims-${slug}-${timestampTag(at)}.${kind}${encrypted ? '.enc' : ''}`;
}

export function archivePattern(slug: string): RegExp {
  if (!SLUG.test(slug)) throw new Error('Invalid job slug');
  return new RegExp(`^ims-${slug}-(\\d{8}T\\d{6}Z)\\.(tar\\.gz|sql\\.gz)(\\.enc)?$`);
}

/** Parses the creation time from an IMS archive name, or null if it is not one. */
export function parseArchiveTime(slug: string, name: string): Date | null {
  const m = archivePattern(slug).exec(name);
  if (!m) return null;
  const t = m[1]!;
  const iso = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(9, 11)}:${t.slice(11, 13)}:${t.slice(13, 15)}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
