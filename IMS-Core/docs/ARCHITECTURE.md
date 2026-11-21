# IMS Architecture

ITWOD Monitoring System (IMS) is a private backup, monitoring and infrastructure
management platform. It is split into three repositories:

| Repository         | Role                                              | Stack                                   |
| ------------------ | ------------------------------------------------- | --------------------------------------- |
| `IMS-Core`         | Central management platform (API, UI, scheduler)  | NestJS, Prisma, PostgreSQL, Redis, React |
| `IMS-Agent`        | Node agent for Ubuntu servers                     | Node.js, TypeScript, PM2                |
| `IMS-CPanel-Agent` | Lightweight agent for shared hosting (no root)    | PHP 7.4+, cron                          |

## 1. Design principles

1. **Security > Features > Speed of development.**
2. **Outbound-only agents.** Core never opens connections to managed servers.
   Agents connect to Core over HTTPS / WSS. Managed servers need no open inbound port.
3. **No destructive capability.** The agent command set is a closed allow-list:
   `ping`, `backup.run`, `config.sync`, `monitor.collect`, `agent.update`.
   There is no shell execution, no file deletion, no database drop, no disk
   operations. The only files an agent ever removes are *its own* expired backup
   archives inside its own backup directory (retention), guarded by strict
   file-name and path checks.
4. **Core is the source of truth, agents are autonomous.** Backup jobs are defined
   in Core and synced to agents. Agents schedule jobs locally so backups keep
   running when Core is unreachable; results are queued and delivered later.
5. **Secrets are encrypted at rest** (AES-256-GCM with a master key that never
   touches the database) and are only delivered to the node that needs them.
6. **Low footprint.** The Ubuntu agent is a single bundled JS file with a small
   dependency set; the cPanel agent has zero Composer dependencies.

## 2. High-level topology

```
                         ┌───────────────────────────────────────────┐
                         │                 IMS-Core                  │
                         │               (itwodms.ir)                │
   Browser ── HTTPS ───▶ │  Caddy (TLS, static UI, reverse proxy)    │
   Telegram ◀─ HTTPS ─── │  NestJS API + WSS gateway + workers       │
                         │  PostgreSQL        Redis                  │
                         └───────────────▲───────────────▲───────────┘
                                         │ WSS + HTTPS   │ HTTPS (poll)
                           outbound only │               │ outbound only
                    ┌────────────────────┴──┐     ┌──────┴────────────────┐
                    │  IMS-Agent (Ubuntu)   │     │  IMS-CPanel-Agent     │
                    │  PM2 · non-root user  │     │  PHP · cron · no root │
                    └───────────────────────┘     └───────────────────────┘
```

## 3. IMS-Core

### 3.1 Runtime components (Docker Compose)

| Service    | Purpose                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| `init`     | One-shot container. Generates random secrets into the `ims-secrets` volume on first start. |
| `postgres` | PostgreSQL 17. Primary data store.                                      |
| `redis`    | Redis 7. Rate-limit counters, nonce replay cache, BullMQ queues, locks. |
| `backend`  | NestJS API (`/api/v1`), agent WebSocket gateway (`/ws/agent`), schedulers, Telegram bot. Runs migrations on start. |
| `web`      | Caddy. Automatic HTTPS, serves the built React UI, proxies `/api` and `/ws` to `backend`, serves `install-agent.sh`. |

Only `web` publishes ports (80/443). The database, Redis and backend are reachable
only on the internal Docker network.

### 3.2 Backend modules

```
backend/src
├── main.ts                 bootstrap: helmet, cookies, trust proxy, CORS off, WS attach
├── app.module.ts
├── config/                 typed + validated configuration (zod), *_FILE secret support
├── common/                 guards, decorators, pipes, filters, utils
├── prisma/                 PrismaService
├── redis/                  shared ioredis client, Redis-backed throttler storage
├── crypto/                 AES-256-GCM secret box, token generation, hashing, Ed25519 verify
├── audit/                  append-only audit log
├── auth/                   login, refresh rotation, logout, sessions, CSRF, JWT guard, RBAC
├── setup/                  first-run wizard (guarded by one-time setup token)
├── users/                  user management (ADMIN)
├── settings/               system settings (secret values encrypted)
├── servers/                server/node records, registration tokens, credentials
├── agent-api/              agent-facing HTTPS API (register, config, commands, reports, packages)
├── agent-gateway/          WSS gateway: auth handshake, heartbeat, command delivery
├── commands/               durable command queue (NodeCommand) with signing + expiry
├── projects/               projects (logical grouping of backup jobs)
├── backups/                backup jobs, runs, schedule/missed-run checks
├── monitoring/             metrics ingestion, retention cleanup, offline detection
├── alerts/                 alert engine (dedupe, open/resolve) and threshold settings
├── notifications/          BullMQ notification queue → channels
├── telegram/               bot (long polling), commands, account linking
├── updates/                Core update orchestration + agent release registry
├── dashboard/              aggregated overview endpoint
└── health/                 liveness / readiness
```

