<?php
/**
 * One-time registration of this hosting account with IMS-Core.
 *
 *   php ~/ims-agent/cron/register.php --core-url=https://itwodms.ir --token=imsr_xxx
 *   php ~/ims-agent/cron/register.php --core-url=https://itwodms.ir --token-file=/path/to/token
 *
 * The token is single-use and expires, so a copy left in shell history is harmless
 * after registration; --token-file avoids it altogether.
 */

declare(strict_types=1);

require dirname(__DIR__) . '/src/bootstrap.php';

use Ims\Agent\Config;
use Ims\Agent\CoreClient;
use Ims\Agent\Protocol;

$opts = getopt('', ['core-url:', 'token:', 'token-file:', 'force']);
try {
    $coreUrl = CoreClient::normalizeUrl((string) ($opts['core-url'] ?? ''));
    $token = isset($opts['token-file']) ? trim((string) file_get_contents((string) $opts['token-file'])) : trim((string) ($opts['token'] ?? ''));
    if (!preg_match('/^imsr_[A-Za-z0-9_-]{32}$/', $token)) {
        throw new InvalidArgumentException('Provide a valid --token or --token-file');
    }

    $config = new Config();
    $config->ensureDirectories();
    if ($config->loadIdentity() !== null && !isset($opts['force'])) {
        throw new RuntimeException('This agent is already registered. Use --force to re-register with a new token.');
    }

    $keys = Protocol::sodiumAvailable() ? Protocol::generateKeyPair() : null;
    if ($keys === null) {
        fwrite(STDERR, "warning: libsodium is not available; registering in HMAC-only mode\n");
    }

    $res = CoreClient::register($coreUrl, array_filter([
        'registrationToken' => $token,
        'publicKey' => $keys['publicKey'] ?? null,
        'agentType' => 'CPANEL',
        'agentVersion' => IMS_AGENT_VERSION,
        'hostname' => substr((string) (gethostname() ?: 'shared-host'), 0, 255),
        'os' => substr(php_uname('s') . ' ' . php_uname('r') . ' (PHP ' . PHP_VERSION . ')', 0, 255),
        'arch' => substr(php_uname('m'), 0, 32),
    ], static function ($v) {
        return $v !== null;
    }));

    if (empty($res['nodeId']) || empty($res['nodeSecret'])) {
        throw new RuntimeException('Unexpected registration response');
    }

    $config->saveIdentity([
        'nodeId' => $res['nodeId'],
        'coreUrl' => $coreUrl,
        'nodeSecret' => $res['nodeSecret'],
        'secretKey' => $keys['secretKey'] ?? null,
        'publicKey' => $keys['publicKey'] ?? null,
        'keyFingerprint' => $res['keyFingerprint'] ?? null,
        'registeredAt' => gmdate('c'),
    ]);

    $php = PHP_BINARY ?: 'php';
    $cron = dirname(__DIR__) . '/cron/ims-cron.php';
    echo "Registered as {$res['nodeId']}\n";
    echo "Add this cron job in cPanel (Cron Jobs, every 5 minutes):\n\n";
    echo "  */5 * * * * {$php} {$cron} >/dev/null 2>&1\n\n";
} catch (Throwable $e) {
    fwrite(STDERR, 'Registration failed: ' . $e->getMessage() . "\n");
    exit(1);
}
