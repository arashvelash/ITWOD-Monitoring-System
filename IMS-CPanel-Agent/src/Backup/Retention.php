<?php

declare(strict_types=1);

namespace Ims\Agent\Backup;

/**
 * Same rules as the Ubuntu agent: only IMS archives of this job are considered,
 * the newest one is always kept, invalid policies delete nothing.
 */
final class Retention
{
    /**
     * @param string[] $names
     * @return string[] names that may be removed
     */
    public static function selectForDeletion(string $slug, array $names, int $count, ?int $days, int $now): array
    {
        if ($count < 1) {
            return [];
        }
        $dated = [];
        foreach ($names as $name) {
            $t = Naming::parseTime($slug, $name);
            if ($t !== null) {
                $dated[] = [$name, $t];
            }
        }
        if (count($dated) <= 1) {
            return [];
        }
        usort($dated, static function ($a, $b) {
            return $b[1] <=> $a[1];
        });
        $cutoff = $days ? $now - $days * 86400 : null;
        $out = [];
        foreach ($dated as $i => [$name, $t]) {
            if ($i === 0) {
                continue;
            }
            if ($i >= $count || ($cutoff !== null && $t < $cutoff)) {
                $out[] = $name;
            }
        }
        return $out;
    }
}
