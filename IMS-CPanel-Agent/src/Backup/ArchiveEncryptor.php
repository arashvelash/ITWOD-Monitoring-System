<?php

declare(strict_types=1);

namespace Ims\Agent\Backup;

/**
 * IMSENC1 chunked AES-256-GCM (docs/PROTOCOL.md §9), streaming file to file so
 * arbitrarily large archives can be processed with constant memory.
 */
final class ArchiveEncryptor
{
    public const DEFAULT_CHUNK = 1048576;
    private const MAGIC = 'IMSENC1';

    public static function key(string $keyB64): string
    {
        $key = base64_decode(trim($keyB64), true);
        if ($key === false || strlen($key) !== 32) {
            throw new \InvalidArgumentException('Encryption key must be 32 bytes (base64)');
        }
        return $key;
    }

    public static function encryptFile(string $in, string $out, string $keyB64, int $chunkSize = self::DEFAULT_CHUNK, ?string $noncePrefix = null): void
    {
        $key = self::key($keyB64);
        $noncePrefix = $noncePrefix ?? random_bytes(8);
        $header = self::MAGIC . chr(1) . pack('N', $chunkSize) . $noncePrefix;
        $src = fopen($in, 'rb');
        $dst = fopen($out, 'wb');
        if (!$src || !$dst) {
            throw new \RuntimeException('Cannot open files for encryption');
        }
        try {
            fwrite($dst, $header);
            $counter = 0;
            $current = self::readChunk($src, $chunkSize);
            do {
                $next = feof($src) ? '' : self::readChunk($src, $chunkSize);
                $final = $next === '' && feof($src);
                $tag = '';
                $ct = openssl_encrypt($current, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $noncePrefix . pack('N', $counter), $tag, $header . pack('N', $counter) . chr($final ? 1 : 0), 16);
                if ($ct === false) {
                    throw new \RuntimeException('Encryption failed');
                }
                fwrite($dst, pack('N', strlen($current)) . $ct . $tag);
                $counter++;
                $current = $next;
            } while (!$final);
        } finally {
            fclose($src);
            fclose($dst);
        }
    }

    public static function decryptFile(string $in, string $out, string $keyB64): void
    {
        $key = self::key($keyB64);
        $src = fopen($in, 'rb');
        $dst = fopen($out, 'wb');
        if (!$src || !$dst) {
            throw new \RuntimeException('Cannot open files for decryption');
        }
        try {
            $header = fread($src, 20);
            if ($header === false || strlen($header) !== 20 || substr($header, 0, 7) !== self::MAGIC || ord($header[7]) !== 1) {
                throw new \RuntimeException('Not an IMS encrypted archive');
            }
            $chunkSize = unpack('N', substr($header, 8, 4))[1];
            $noncePrefix = substr($header, 12, 8);
            $counter = 0;
            $finished = false;
            while (true) {
                $lenBytes = fread($src, 4);
                if ($lenBytes === '' || $lenBytes === false) {
                    break;
                }
                if ($finished) {
                    throw new \RuntimeException('Data after the final record');
                }
                $len = unpack('N', $lenBytes)[1];
                if ($len > $chunkSize) {
                    throw new \RuntimeException('Record larger than chunk size');
                }
                $ct = $len > 0 ? self::readExactly($src, $len) : '';
                $tag = self::readExactly($src, 16);
                $plain = false;
                foreach ([0, 1] as $flag) {
                    $plain = openssl_decrypt($ct, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $noncePrefix . pack('N', $counter), $tag, $header . pack('N', $counter) . chr($flag));
                    if ($plain !== false) {
                        $finished = $flag === 1;
                        break;
                    }
                }
                if ($plain === false) {
                    throw new \RuntimeException('Authentication failed: wrong key or corrupted archive');
                }
                fwrite($dst, $plain);
                $counter++;
            }
            if (!$finished) {
                throw new \RuntimeException('Encrypted archive is truncated');
            }
        } finally {
            fclose($src);
            fclose($dst);
        }
    }

    /** @param resource $h */
    private static function readChunk($h, int $size): string
    {
        $buf = '';
        while (strlen($buf) < $size && !feof($h)) {
            $part = fread($h, $size - strlen($buf));
            if ($part === false) {
                break;
            }
            $buf .= $part;
        }
        return $buf;
    }

    /** @param resource $h */
    private static function readExactly($h, int $n): string
    {
        $data = self::readChunk($h, $n);
        if (strlen($data) !== $n) {
            throw new \RuntimeException('Encrypted archive is truncated');
        }
        return $data;
    }
}
