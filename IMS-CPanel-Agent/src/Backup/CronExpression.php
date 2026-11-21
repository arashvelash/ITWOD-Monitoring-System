<?php

declare(strict_types=1);

namespace Ims\Agent\Backup;

/**
 * Minimal 5-field cron evaluator (minute hour day-of-month month day-of-week)
 * supporting "*", lists, ranges and steps. Day-of-month and day-of-week use
 * standard Vixie cron OR semantics when both are restricted.
 */
final class CronExpression
{
    private const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

    /** @var array<int, array<int,bool>> */
    private $sets = [];
    /** @var bool */
    private $domRestricted;
    /** @var bool */
    private $dowRestricted;

    public function __construct(string $expr)
    {
        $fields = preg_split('/\s+/', trim($expr));
        if (!is_array($fields) || count($fields) !== 5) {
            throw new \InvalidArgumentException('Cron expression must have 5 fields');
        }
        foreach ($fields as $i => $field) {
            $this->sets[$i] = self::parseField($field, self::RANGES[$i][0], self::RANGES[$i][1]);
        }
        if (isset($this->sets[4][7])) {
            $this->sets[4][0] = true;
        }
        $this->domRestricted = $fields[2] !== '*';
        $this->dowRestricted = $fields[4] !== '*';
    }

    public static function isValid(string $expr): bool
    {
        try {
            new self($expr);
            return true;
        } catch (\Throwable $e) {
            return false;
        }
    }

    public function matches(\DateTimeInterface $t): bool
    {
        $minute = (int) $t->format('i');
        $hour = (int) $t->format('G');
        $dom = (int) $t->format('j');
        $month = (int) $t->format('n');
        $dow = (int) $t->format('w');
        if (!isset($this->sets[0][$minute], $this->sets[1][$hour], $this->sets[3][$month])) {
            return false;
        }
        $domOk = isset($this->sets[2][$dom]);
        $dowOk = isset($this->sets[4][$dow]);
        if ($this->domRestricted && $this->dowRestricted) {
            return $domOk || $dowOk;
        }
        return $domOk && $dowOk;
    }

    /**
     * Latest matching minute in (after, now], evaluated in the job time zone.
     * Scans at most $maxMinutes minutes backwards from now.
     */
    public function latestSlot(\DateTimeImmutable $after, \DateTimeImmutable $now, string $tz, int $maxMinutes = 1440): ?\DateTimeImmutable
    {
        $local = $now->setTimezone(new \DateTimeZone($tz));
        $t = $local->setTime((int) $local->format('G'), (int) $local->format('i'), 0);
        for ($i = 0; $i < $maxMinutes; $i++) {
            if ($t <= $after) {
                return null;
            }
            if ($this->matches($t)) {
                return $t;
            }
            $t = $t->modify('-1 minute');
        }
        return null;
    }

    /** @return array<int,bool> */
    private static function parseField(string $field, int $min, int $max): array
    {
        $out = [];
        foreach (explode(',', $field) as $part) {
            $step = 1;
            if (strpos($part, '/') !== false) {
                [$part, $stepStr] = explode('/', $part, 2);
                if (!ctype_digit($stepStr) || (int) $stepStr < 1) {
                    throw new \InvalidArgumentException("Invalid step in {$field}");
                }
                $step = (int) $stepStr;
            }
            if ($part === '*') {
                $lo = $min;
                $hi = $max;
            } elseif (preg_match('/^(\d+)-(\d+)$/', $part, $m)) {
                $lo = (int) $m[1];
                $hi = (int) $m[2];
            } elseif (ctype_digit($part)) {
                $lo = (int) $part;
                $hi = $step > 1 ? $max : $lo;
            } else {
                throw new \InvalidArgumentException("Invalid cron field {$field}");
            }
            if ($lo < $min || $hi > $max || $lo > $hi) {
                throw new \InvalidArgumentException("Cron value out of range in {$field}");
            }
            for ($v = $lo; $v <= $hi; $v += $step) {
                $out[$v] = true;
            }
        }
        return $out;
    }
}