### 3.3 Data model (summary)

See `database/README.md` for the full entity description. Core entities:

- `User`, `Session`, `RefreshToken` — authentication and session management.
- `Server`, `NodeCredential`, `RegistrationToken` — node inventory and identity.
- `NodeCommand` — durable, signed, expiring commands for agents.
- `Project`, `BackupJob`, `BackupRun` — backup configuration and history.
- `NodeMetric`, `Alert` — monitoring time series and alert lifecycle.
- `TelegramLink`, `TelegramLinkCode` — Telegram account binding.
- `AuditLog`, `SystemSetting` — audit trail and configuration.
- `AgentRelease`, `CoreUpdate` — update system.

### 3.4 Authentication and sessions

- Passwords: **Argon2id** (m=19 MiB, t=2, p=1 — OWASP baseline), max 128 chars.
- Login returns a short-lived **JWT access token** (default 15 min, HS256,
  `iss`/`aud` checked) kept in memory by the UI only.
- A **refresh token** (256-bit random, stored as SHA-256 hash) is set as an
  `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth` cookie.
- Refresh tokens **rotate** on every use. Reuse of an already-rotated token
  (outside a 15 s multi-tab grace window) revokes the whole session.
- Sessions have an idle timeout (default 12 h) and an absolute lifetime (default 7 d).
- Cookie-authenticated endpoints (`refresh`, `logout`) require a double-submit
  **CSRF token** (`ims_csrf` cookie + `X-CSRF-Token` header) and an Origin check.
- Account lockout: 5 failed attempts → 15 min lock. Unknown users are verified
  against a dummy hash to keep response timing uniform.
- Roles: `ADMIN` (everything, including users, settings, Telegram, revocation and
  updates), `OPERATOR` (servers, backup jobs, runs, alerts; can view update status),
  `VIEWER` (read-only).

### 3.5 Node identity and registration

1. Admin creates a server in the dashboard (name, type, OS).
2. Core generates a **Node ID** (`ims-node-0001`) and a **registration token**
   (`imsr_…`, 192-bit, one-time, default 24 h expiry, stored hashed).
3. The admin runs the one-line installer on the server and pastes Core URL + token.
4. The agent generates an **Ed25519 key pair** locally (private key never leaves the node)
   and calls `POST /api/v1/agent/register` with the token and its public key.
5. Core atomically consumes the token, generates the node **secret key**
   (`imss_…`, 256-bit), stores it AES-256-GCM encrypted, stores the public key
   and its fingerprint (certificate information) and returns the secret once.
6. Every subsequent request/connection is authenticated with **two proofs**:
   HMAC-SHA256 with the node secret *and* an Ed25519 signature with the node key,
   plus timestamp (±300 s) and nonce (replay cache in Redis).

The admin never sees the permanent secret; it only exists encrypted in Core and
on the node (`0600`). Revoking a node invalidates its credentials immediately
(open WebSocket is closed) without touching the server itself.

### 3.6 Communication

| Channel          | Used by              | Purpose                                                  |
| ---------------- | -------------------- | -------------------------------------------------------- |
| `WSS /ws/agent`  | Ubuntu agent         | Auth handshake, heartbeat, metrics, real-time commands, results |
| `HTTPS /api/v1/agent/*` | both agents   | Registration, config fetch, command polling, batched reports, package download |

Commands from Core are **signed** with the node secret (HMAC over a canonical
string that includes command id, type, timestamps and payload hash) and carry an
expiry. Agents reject unsigned, expired, replayed or unknown command types.
Full details: [`PROTOCOL.md`](./PROTOCOL.md).

### 3.7 Backups

- Job types: `FILES` (tar + gzip), `MYSQL` (`mysqldump`), `POSTGRES` (`pg_dump`).
- Destinations: `LOCAL` (node disk, default `/var/backups/ims`) and `S3`
  (any S3-compatible storage, multipart streaming upload).
- Optional client-side encryption (AES-256-GCM, per-job random key held encrypted in Core).
- SHA-256 checksum computed while streaming; reported to Core.
- Retention: keep last *N* archives and/or archives younger than *D* days, applied
  **only** to files created by IMS for that job (strict name pattern + directory check).
