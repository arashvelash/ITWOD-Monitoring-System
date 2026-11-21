# IMS Agent ↔ Core Protocol (v1)

This document is normative for `IMS-Core`, `IMS-Agent` and `IMS-CPanel-Agent`.
Shared test vectors live in `tests/vectors/protocol-v1.json`; every implementation
must pass them.

All connections are initiated by the agent. Transport is TLS only (HTTPS / WSS);
agents refuse plain `http://` Core URLs unless `IMS_ALLOW_INSECURE_CORE=true`
(development only).

## 1. Identifiers and credentials

| Item               | Format                                   | Stored in Core            |
| ------------------ | ---------------------------------------- | ------------------------- |
| Node ID            | `ims-node-` + 4+ digit serial            | plain                     |
| Registration token | `imsr_` + base64url(24 random bytes)     | SHA-256 hex               |
| Node secret        | `imss_` + base64url(32 random bytes)     | AES-256-GCM encrypted     |
| Node key           | Ed25519; public key = base64(raw 32 bytes) | plain + fingerprint     |
| Nonce              | 32 lowercase hex chars (16 random bytes) | Redis, TTL 900 s          |

The HMAC key is the **UTF-8 bytes of the full node secret string** (including the
`imss_` prefix). Key fingerprint = `SHA256:` + lowercase hex SHA-256 of the raw
32-byte public key.

## 2. Registration

`POST /api/v1/agent/register` (unauthenticated, rate limited)

```json
{
  "registrationToken": "imsr_…",
  "publicKey": "base64 raw ed25519 public key (32 bytes)",
  "agentType": "UBUNTU" | "CPANEL",
  "agentVersion": "1.0.0",
  "hostname": "web-01",
  "os": "Ubuntu 24.04.1 LTS",
  "arch": "x64"
}
```

Response `201`:

```json
{
  "nodeId": "ims-node-0001",
  "nodeSecret": "imss_…",
  "keyFingerprint": "SHA256:…",
  "heartbeatIntervalSec": 30,
  "metricsIntervalSec": 60,
  "wsPath": "/ws/agent"
}
```

The token is consumed atomically (single `UPDATE … WHERE used_at IS NULL AND
expires_at > now()`); it is invalid afterwards. `agentType` must match the server
type chosen in the dashboard. `publicKey` is optional **only** for `CPANEL`
agents on hosts without libsodium; such nodes are flagged as `HMAC-only`.

## 3. HTTPS request signing

Every agent request after registration carries:

| Header               | Value                                         |
| -------------------- | --------------------------------------------- |
| `X-IMS-Node-Id`      | node id                                       |
| `X-IMS-Timestamp`    | Unix time, seconds                            |
| `X-IMS-Nonce`        | 32 hex chars                                  |
| `X-IMS-Signature`    | lowercase hex HMAC-SHA256(secret, canonical)  |
| `X-IMS-Key-Signature`| base64 Ed25519 signature of `canonical`       |

Canonical request string (lines joined with `\n`, no trailing newline):

```
IMS1-HMAC-SHA256
<HTTP METHOD, upper case>
<request path including query string, exactly as sent>
<timestamp>
<nonce>
<lowercase hex SHA-256 of the raw request body; hash of empty string if none>
```

Core rejects the request when: node unknown/revoked, `|now - timestamp| > 300`,
nonce already seen, HMAC mismatch, or key signature missing/invalid for a node
with a registered public key. Comparisons are constant-time.

## 4. WebSocket session (Ubuntu agent)

URL: `wss://<core>/ws/agent`. Max frame 1 MiB. All frames are JSON text:
`{"type": "...", ...}`.

### 4.1 Handshake

The first frame must arrive within 10 s:

```json
{
  "type": "auth",
  "nodeId": "ims-node-0001",
  "ts": 1767225600,
  "nonce": "0123456789abcdef0123456789abcdef",
  "signature": "<hex HMAC-SHA256(secret, canonical)>",
  "keySignature": "<base64 Ed25519(canonical)>",
  "agentVersion": "1.0.0"
}
```

Canonical: `IMS1-WS-AUTH\n<nodeId>\n<ts>\n<nonce>`

Success → `{"type":"auth.ok","serverTime":<unix>,"heartbeatIntervalSec":30,"metricsIntervalSec":60,"configVersion":<int>}`.
Failure → close code `4401`. A newer connection for the same node replaces the
older one (close code `4409`). Revocation closes with `4403`.

### 4.2 Agent → Core frames

| type             | payload fields                                                      |
| ---------------- | ------------------------------------------------------------------- |
| `heartbeat`      | `uptimeSec`, `agentVersion`, `hostname`, `os`                       |
| `metrics`        | `data` (see §6)                                                     |
| `command.ack`    | `commandId`                                                         |
| `command.result` | `commandId`, `status` (`SUCCEEDED`/`FAILED`), `result?`, `error?`   |
| `backup.report`  | `data` (see §7)                                                     |

### 4.3 Core → Agent frames

| type              | meaning                                                 |
| ----------------- | ------------------------------------------------------- |
| `heartbeat.ack`   | `serverTime`, `configVersion`                           |
| `command`         | signed command (§5)                                     |
| `error`           | `code`, `message` (non-fatal)                           |

WebSocket ping/pong is used for liveness (Core pings every 25 s, terminates after 2 missed pongs).

## 5. Commands

```json
{
  "type": "command",
  "id": "uuid",
  "command": "backup.run",
  "issuedAt": 1767225600,
  "expiresAt": 1767226500,
  "payload": "{\"jobId\":\"…\",\"runId\":\"…\"}",
  "signature": "<hex HMAC-SHA256(secret, canonical)>"
}
```

