# REST API

Base URL: `https://<domain>/api/v1`. All responses are JSON. Errors have the form `{ "statusCode", "message", "code?", "errors?": [{ "path", "message" }] }`.

## Authentication

Dashboard clients authenticate with `Authorization: Bearer <accessToken>`. Access tokens come from `POST /auth/login` and are renewed with `POST /auth/refresh` (refresh cookie + `X-CSRF-Token` header). Agent endpoints use signed requests (see [PROTOCOL.md](PROTOCOL.md)).

Minimum role per endpoint: **V** = Viewer, **O** = Operator, **A** = Admin, **P** = public, **N** = signed agent request.

## Endpoints

### Auth, setup, health

| Method | Path | Role | Description |
| --- | --- | --- | --- |
| GET | `/health` | P | Liveness + version |
| GET | `/health/ready` | P | Database and Redis reachable (503 otherwise) |
| GET | `/setup/status` | P | Initialisation state and system checks |
| POST | `/setup/initialize` | P | First-run wizard (setup token, admin, settings); disabled afterwards |
| POST | `/auth/login` | P | `{ username, password }` → access token + refresh cookie |
| POST | `/auth/refresh` | P | Rotates the refresh cookie, returns a new access token |
| POST | `/auth/logout` | P | Revokes the current session |
| GET | `/auth/me` | V | Current user |
| POST | `/auth/change-password` | V | `{ currentPassword, newPassword }` |
| GET / DELETE | `/auth/sessions`, `/auth/sessions/:id` | V | Own sessions |

### Users, audit, settings

| Method | Path | Role | Description |
| --- | --- | --- | --- |
| GET / POST | `/users` | A | List / create users |
| PATCH | `/users/:id` | A | Update role, name, active flag |
| POST | `/users/:id/reset-password`, `/users/:id/unlock` | A | |
| GET | `/audit-logs` | A | Filter by action, actor, target; paginated |
| GET | `/settings` | O | All non-secret settings + which secrets are configured |
| PUT | `/settings/:section` | A | `general`, `security`, `monitoring` (partial updates) |

### Servers and agents

| Method | Path | Role | Description |
| --- | --- | --- | --- |
| GET / POST | `/servers` | V / O | List (filter `status`, `search`) / create → registration info |
| GET / PATCH | `/servers/:id` | V / O | Details / update name, OS, tags, watched services |
| POST | `/servers/:id/registration-token` | O | New one-time token (older unused tokens are revoked) |
| POST | `/servers/:id/ping`, `/servers/:id/config-sync` | O | Queue a command |
| POST | `/servers/:id/revoke` | A | Invalidate the node credential |
| POST | `/servers/:id/decommission` | A | Revoke, archive jobs, hide the server |
| GET | `/servers/:id/commands` | V | Last 50 commands |
| GET | `/servers/:id/metrics?range=1h\|6h\|24h\|7d\|30d` | V | Aggregated metric history |

### Projects, backups

| Method | Path | Role | Description |
| --- | --- | --- | --- |
| GET / POST | `/projects` | V / O | |
| GET / PATCH | `/projects/:id` | V / O | |
| GET / POST | `/backup-jobs` | V / O | Filter `serverId`, `projectId`, `includeArchived` |
| GET / PATCH | `/backup-jobs/:id` | V / O | Secrets are write-only (`hasSourceSecret`, `hasDestinationSecret`) |
| POST | `/backup-jobs/:id/run` | O | Start now (returns the queued run) |
| POST | `/backup-jobs/:id/archive` | O | Disable and hide (history kept) |
| POST | `/backup-jobs/:id/encryption-key` | A | `{ password }` → reveal the archive key (audited) |
| GET | `/backup-runs`, `/backup-runs/:id` | V | History with log tail |

### Monitoring, alerts, dashboard

| Method | Path | Role | Description |
| --- | --- | --- | --- |
| GET | `/dashboard/overview` | V | Counters, recent runs and alerts, server health |
| GET | `/alerts` | V | `status=ACTIVE\|OPEN\|ACKNOWLEDGED\|RESOLVED`, `severity`, `serverId`, pagination |
| POST | `/alerts/:id/acknowledge`, `/alerts/:id/resolve` | O | |

### Telegram

| Method | Path | Role | Description |
| --- | --- | --- | --- |
| GET | `/telegram/status` | A | Bot state, last error, links |
| PUT | `/telegram/config` | A | Token (write-only), toggles, broadcast chats |
| POST | `/telegram/test` | A | Send a test message |
| POST | `/telegram/link-code` | V | One-time code for `/link` |
| GET / PATCH / DELETE | `/telegram/links`, `/telegram/links/:id` | V | Own chat links |

### Updates

| Method | Path | Role | Description |
| --- | --- | --- | --- |
| GET | `/updates/core` | O | Current/latest version, updater state, history |
| POST | `/updates/core/check` | A | Query the latest GitHub release |
| POST | `/updates/core/apply` | A | `{ version }` – request an update (latest release only) |
| GET / PUT | `/updates/github` | A | Release source; `token` is write-only (`null` removes it) |
| GET | `/updates/agents/releases` | O | Stored agent releases |
| GET | `/updates/agents/fleet` | O | Agent versions and last update per server |
| POST | `/updates/agents/releases/sync` | A | Import the latest GitHub release |
| POST | `/updates/agents/releases/upload` | A | multipart: `file` (.tgz ≤ 50 MB), `signature?`, `releaseNotes?` |
| POST | `/updates/agents/releases/:version/revoke` | A | |
| POST | `/updates/agents/rollout` | A | `{ version?, serverIds[], force? }` → per-server result |

### Agent endpoints

| Method | Path | Role | Description |
| --- | --- | --- | --- |
| POST | `/agent/register` | P | One-time registration with a registration token (rate-limited) |
| GET | `/agent/config` | N | Jobs, schedules, watched services, encrypted secrets envelope |
| GET | `/agent/commands` | N | Pending signed commands (HTTP polling agents) |
| POST | `/agent/reports` | N | Batched reports (`heartbeat`, `metrics`, `backup.report`, `command.ack`, `command.result`) |
| GET | `/agent/releases/:version/package` | N | Agent package download |
| GET | `/agent/install/script` | P | Bootstrap installer (served as `/install-agent.sh`) |
| GET | `/agent/install/package-info`, `/agent/install/package` | P + token | Latest package for the installer; header `X-IMS-Registration-Token` (not consumed) |
| WSS | `/ws/agent` | N | Realtime channel (see PROTOCOL.md §4) |

## Rate limits

Global: 300 requests/min per client. Stricter limits: login 10/min (5 min block), refresh 60/min, password change 5/min, setup and registration 10/15 min, run backup 10/min, key reveal 5/5 min, update checks 10/10 min, installer downloads 10–20/15 min. Exceeding a limit returns `429`.
