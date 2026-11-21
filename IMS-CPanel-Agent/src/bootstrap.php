<?php
/**
 * IMS cPanel Agent bootstrap: constants, autoloader, runtime checks.
 * Compatible with PHP 7.4+ (no Composer dependencies).
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    // Never executable through a web server.
    http_response_code(404);
    exit;
}

define('IMS_AGENT', true);
define('IMS_AGENT_VERSION', trim((string) @file_get_contents(dirname(__DIR__) . '/VERSION')) ?: '0.0.0');
define('IMS_AGENT_ROOT', dirname(__DIR__));

if (PHP_VERSION_ID < 70400) {
    fwrite(STDERR, "IMS cPanel Agent requires PHP 7.4 or newer (found " . PHP_VERSION . ")\n");
    exit(1);
}

foreach (['curl', 'openssl', 'json', 'hash'] as $ext) {
    if (!extension_loaded($ext)) {
        fwrite(STDERR, "Required PHP extension missing: {$ext}\n");
        exit(1);
    }
}

umask(0077);
date_default_timezone_set('UTC');

spl_autoload_register(static function (string $class): void {
    $prefix = 'Ims\\Agent\\';
    if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
        return;
    }
    $file = __DIR__ . '/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
    if (is_file($file)) {
        require $file;
    }
});
