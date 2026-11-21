<?php

declare(strict_types=1);

namespace Ims\Agent;

/**
 * Signed HTTPS client for the IMS agent API (docs/PROTOCOL.md §3).
 * TLS certificates are always verified; plain HTTP is refused unless
 * IMS_ALLOW_INSECURE_CORE=true is set for local development.
 */
final class CoreClient
{
    /** @var array<string,string|null> */
    private $identity;

    /** @param array<string,string|null> $identity */
    public function __construct(array $identity)
    {
        $this->identity = $identity;
    }

    public static function normalizeUrl(string $raw): string
    {
        $raw = rtrim(trim($raw), '/');
        $allowInsecure = getenv('IMS_ALLOW_INSECURE_CORE') === 'true';
        $pattern = $allowInsecure ? '#^https?://[A-Za-z0-9.-]+(:\d{1,5})?$#' : '#^https://[A-Za-z0-9.-]+(:\d{1,5})?$#';
        if (!preg_match($pattern, $raw)) {
            throw new \InvalidArgumentException('Core URL must look like https://itwodms.ir');
        }
        return $raw;
    }

    /**
     * @param array<string,mixed>|null $body
     * @return array<string,mixed>
     */
    public function request(string $method, string $path, ?array $body = null, int $timeout = 60): array
    {
        $raw = $body === null ? '' : (string) json_encode($body, JSON_UNESCAPED_SLASHES);
        $ts = time();
        $nonce = Protocol::nonce();
        $canonical = Protocol::canonicalHttp($method, $path, $ts, $nonce, $raw);
        $headers = [
            'Accept: application/json',
            'X-IMS-Node-Id: ' . $this->identity['nodeId'],
            'X-IMS-Timestamp: ' . $ts,
            'X-IMS-Nonce: ' . $nonce,
            'X-IMS-Signature: ' . Protocol::hmac((string) $this->identity['nodeSecret'], $canonical),
        ];
        if (!empty($this->identity['secretKey']) && Protocol::sodiumAvailable()) {
            $headers[] = 'X-IMS-Key-Signature: ' . Protocol::signEd25519((string) $this->identity['secretKey'], $canonical);
        }
        if ($raw !== '') {
            $headers[] = 'Content-Type: application/json';
        }
        return self::send($method, $this->identity['coreUrl'] . $path, $headers, $raw, $timeout);
    }

    /**
     * Unauthenticated registration request.
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public static function register(string $coreUrl, array $body): array
    {
        return self::send('POST', $coreUrl . '/api/v1/agent/register', ['Content-Type: application/json', 'Accept: application/json'], (string) json_encode($body, JSON_UNESCAPED_SLASHES), 60);
    }

    /**
     * @param string[] $headers
     * @return array<string,mixed>
     */
    private static function send(string $method, string $url, array $headers, string $body, int $timeout): array
    {
        $ch = curl_init($url);
        $headers[] = 'User-Agent: ims-cpanel-agent/' . IMS_AGENT_VERSION;
        $opts = [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_PROTOCOLS => getenv('IMS_ALLOW_INSECURE_CORE') === 'true' ? (CURLPROTO_HTTPS | CURLPROTO_HTTP) : CURLPROTO_HTTPS,
        ];
        if ($body !== '') {
            $opts[CURLOPT_POSTFIELDS] = $body;
        }
        curl_setopt_array($ch, $opts);
        $response = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error = curl_error($ch);
        curl_close($ch);

        if ($response === false) {
            throw new CoreHttpException('Cannot reach Core: ' . $error);
        }
        $data = $response === '' ? [] : json_decode((string) $response, true);
        if ($status < 200 || $status >= 300) {
            $message = is_array($data) && isset($data['message']) ? (string) $data['message'] : 'HTTP ' . $status;
            throw new CoreHttpException("Core responded {$status}: {$message}", $status);
        }
        return is_array($data) ? $data : [];
    }
}
