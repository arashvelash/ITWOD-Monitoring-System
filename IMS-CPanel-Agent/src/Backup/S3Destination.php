<?php

declare(strict_types=1);

namespace Ims\Agent\Backup;

/**
 * S3-compatible storage using AWS Signature V4 over HTTPS with curl
 * (no SDK). Uploads use a single streaming PUT (max 5 GB per archive).
 */
final class S3Destination implements Destination
{
    private const MAX_PUT = 5 * 1024 * 1024 * 1024;

    /** @var array<string,mixed> */
    private $cfg;
    /** @var string */
    private $slug;
    /** @var string */
    private $prefix;

    /** @param array<string,mixed> $cfg bucket, region, endpoint?, prefix?, forcePathStyle?, accessKeyId, secretAccessKey */
    public function __construct(array $cfg, string $slug)
    {
        Naming::assertSlug($slug);
        if (empty($cfg['bucket']) || empty($cfg['accessKeyId']) || empty($cfg['secretAccessKey'])) {
            throw new \InvalidArgumentException('S3 bucket and credentials are required');
        }
        $prefix = ltrim((string) ($cfg['prefix'] ?? ''), '/');
        if (in_array('..', explode('/', $prefix), true)) {
            throw new \InvalidArgumentException('Invalid S3 prefix');
        }
        $this->prefix = ($prefix !== '' && substr($prefix, -1) !== '/' ? $prefix . '/' : $prefix) . $slug . '/';
        $this->cfg = $cfg + ['region' => 'us-east-1', 'endpoint' => null, 'forcePathStyle' => false];
        $this->slug = $slug;
    }

    public function prepare(): void
    {
        $this->request('HEAD', '', []);
    }

    public function store(string $file, string $name): string
    {
        $size = filesize($file);
        if ($size === false || $size > self::MAX_PUT) {
            throw new \RuntimeException('Archive exceeds the 5 GB single-upload limit of the cPanel agent');
        }
        $key = $this->key($name);
        $fh = fopen($file, 'rb');
        try {
            $this->request('PUT', $key, [], $fh, (int) $size);
        } finally {
            fclose($fh);
        }
        @unlink($file);
        return 's3://' . $this->cfg['bucket'] . '/' . $key;
    }

    public function list(): array
    {
        $names = [];
        $token = null;
        do {
            $query = ['list-type' => '2', 'prefix' => $this->prefix];
            if ($token) {
                $query['continuation-token'] = $token;
            }
            $xml = $this->request('GET', '', $query);
            preg_match_all('#<Key>([^<]+)</Key>#', $xml, $m);
            foreach ($m[1] as $key) {
                $name = substr(html_entity_decode($key, ENT_XML1), strlen($this->prefix));
                if (strpos($name, '/') === false && preg_match(Naming::pattern($this->slug), $name)) {
                    $names[] = $name;
                }
            }
            $token = preg_match('#<IsTruncated>true</IsTruncated>#', $xml) && preg_match('#<NextContinuationToken>([^<]+)</NextContinuationToken>#', $xml, $t) ? html_entity_decode($t[1], ENT_XML1) : null;
        } while ($token);
        return $names;
    }

    public function remove(string $name): void
    {
        $this->request('DELETE', $this->key($name), []);
    }

    private function key(string $name): string
    {
        if (!preg_match(Naming::pattern($this->slug), $name)) {
            throw new \RuntimeException("Refusing to touch non-IMS object {$name}");
        }
        return $this->prefix . $name;
    }

