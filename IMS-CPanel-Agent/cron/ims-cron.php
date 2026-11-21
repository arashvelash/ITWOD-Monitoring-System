<?php
# Cron entry point (every 5 minutes):
#   */5 * * * * /usr/local/bin/php ~/ims-agent/cron/ims-cron.php >/dev/null 2>&1
# Add --verbose to also print log lines to the terminal.

declare(strict_types=1);

require dirname(__DIR__) . '/src/bootstrap.php';

use Ims\Agent\Agent;
use Ims\Agent\Config;
use Ims\Agent\Lock;
use Ims\Agent\Logger;

$config = new Config();
$log = new Logger($config->logFile, in_array('--verbose', $argv, true));

try {
    $config->ensureDirectories();
    $identity = $config->loadIdentity();
    if ($identity === null) {
        $log->error('Agent is not registered. Run cron/register.php first.');
        exit(1);
    }

    $lock = new Lock();
    if (!$lock->acquire($config->statePath('agent.lock'))) {
        $log->info('Previous run still in progress, skipping this cycle');
        exit(0);
    }

    @set_time_limit(0);
    @ignore_user_abort(true);
    (new Agent($config, $log, $identity))->runCycle();
    $lock->release();
} catch (Throwable $e) {
    $log->error('Cycle failed', ['error' => $e->getMessage(), 'file' => basename($e->getFile()), 'line' => $e->getLine()]);
    exit(1);
}
