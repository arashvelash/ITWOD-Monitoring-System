# ITWOD Monitoring System (IMS) – Core

IMS-Core is the private management platform of the ITWOD Monitoring System: a dashboard and API that registers servers, schedules and tracks backups, monitors resources, raises alerts, talks to you over Telegram and keeps itself and its agents up to date.

Agents connect **outbound** to Core. Core never logs in to your servers, never runs shell commands on them and has no function to delete projects, databases, files or disks.

```
                    ┌──────────────────────── IMS-Core (Docker) ───────────────────────┐
  Browser ──HTTPS──▶│ Caddy ─▶ React dashboard                                          │
  Telegram ◀──poll──│   │      NestJS API ──▶ PostgreSQL 17   Redis 7 (locks, queues)   │
                    │   └────▶ WSS /ws/agent ◀─────────────┐                            │
                    └──────────────────────────────────────┼────────────────────────────┘
                                                            │ outbound only (443)
                ┌───────────────────────────┐   ┌──────────┴──────────────────┐
                │ Ubuntu server: IMS-Agent  │   │ cPanel account: PHP agent    │
                │ Node 22 + PM2, WebSocket  │   │ cron every 5 min, HTTPS poll │
                └───────────────────────────┘   └──────────────────────────────┘
```

## Features

| Area | What you get |
| --- | --- |
| Servers | Add a server → Node ID (`ims-node-0001`), one-time expiring registration token, per-node secret + Ed25519 key. Revoke / decommission without touching the server. |
| Backups | Files, MySQL/MariaDB, PostgreSQL; cron schedules per job, retention by count/age, gzip, AES-256-GCM encryption, local and S3-compatible destinations, run history with logs. Agents keep their schedule when Core is offline. |
| Monitoring | CPU, memory, swap, disks, network, load, uptime, systemd services; charts for 1 h – 30 d; fleet overview. |
| Alerts | Offline nodes, sustained CPU, memory, disk, services down, failed or missed backups, failed agent updates – de-duplicated, auto-resolving. |
| Telegram | Notifications and read-only commands; operators can start backups with an inline confirmation. |
| Users | Admin / Operator / Viewer roles, Argon2id passwords, rotating refresh sessions, lockout, audit log. |
| Updates | Core updates from your private GitHub repository with backup, migrations, health check and automatic rollback; signed agent releases rolled out from the dashboard. |

## Quick start

```bash
git clone git@github.com:<your-org>/IMS-Core.git
cd IMS-Core
cp .env.example .env        # set IMS_DOMAIN, ACME_EMAIL, IMS_PUBLIC_URL
docker compose up -d
docker compose exec backend cat /run/ims-secrets/setup_token
```

Open `https://<your-domain>/setup`, enter the setup token and create the administrator. Then install the host updater once:

```bash
sudo ./scripts/install-updater.sh
```

`sudo ./scripts/install.sh` performs the same steps interactively.

## Documentation

| Document | Content |
| --- | --- |
| [INSTALLATION.md](INSTALLATION.md) | Repository creation, requirements, deployment, first-run wizard, Telegram, first server, troubleshooting |
| [UPDATE.md](UPDATE.md) | Releasing, dashboard and manual updates, rollback, agent releases |
| [SECURITY.md](SECURITY.md) | Security model, cryptography, hardening checklist, incident response |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data model, design decisions |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | Agent ↔ Core wire protocol (signatures, frames, commands, encryption) |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Environment variables and dashboard settings |
| [docs/API.md](docs/API.md) | REST endpoints and roles |
| [docs/REPOSITORY_SETUP.md](docs/REPOSITORY_SETUP.md) | Private GitHub repositories, deploy keys, tokens, release workflow |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common problems and how to diagnose them |

## Repository layout

```
backend/     NestJS API, Prisma schema + migrations (backend/prisma)
frontend/    React 19 + Vite + Tailwind dashboard
database/    PostgreSQL init SQL, Core backup/restore scripts
docker/      Dockerfiles, Caddyfile, entrypoint, secret generation
scripts/     install.sh, update.sh, install-updater.sh, install-agent.sh, systemd units
tests/       backend (Jest), frontend (Vitest), shared protocol vectors
docs/        architecture, protocol, configuration, API, troubleshooting
```

## Development

Requirements: Node.js 22, PostgreSQL 17 and Redis 7 (or `docker compose up -d postgres redis`).

```bash
npm ci
npm run prisma:generate
npm run typecheck
npm test                  # backend + frontend unit tests
npm run dev:backend       # http://localhost:3000/api/v1
npm run dev:frontend      # http://localhost:5173 (proxies /api and /ws)
```

For local development set `NODE_ENV=development`, `COOKIE_SECURE=false`, `DATA_DIR=./data` and the connection strings described in `.env.example`.

## License

Proprietary – © ITWOD. All rights reserved.