    /**
     * @param array<string,string> $query
     * @param resource|null $body
     */
    private function request(string $method, string $key, array $query, $body = null, int $size = 0): string
    {
        $region = (string) $this->cfg['region'];
        $bucket = (string) $this->cfg['bucket'];
        if (!empty($this->cfg['endpoint'])) {
            $endpoint = rtrim((string) $this->cfg['endpoint'], '/');
            if (strpos($endpoint, 'https://') !== 0) {
                throw new \RuntimeException('S3 endpoint must use https');
            }
        } else {
            $endpoint = 'https://s3.' . $region . '.amazonaws.com';
        }
        $pathStyle = !empty($this->cfg['forcePathStyle']) || !empty($this->cfg['endpoint']);
        $parts = parse_url($endpoint);
        $host = $pathStyle ? $parts['host'] : $bucket . '.' . $parts['host'];
        if (isset($parts['port'])) {
            $host .= ':' . $parts['port'];
        }
        if ($key === '') {
            $uri = $pathStyle ? '/' . rawurlencode($bucket) : '/';
        } else {
            $encodedKey = implode('/', array_map('rawurlencode', explode('/', $key)));
            $uri = ($pathStyle ? '/' . rawurlencode($bucket) : '') . '/' . $encodedKey;
        }
        ksort($query);
        $qs = implode('&', array_map(static function ($k, $v) {
            return rawurlencode((string) $k) . '=' . rawurlencode((string) $v);
        }, array_keys($query), $query));

        $amzDate = gmdate('Ymd\THis\Z');
        $date = substr($amzDate, 0, 8);
        $headers = ['host' => $host, 'x-amz-content-sha256' => 'UNSIGNED-PAYLOAD', 'x-amz-date' => $amzDate];
        ksort($headers);
        $canonicalHeaders = '';
        foreach ($headers as $k => $v) {
            $canonicalHeaders .= $k . ':' . $v . "\n";
        }
        $signedHeaders = implode(';', array_keys($headers));
        $canonical = implode("\n", [$method, $uri, $qs, $canonicalHeaders, $signedHeaders, 'UNSIGNED-PAYLOAD']);
        $scope = "{$date}/{$region}/s3/aws4_request";
        $toSign = "AWS4-HMAC-SHA256\n{$amzDate}\n{$scope}\n" . hash('sha256', $canonical);
        $k = hash_hmac('sha256', $date, 'AWS4' . $this->cfg['secretAccessKey'], true);
        $k = hash_hmac('sha256', $region, $k, true);
        $k = hash_hmac('sha256', 's3', $k, true);
        $k = hash_hmac('sha256', 'aws4_request', $k, true);
        $signature = hash_hmac('sha256', $toSign, $k);
        $auth = "AWS4-HMAC-SHA256 Credential={$this->cfg['accessKeyId']}/{$scope}, SignedHeaders={$signedHeaders}, Signature={$signature}";

        $url = $parts['scheme'] . '://' . $host . $uri . ($qs !== '' ? '?' . $qs : '');
        $ch = curl_init($url);
        $httpHeaders = ['Authorization: ' . $auth, 'x-amz-content-sha256: UNSIGNED-PAYLOAD', 'x-amz-date: ' . $amzDate];
        $opts = [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_CONNECTTIMEOUT => 20,
            CURLOPT_TIMEOUT => 0,
            CURLOPT_LOW_SPEED_LIMIT => 1024,
            CURLOPT_LOW_SPEED_TIME => 120,
        ];
        if ($method === 'HEAD') {
            $opts[CURLOPT_NOBODY] = true;
        }
        if ($body !== null) {
            $opts[CURLOPT_UPLOAD] = true;
            $opts[CURLOPT_INFILE] = $body;
            $opts[CURLOPT_INFILESIZE] = $size;
            $httpHeaders[] = 'Content-Type: application/octet-stream';
        }
        $opts[CURLOPT_HTTPHEADER] = $httpHeaders;
        curl_setopt_array($ch, $opts);
        $res = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($res === false) {
            throw new \RuntimeException('S3 request failed: ' . $err);
        }
        if ($status < 200 || $status >= 300) {
            $code = preg_match('#<Code>([^<]+)</Code>#', (string) $res, $m) ? $m[1] : 'HTTP ' . $status;
            throw new \RuntimeException("S3 {$method} failed: {$code}");
        }
        return (string) $res;
    }
}
