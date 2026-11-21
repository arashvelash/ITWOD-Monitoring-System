<?php

declare(strict_types=1);

use Ims\Agent\Protocol;

echo "Protocol (shared vectors)\n";
$v = T::vectors();
$secret = $v['nodeSecret'];

T::test('HTTP canonical strings and HMAC match the vectors', static function () use ($v, $secret) {
    foreach ($v['http'] as $h) {
        $canonical = Protocol::canonicalHttp($h['method'], $h['path'], $h['timestamp'], $h['nonce'], $h['body']);
        T::eq($h['canonical'], $canonical);
        T::eq($h['signature'], Protocol::hmac($secret, $canonical));
    }
});

T::test('Ed25519 signatures match the vectors (libsodium)', static function () use ($v) {
    if (!Protocol::sodiumAvailable()) {
        echo "    (skipped: libsodium not available)\n";
        return;
    }
    $kp = sodium_crypto_sign_seed_keypair(hex2bin($v['ed25519']['seedHex']));
    T::eq($v['ed25519']['publicKeyBase64'], base64_encode(sodium_crypto_sign_publickey($kp)));
    $sk = base64_encode(sodium_crypto_sign_secretkey($kp));
    foreach ($v['http'] as $h) {
        T::eq($h['keySignature'], Protocol::signEd25519($sk, $h['canonical']));
    }
});

T::test('verifies a genuine command and rejects tampering', static function () use ($v, $secret) {
    $c = $v['command'];
    T::eq($c['canonical'], Protocol::canonicalCommand($c['id'], $c['command'], $c['issuedAt'], $c['expiresAt'], $c['payload']));
    $cmd = ['type' => 'command', 'id' => $c['id'], 'command' => $c['command'], 'issuedAt' => $c['issuedAt'], 'expiresAt' => $c['expiresAt'], 'payload' => $c['payload'], 'signature' => $c['signature']];
    $ok = Protocol::verifyCommand($secret, $cmd, $c['issuedAt'] + 5);
    T::true($ok['ok'] === true, 'command should verify');
    T::eq('backup.run', $ok['type']);
    $bad = $cmd;
    $bad['payload'] = str_replace('1111', '2222', $bad['payload']);
    T::eq('invalid signature', Protocol::verifyCommand($secret, $bad, $c['issuedAt'] + 5)['reason']);
    T::eq('command expired', Protocol::verifyCommand($secret, $cmd, $c['expiresAt'] + 1)['reason']);
});

T::test('refuses signed commands outside the allow-list', static function () use ($secret) {
    $now = time();
    $cmd = ['id' => 'x', 'command' => 'shell.exec', 'issuedAt' => $now, 'expiresAt' => $now + 60, 'payload' => '{}'];
    $cmd['signature'] = Protocol::hmac($secret, Protocol::canonicalCommand('x', 'shell.exec', $now, $now + 60, '{}'));
    $res = Protocol::verifyCommand($secret, $cmd);
    T::true($res['ok'] === false && strpos($res['reason'], 'not allowed') !== false, 'must be rejected');
});

T::test('opens the config secrets envelope', static function () use ($v, $secret) {
    T::eq($v['configSecrets']['derivedKeyHex'], bin2hex(Protocol::deriveConfigKey($secret)));
    T::eq(json_decode($v['configSecrets']['plaintext'], true), Protocol::openConfigSecrets($secret, $v['configSecrets']['envelope']));
    T::throws(static function () use ($v) {
        Protocol::openConfigSecrets('imss_wrong', $v['configSecrets']['envelope']);
    });
});
