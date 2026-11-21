<?php

declare(strict_types=1);

namespace Ims\Agent;

/**
 * IMS protocol v1 primitives - byte-compatible with IMS-Core and IMS-Agent
 * (verified against tests/vectors/protocol-v1.json).
 */
final class Protocol
{
    public const ALLOWED_COMMANDS = ['ping', 'config.sync', 'monitor.collect', 'backup.run', 'agent.update'];

    public static function canonicalHttp(string $method, string $path, int $ts, string $nonce, string $body): string
    {
        return implode("\n", ['IMS1-HMAC-SHA256', strtoupper($method), $path, (string) $ts, $nonce, hash('sha256', $body)]);
    }

    public static function canonicalCommand(string $id, string $command, int $issuedAt, int $expiresAt, string $payload): string
    {
        return implode("\n", ['IMS1-COMMAND', $id, $command, (string) $issuedAt, (string) $expiresAt, hash('sha256', $payload)]);
    }

    public static function hmac(string $secret, string $message): string
    {
        return hash_hmac('sha256', $message, $secret);
    }

    public static function nonce(): string
    {
        return bin2hex(random_bytes(16));
    }

    public static function sodiumAvailable(): bool
    {
        return function_exists('sodium_crypto_sign_detached') && function_exists('sodium_crypto_sign_keypair');
    }

    /** @return array{secretKey:string, publicKey:string} base64 encoded */
    public static function generateKeyPair(): array
    {
        $kp = sodium_crypto_sign_keypair();
        return [
            'secretKey' => base64_encode(sodium_crypto_sign_secretkey($kp)),
            'publicKey' => base64_encode(sodium_crypto_sign_publickey($kp)),
        ];
    }

    public static function signEd25519(string $secretKeyB64, string $message): string
    {
        return base64_encode(sodium_crypto_sign_detached($message, base64_decode($secretKeyB64, true)));
    }

    /**
     * Verifies a command from Core.
     * @param array<string,mixed> $cmd
     * @return array{ok:bool, reason?:string, type?:string, payload?:array}
     */
    public static function verifyCommand(string $secret, array $cmd, ?int $now = null, int $maxSkew = 300): array
    {
        $now = $now ?? time();
        foreach (['id', 'command', 'payload', 'signature'] as $f) {
            if (!isset($cmd[$f]) || !is_string($cmd[$f])) {
                return ['ok' => false, 'reason' => 'malformed command'];
            }
        }
        if (!is_int($cmd['issuedAt'] ?? null) || !is_int($cmd['expiresAt'] ?? null)) {
            return ['ok' => false, 'reason' => 'malformed timestamps'];
        }
        if (!preg_match('/^[0-9a-f]{64}$/', $cmd['signature'])) {
            return ['ok' => false, 'reason' => 'malformed signature'];
        }
        $expected = self::hmac($secret, self::canonicalCommand($cmd['id'], $cmd['command'], $cmd['issuedAt'], $cmd['expiresAt'], $cmd['payload']));
        if (!hash_equals($expected, $cmd['signature'])) {
            return ['ok' => false, 'reason' => 'invalid signature'];
        }
        if ($cmd['expiresAt'] < $now) {
            return ['ok' => false, 'reason' => 'command expired'];
        }
        if ($cmd['issuedAt'] > $now + $maxSkew) {
            return ['ok' => false, 'reason' => 'command issued in the future'];
        }
        if (!in_array($cmd['command'], self::ALLOWED_COMMANDS, true)) {
            return ['ok' => false, 'reason' => 'command "' . $cmd['command'] . '" is not allowed'];
        }
        $payload = json_decode($cmd['payload'], true);
        if (!is_array($payload)) {
            return ['ok' => false, 'reason' => 'payload must be an object'];
        }
        return ['ok' => true, 'type' => $cmd['command'], 'payload' => $payload];
    }

    public static function deriveConfigKey(string $nodeSecret): string
    {
        return hash_hkdf('sha256', $nodeSecret, 32, 'config-secrets', 'ims-v1');
    }

    /**
     * @param array{alg:string, iv:string, tag:string, data:string} $env
     * @return array<string,mixed>
     */
    public static function openConfigSecrets(string $nodeSecret, array $env): array
    {
        if (($env['alg'] ?? '') !== 'A256GCM') {
            throw new \RuntimeException('Unsupported secrets algorithm');
        }
        $plain = openssl_decrypt(
            (string) base64_decode($env['data'], true),
            'aes-256-gcm',
            self::deriveConfigKey($nodeSecret),
            OPENSSL_RAW_DATA,
            (string) base64_decode($env['iv'], true),
            (string) base64_decode($env['tag'], true)
        );
        if ($plain === false) {
            throw new \RuntimeException('Cannot decrypt configuration secrets');
        }
        $data = json_decode($plain, true);
        if (!is_array($data)) {
            throw new \RuntimeException('Configuration secrets are not valid JSON');
        }
        return $data;
    }
}