`payload` is a **JSON string**; the signature covers its exact bytes, so no
canonical JSON is required. Canonical:

```
IMS1-COMMAND
<id>
<command>
<issuedAt>
<expiresAt>
<lowercase hex SHA-256 of payload string>
```

Allowed commands (anything else is rejected by agents):

| command           | payload                                         | effect                           |
| ----------------- | ----------------------------------------------- | -------------------------------- |
| `ping`            | `{}`                                            | returns agent status             |
| `config.sync`     | `{}`                                            | re-fetches `/agent/config`       |
| `monitor.collect` | `{}`                                            | sends a metrics sample now       |
| `backup.run`      | `{"jobId","runId"}`                             | runs one configured job now      |
| `agent.update`    | `{"version","sha256","sizeBytes","signature?"}` | downloads + installs agent release |

Agents keep executed command ids for 24 h and ignore duplicates.

HTTP agents (cPanel) receive the same objects from `GET /api/v1/agent/commands`.

## 6. Metrics sample

```json
{
  "collectedAt": "2026-01-01T00:00:00.000Z",
  "cpu": { "percent": 12.5, "cores": 4, "load": [0.2, 0.3, 0.1] },
  "memory": { "totalBytes": 8000000000, "usedBytes": 3000000000, "availableBytes": 5000000000 },
  "swap": { "totalBytes": 0, "usedBytes": 0 },
  "disks": [{ "mount": "/", "fs": "ext4", "totalBytes": 1, "usedBytes": 1 }],
  "network": { "rxBytesPerSec": 1000, "txBytesPerSec": 2000 },
  "uptimeSec": 12345,
  "services": [{ "name": "nginx", "active": true, "state": "active" }]
}
```

All fields except `collectedAt` are optional (cPanel agents report what the host allows).

## 7. Backup report

```json
{
  "runId": "uuid (generated by the agent for scheduled runs)",
  "jobId": "uuid",
  "trigger": "SCHEDULED" | "MANUAL" | "TELEGRAM",
  "status": "RUNNING" | "SUCCESS" | "FAILED",
  "startedAt": "ISO-8601",
  "finishedAt": "ISO-8601?",
  "sizeBytes": 123,
  "checksumSha256": "hex?",
  "fileName": "ims-<jobslug>-20260101T000000Z.tar.gz.enc",
  "location": "local:/var/backups/ims/<jobId>/… | s3://bucket/key",
  "encrypted": true,
  "error": "string?",
  "logTail": "string? (max 8 KiB)"
}
```

Reports are idempotent on `runId`. Agents persist unsent reports in an outbox and
deliver them via `POST /api/v1/agent/reports` (`{"reports":[{"type","data"}]}`, max 100).

## 8. Agent configuration

`GET /api/v1/agent/config` →

```json
{
  "configVersion": 7,
  "heartbeatIntervalSec": 30,
  "metricsIntervalSec": 60,
  "monitoring": { "services": ["nginx", "mysql"] },
  "backup": { "localDirectory": "/var/backups/ims" },
  "jobs": [
    {
      "id": "uuid", "name": "Site files", "slug": "site-files", "type": "FILES",
      "enabled": true, "schedule": "0 3 * * *", "timezone": "Asia/Tehran",
      "timeoutMinutes": 120, "compressionLevel": 6,
      "source": { "paths": ["/var/www/site"], "excludes": ["*.log"] },
      "destination": { "type": "LOCAL" },
      "retention": { "count": 7, "days": null },
      "encryption": { "enabled": true }
    }
  ],
  "secrets": { "alg": "A256GCM", "iv": "b64", "tag": "b64", "data": "b64" }
}
```

`secrets` decrypts to `{"<jobId>": {"dbPassword"?, "s3AccessKeyId"?, "s3SecretAccessKey"?, "encryptionKey"?}}`.
Key = HKDF-SHA256(ikm = UTF-8 node secret, salt = `"ims-v1"`, info = `"config-secrets"`, length 32).
AES-256-GCM, 12-byte IV, 16-byte tag, no AAD.

## 9. Backup archive encryption format

Chunked AES-256-GCM so archives of any size can be encrypted and decrypted as a
stream with every chunk authenticated (also possible in PHP without loading the
whole archive into memory).

```
header (20 bytes) = "IMSENC1" | 0x01 (version) | chunkSize uint32 BE | noncePrefix (8 random bytes)
record            = plaintextLength uint32 BE | ciphertext | GCM tag (16 bytes)
nonce(i)          = noncePrefix || uint32 BE i            (i = 0, 1, 2, ...)
AAD(i)            = header || uint32 BE i || flag          (flag 0x01 on the last record, else 0x00)
```

The plaintext is split into consecutive `chunkSize` slices (default 1 MiB); the
last slice carries the final flag (an empty plaintext produces one empty final
record). Decryption fails on a bad tag, a missing final record (truncation) or
trailing data after it. Key: 32 bytes, base64 in `encryptionKey`. Decrypt with
`ims-agent decrypt` or the cPanel agent's `cron/decrypt.php`.

## 10. Agent update package

`GET /api/v1/agent/releases/<version>/package` (signed request) returns
`ims-agent-<version>.tgz`. Agents verify size, SHA-256 and — when a release public
key is pinned (`IMS_RELEASE_PUBLIC_KEY`) — the Ed25519 signature over the raw
SHA-256 hex string before installing.
