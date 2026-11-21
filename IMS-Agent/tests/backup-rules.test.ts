import { describe, expect, it } from 'vitest';
import { archiveName, parseArchiveTime } from '../modules/backup/naming';
import { selectForDeletion } from '../modules/backup/retention';
import { assertSafeSourcePath, tarArgs } from '../modules/backup/source-paths';

describe('archive naming', () => {
  it('builds and parses IMS archive names', () => {
    const at = new Date('2026-03-04T05:06:07.890Z');
    const name = archiveName('site-files', 'tar.gz', true, at);
    expect(name).toBe('ims-site-files-20260304T050607Z.tar.gz.enc');
    expect(parseArchiveTime('site-files', name)?.toISOString()).toBe('2026-03-04T05:06:07.000Z');
    expect(parseArchiveTime('site-files', 'ims-other-20260304T050607Z.tar.gz')).toBeNull();
    expect(parseArchiveTime('site-files', 'customer-data.tar.gz')).toBeNull();
    expect(() => archiveName('../evil', 'tar.gz', false, at)).toThrow();
  });
});

describe('retention', () => {
  const names = ['20260101', '20260102', '20260103', '20260104', '20260105'].map((d) => ({ name: `ims-db-${d}T030000Z.sql.gz` }));
  const now = new Date('2026-01-06T00:00:00Z');

  it('keeps the newest N archives', () => {
    const doomed = selectForDeletion('db', names, { count: 2, days: null }, now).map((e) => e.name);
    expect(doomed).toEqual(['ims-db-20260103T030000Z.sql.gz', 'ims-db-20260102T030000Z.sql.gz', 'ims-db-20260101T030000Z.sql.gz']);
  });

  it('applies the age limit but never deletes the newest archive', () => {
    expect(selectForDeletion('db', names, { count: 10, days: 3 }, now).map((e) => e.name)).toEqual(['ims-db-20260102T030000Z.sql.gz', 'ims-db-20260101T030000Z.sql.gz']);
    expect(selectForDeletion('db', names, { count: 10, days: 1 }, new Date('2027-01-01Z'))).toHaveLength(4);
  });

  it('ignores foreign files and invalid policies', () => {
    const mixed = [...names, { name: 'important.sql' }, { name: 'ims-db-20250101T030000Z.sql.gz.partial' }, { name: 'ims-dbx-20250101T030000Z.sql.gz' }];
    const doomed = selectForDeletion('db', mixed, { count: 1, days: null }, now).map((e) => e.name);
    expect(doomed).not.toContain('important.sql');
    expect(doomed.every((n) => n.startsWith('ims-db-2026'))).toBe(true);
    expect(selectForDeletion('db', names, { count: 0, days: null }, now)).toEqual([]);
  });
});

describe('source path safety', () => {
  it('rejects dangerous paths', () => {
    expect(() => assertSafeSourcePath('/', '/var/backups/ims')).toThrow();
    expect(() => assertSafeSourcePath('/proc/self', '/var/backups/ims')).toThrow();
    expect(() => assertSafeSourcePath('/var/backups/ims/x', '/var/backups/ims')).toThrow();
    expect(() => assertSafeSourcePath('/var/www/../..', '/var/backups/ims')).toThrow();
    expect(assertSafeSourcePath('/var/www/', '/var/backups/ims')).toBe('/var/www');
  });

  it('builds tar arguments that cannot be interpreted as options', () => {
    const args = tarArgs(['/var/www/site', '/-weird'], ['*.log'], '/var/backups/ims');
    const sep = args.indexOf('--');
    expect(sep).toBeGreaterThan(0);
    expect(args.slice(sep + 1)).toEqual(['var/www/site', '-weird']);
    expect(args).toContain('--exclude=*.log');
    expect(args).toContain('--exclude=var/backups/ims');
    expect(() => tarArgs(['/var/www'], ['--to-command=sh'], '/var/backups/ims')).toThrow();
  });
});
