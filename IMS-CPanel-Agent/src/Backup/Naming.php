<?php

declare(strict_types=1);

namespace Ims\Agent\Backup;

/**
 * Archive naming shared with the Ubuntu agent:
 *   ims-<slug>-<YYYYMMDDTHHMMSSZ>.<tar.gz|sql.gz>[.enc]
 * Retention only ever touches names matching this pattern for the job slug.
 */
final class Naming
{
    public static function assertSlug(string $slug): void
    {
        if (!preg_match('/^[a-z0-9][a-z0-9-]{0,63}$/', $slug)) {
            throw new \InvalidArgumentException('Invalid job slug');
        }
    }

    public static function archiveName(string $slug, string $kind, bool $encrypted, \DateTimeInterface $at): string
    {
        self::assertSlug($slug);
        if (!in_array($kind, ['tar.gz', 'sql.gz'], true)) {
            throw new \InvalidArgumentException('Invalid archive kind');
        }
        $utc = (new \DateTimeImmutable('@' . $at->getTimestamp()))->setTimezone(new \DateTimeZone('UTC'));
        return 'ims-' . $slug . '-' . $utc->format('Ymd\THis\Z') . '.' . $kind . ($encrypted ? '.enc' : '');
    }

    public static function pattern(string $slug): string
    {
        self::assertSlug($slug);
        return '/^ims-' . preg_quote($slug, '/') . '-(\d{8}T\d{6}Z)\.(tar\.gz|sql\.gz)(\.enc)?$/';
    }

    public static function parseTime(string $slug, string $name): ?int
    {
        if (!preg_match(self::pattern($slug), $name, $m)) {
            return null;
        }
        $d = \DateTimeImmutable::createFromFormat('Ymd\THis\Z', $m[1], new \DateTimeZone('UTC'));
        return $d ? $d->getTimestamp() : null;
    }
}
