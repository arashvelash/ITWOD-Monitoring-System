# Configuration

IMS-Core has two configuration layers:

1. **Environment** (`.env`, read by Docker Compose) – infrastructure: domain, ports, logging. Infrastructure secrets are generated automatically and are *not* part of `.env`.
2. **Dashboard settings** (stored in PostgreSQL, validated with schemas) – everything an administrator may change at runtime.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `IMS_DOMAIN` | `itwodms.ir` | Domain served by Caddy; a Let's Encrypt certificate is requested for it. `localhost` uses Caddy's internal CA. |
| `ACME_EMAIL` | `admin@itwodms.ir` | Contact address for the ACME account. |
| `IMS_PUBLIC_URL` | `https://itwodms.ir` | Public URL used for links, the agent install command and `Origin` checks. Must be `https://`. |
| `HTTP_PORT` / `HTTPS_PORT` | `80` / `443` | Host ports published by the `web` service. |
| `LOG_LEVEL` | `log` | `error`, `warn`, `log`, `debug`, `verbose`. Production logs are JSON. |
| `ACCESS_TOKEN_TTL_SEC` | `900` | Dashboard access token lifetime (60–3600). |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | Custom Bot API endpoint (self-hosted Bot API server / relay). |

Set by `docker-compose.yml` (normally not changed): `NODE_ENV=production`, `PORT=3000`, `DATA_DIR=/app/data`, `TRUST_PROXY="loopback, uniquelocal"`, `*_FILE` variables pointing to `/run/ims-secrets/*`.

Non-Docker/development only: `DATABASE_URL`, `REDIS_URL`, `IMS_MASTER_KEY` (base64 or hex, 32 bytes), `JWT_ACCESS_SECRET` (≥ 32 chars), `IMS_SETUP_TOKEN`, `COOKIE_SECURE=false` (plain-HTTP localhost only), `IMS_VERSION`. Every secret may also be given as `<NAME>_FILE`.

Host updater (environment of `ims-updater.service`, optional): `IMS_HEALTH_TIMEOUT` (seconds, default 240), `IMS_REQUIRE_SIGNED_TAGS=1`. Add them with `systemctl edit ims-updater.service`.

Apply changes to `.env` with `docker compose up -d`.

### Generated secrets (`ims-secrets` volume)

| File | Content |
| --- | --- |
| `postgres_password`, `redis_password` | 24 random bytes, hex |
| `master_key` | 32 random bytes, base64 – encrypts all secrets stored in the database |
| `jwt_access_secret` | 48 random bytes, hex |
| `setup_token` | 24 random bytes, hex – only used by the first-run wizard |

Files are created only when missing; they are never rotated automatically.

## Dashboard settings

**Settings** (administrators):

| Section | Setting | Default | Range |
| --- | --- | --- | --- |
| General | Instance name | ITWOD Monitoring System | 1–64 chars |
| | Public URL | – | https URL, overrides `IMS_PUBLIC_URL` in links |
| | Timezone | UTC | IANA name, default for new backup jobs |
| Security | Session idle timeout | 12 h | 1–168 h |
| | Session absolute lifetime | 7 days | 1–90 days |
| | Registration token validity | 24 h | 1–168 h |
| | Failed logins before lockout | 5 | 3–20 |
| | Lockout duration | 15 min | 1–1440 min |
| Monitoring | Offline after | 180 s | 60–3600 s (cPanel agents: at least 17 min because they report every 5 min) |
| | Metrics retention | 30 days | 1–365 days |
| | CPU threshold / sustain | 90 % for 5 min | 10–100 % / 1–60 min |
| | Memory threshold | 90 % | 10–100 % |
| | Disk threshold | 90 % | 10–100 % (per mount) |
| | Missed backup grace | 120 min | 10–1440 min |
| | Default watched services | – | up to 30 systemd unit names |

Per server (**Servers › server › Settings**): watched systemd services (overrides the default list).

**Telegram** (administrators): bot token (encrypted), enable/disable, notification categories (alerts, failed backups, successful backups, node online/offline), additional notification-only chat IDs.

**Updates › Release source** (administrators): GitHub API base URL, Core repository, agent repository, access token (encrypted).

## Data directory (`./data`)

| Path | Purpose |
| --- | --- |
| `data/update/` | Update request/status files shared with the host updater, `last-run.log` |
| `data/agent-releases/<version>/` | Stored agent packages |
| `data/core-backups/` | Output of `backup-core-db.sh` (0700) |
| `data/tmp/` | Temporary uploads (cleaned automatically) |

## Housekeeping

Daily at 03:17 (server time) Core removes metrics older than the retention period, expired refresh tokens, sessions ended more than 30 days ago, used/expired link and registration tokens older than 30 days, completed commands older than 90 days and alerts resolved more than a year ago. Audit logs and backup run history are kept.
