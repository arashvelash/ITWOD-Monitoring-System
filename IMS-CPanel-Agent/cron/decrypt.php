<?php
/**
 * Decrypts an IMS encrypted archive (.enc) for restore:
 *   php cron/decrypt.php <input.enc> <output> --key-file=/path/to/key.txt
 * The key is shown in the IMS dashboard (Backups > job > Encryption key).
 */

declare(strict_types=1);

require dirname(__DIR__) . '/src/bootstrap.php';

use Ims\Agent\Backup\ArchiveEncryptor;

$opts = getopt('', ['key-file:'], $rest);
$args = array_slice($argv, $rest);
if (count($args) !== 2 || empty($opts['key-file'])) {
    fwrite(STDERR, "usage: php cron/decrypt.php <input.enc> <output> --key-file=<file>\n");
    exit(1);
}
[$in, $out] = $args;
try {
    $tmp = $out . '.partial';
    ArchiveEncryptor::decryptFile($in, $tmp, (string) file_get_contents((string) $opts['key-file']));
    rename($tmp, $out);
    echo "Decrypted to {$out}\n";
} catch (Throwable $e) {
    @unlink($out . '.partial');
    fwrite(STDERR, 'Decryption failed: ' . $e->getMessage() . "\n");
    exit(1);
}
