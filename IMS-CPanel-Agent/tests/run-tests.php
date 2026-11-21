<?php
/**
 * Runs the cPanel agent test suite:   php tests/run-tests.php [filter]
 */

declare(strict_types=1);

require dirname(__DIR__) . '/src/bootstrap.php';
require __DIR__ . '/TestCase.php';

$filter = $argv[1] ?? '';
foreach (glob(__DIR__ . '/*Test.php') ?: [] as $file) {
    if ($filter === '' || stripos(basename($file), $filter) !== false) {
        require $file;
    }
}

echo "\n" . T::$passed . ' passed, ' . count(T::$failures) . " failed\n";
exit(T::$failures ? 1 : 0);