- Scheduling: 5-field cron expressions with time zone, evaluated on the agent.
  Core detects **missed** backups (no run after the scheduled time + grace period).
- Credentials (DB password, S3 keys, encryption key) are sent to the node inside
  the config payload encrypted with a key derived from the node secret (HKDF).

### 3.8 Monitoring and alerts

Agents report heartbeat (30 s) and metrics (60 s): CPU, load, memory, swap, disks,
network throughput, uptime and the state of configured systemd services.
Core stores samples (default retention 30 days), evaluates thresholds and manages
alerts: `NODE_OFFLINE`, `CPU_HIGH`, `MEMORY_HIGH`, `DISK_HIGH`, `SERVICE_DOWN`,
`BACKUP_FAILED`, `BACKUP_MISSED`, `AGENT_UPDATE_FAILED`. Alerts are de-duplicated
by fingerprint and auto-resolve when the condition clears.

### 3.9 Telegram

The bot uses long polling (no inbound webhook needed). Only chats linked to an IMS
user (one-time link code generated in the dashboard) can use it, and the user's role
applies: viewers can read status; operators can additionally trigger a backup run
(with inline confirmation). There are no destructive bot commands.
Notifications are delivered through a BullMQ queue with retries.

### 3.10 Updates

- **Core update:** the dashboard compares the running version with the latest
  release of the private GitHub repository and writes an update *request* to the
  shared `data/update` directory. A host-side systemd path unit
  (`ims-updater.path`) runs `scripts/update.sh`, which: checks the version → backs up
  configuration, secrets and database → fetches the tag → rebuilds images → runs
  migrations → restarts → health-checks, and **rolls back automatically** on failure.
  Containers never get access to the Docker socket.
- **Agent update:** Core keeps a registry of agent releases (synced from the private
  GitHub repository or uploaded). An `agent.update` command carries version, size and
  SHA-256 (plus optional Ed25519 release signature). The agent downloads the package
  from Core, verifies it, installs it side-by-side, switches the `current` symlink and
  restarts through PM2. A stable launcher rolls back automatically if the new version
  crashes three times or fails to reconnect within 5 minutes.

## 4. IMS-Agent (Ubuntu)

```
IMS-Agent
├── src/        entry point, config, logger, Core client (HTTPS + WSS), protocol, crypto
├── services/   agent orchestration: connection, scheduler, backup runner, monitor, outbox
├── modules/    backup sources (files/mysql/postgres), destinations (local/s3),
│               encryption stream, retention, metric collectors
├── updater/    launcher (rollback guard) and update installer
├── installer/  install.sh, uninstall.sh, ims-agent.sh (CLI wrapper), PM2 ecosystem file
└── tests/
```

- Runs as the unprivileged `ims-agent` user under PM2 (`max_memory_restart`,
  exponential restart back-off, log rotation).
- Read access to backup sources is granted explicitly (ACLs / group membership).
- State: `/etc/ims-agent` (identity, `0600`), `/var/lib/ims-agent` (config cache,
  outbox, update state), `/var/backups/ims` (local archives).

## 5. IMS-CPanel-Agent (shared hosting)

- PHP 7.4+ with no Composer dependencies; runs from cron every 5 minutes.
- Lives outside `public_html`; config directory protected (`0700`, deny-all `.htaccess`).
- Each run: lock → heartbeat + metrics → fetch config/commands → run due backups
  (PDO-based MySQL dump or `mysqldump` when allowed; ZipArchive/PharData for files)
  → upload to destination → apply retention → report.
- Authentication is identical to the Ubuntu agent over HTTPS (HMAC + Ed25519 via
  libsodium when available).

## 6. Security boundaries summary

| Threat                              | Mitigation                                                  |
| ----------------------------------- | ----------------------------------------------------------- |
| Core compromise → pivot to servers  | Agents accept only allow-listed, signed, non-destructive commands |
| Stolen registration token           | One-time, short expiry, hashed at rest, rate-limited endpoint |
| Replay of agent requests            | Timestamp window + Redis nonce cache                        |
| DB dump leak                        | Secrets AES-256-GCM encrypted; master key outside DB; token/password hashes only |
| XSS / CSRF                          | React escaping, strict CSP, in-memory access token, SameSite=Strict + double-submit CSRF |
| Brute force                         | Redis rate limits, account lockout, Argon2id               |
| Malicious update package            | SHA-256 + optional Ed25519 release signature, automatic rollback |
| First-boot takeover                 | Setup wizard requires the one-time setup token from the secrets volume |
