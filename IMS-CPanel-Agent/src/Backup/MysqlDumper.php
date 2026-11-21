<?php

declare(strict_types=1);

namespace Ims\Agent\Backup;

/**
 * Pure-PHP MySQL/MariaDB dump through PDO (no exec needed). Uses a consistent
 * snapshot and unbuffered reads so large tables stream with constant memory.
 * The generated SQL is a restore script; IMS never executes it.
 */
final class MysqlDumper
{
    /** @return array{tables:int, rows:int} */
    public static function dump(string $host, int $port, string $database, string $user, string $password, string $target, int $level): array
    {
        if (!extension_loaded('pdo_mysql')) {
            throw new \RuntimeException('The pdo_mysql extension is required for database backups');
        }
        $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $host, $port, $database);
        $pdo = new \PDO($dsn, $user, $password, [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
            \PDO::ATTR_EMULATE_PREPARES => false,
            \PDO::MYSQL_ATTR_USE_BUFFERED_QUERY => true,
        ]);
        $pdo->exec('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        $pdo->exec('START TRANSACTION WITH CONSISTENT SNAPSHOT');

        $gz = gzopen($target, 'wb' . max(1, min(9, $level)));
        if ($gz === false) {
            throw new \RuntimeException("Cannot create {$target}");
        }
        $tables = 0;
        $rows = 0;
        try {
            gzwrite($gz, "-- IMS cPanel Agent SQL dump\n-- Database: `{$database}`\n-- Created: " . gmdate('c') . "\n\n"
                . "SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\nSET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\n\n");
            $list = $pdo->query('SHOW FULL TABLES')->fetchAll(\PDO::FETCH_NUM);
            $views = [];
            foreach ($list as [$table, $kind]) {
                if ($kind === 'VIEW') {
                    $views[] = $table;
                    continue;
                }
                $q = self::ident($table);
                $create = $pdo->query("SHOW CREATE TABLE {$q}")->fetch(\PDO::FETCH_NUM)[1];
                gzwrite($gz, "DROP TABLE IF EXISTS {$q};\n{$create};\n\n");
                $rows += self::dumpRows($pdo, $gz, $q);
                $tables++;
            }
            foreach ($views as $view) {
                $q = self::ident($view);
                $create = $pdo->query("SHOW CREATE VIEW {$q}")->fetch(\PDO::FETCH_NUM)[1];
                gzwrite($gz, "DROP VIEW IF EXISTS {$q};\n{$create};\n\n");
            }
            gzwrite($gz, "SET FOREIGN_KEY_CHECKS=1;\n");
            $pdo->exec('COMMIT');
        } finally {
            gzclose($gz);
        }
        return ['tables' => $tables, 'rows' => $rows];
    }

    /** @param resource $gz */
    private static function dumpRows(\PDO $pdo, $gz, string $table): int
    {
        $pdo->setAttribute(\PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, false);
        $count = 0;
        try {
            $stmt = $pdo->query("SELECT * FROM {$table}");
            $batch = [];
            while (($row = $stmt->fetch(\PDO::FETCH_NUM)) !== false) {
                $values = array_map(static function ($v) use ($pdo) {
                    return $v === null ? 'NULL' : $pdo->quote((string) $v);
                }, $row);
                $batch[] = '(' . implode(',', $values) . ')';
                $count++;
                if (count($batch) >= 200) {
                    gzwrite($gz, "INSERT INTO {$table} VALUES\n" . implode(",\n", $batch) . ";\n");
                    $batch = [];
                }
            }
            if ($batch) {
                gzwrite($gz, "INSERT INTO {$table} VALUES\n" . implode(",\n", $batch) . ";\n");
            }
            $stmt->closeCursor();
            gzwrite($gz, "\n");
        } finally {
            $pdo->setAttribute(\PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, true);
        }
        return $count;
    }

    private static function ident(string $name): string
    {
        return '`' . str_replace('`', '``', $name) . '`';
    }
}
