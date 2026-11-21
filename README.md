<div align="center">

# ITWOD Monitoring System (IMS)

**Self-hosted backup, monitoring and alerting for your servers and shared-hosting accounts — with outbound-only agents and zero destructive commands.**

![Version](https://img.shields.io/badge/version-1.0.0-2f5c9e)
![License](https://img.shields.io/badge/license-MIT-2e8b6f)
![Core](https://img.shields.io/badge/core-NestJS%20%C2%B7%20React%20%C2%B7%20PostgreSQL-3b6fb0)
![Agents](https://img.shields.io/badge/agents-Node.js%2022%20%C2%B7%20PHP%207.4%2B-5b6bb5)
![Deploy](https://img.shields.io/badge/deploy-Docker%20Compose-2f8098)

Built at the request of **ITWOD** · Designed &amp; developed by **Arash Farahani**

[English](#overview) · [فارسی](#فارسی)

</div>

---

## Overview

IMS is a complete platform for keeping a fleet of servers backed up and healthy from one dashboard:

- **IMS-Core** — the management platform: web dashboard, REST API, scheduler, alerting engine and Telegram bot, shipped as a Docker Compose stack.
- **IMS-Agent** — a lightweight Node.js agent for Ubuntu servers (runs under PM2 as a non-root user).
- **IMS-CPanel-Agent** — a dependency-free PHP agent for shared hosting (cPanel, DirectAdmin, Plesk…) that runs from cron, no root needed.

Agents **connect out** to Core over HTTPS/WSS. Core never logs in to your servers, never runs shell commands on them, and the agent command set is a closed allow-list with no way to delete projects, databases, files or disks.

> **Open source with permission.** IMS was originally developed for ITWOD's internal infrastructure. ITWOD kindly agreed to release it publicly so anyone can use, study and improve it.

## Architecture

```
                         ┌──────────────────────────── IMS-Core (Docker) ───────────────────────────┐
  Browser ──── HTTPS ──▶ │  Caddy (auto-TLS) ─▶ React dashboard                                      │
  Telegram ◀── HTTPS ─── │        │            NestJS API + workers ─▶ PostgreSQL 17 · Redis 7       │
                         │        └──────────▶ WSS /ws/agent ◀──────────────┐                        │
                         └──────────────────────────────────────────────────┼────────────────────────┘
                                                                            │  outbound only (443)
                          ┌──────────────────────────────┐   ┌──────────────┴───────────────────┐
                          │  Ubuntu server · IMS-Agent   │   │  Shared hosting · cPanel Agent   │
                          │  Node 22 + PM2 · WebSocket   │   │  PHP · cron every 5 min · HTTPS  │
                          └──────────────────────────────┘   └──────────────────────────────────┘
```

## Features

| Area | What you get |
| --- | --- |
| **Servers** | Add a server and get a Node ID, a one-time expiring registration token, a per-node secret and an Ed25519 key. Revoke or decommission without touching the server. |
| **Backups** | Files, MySQL/MariaDB and PostgreSQL · cron schedules per job · retention by count or age · gzip · AES-256-GCM encryption · local and S3-compatible destinations · run history with logs. Agents keep running their schedule even while Core is offline. |
| **Monitoring** | CPU, memory, swap, disks, network, load, uptime and systemd services, with charts from 1 hour to 30 days and a fleet overview. |
| **Alerts** | Offline nodes, sustained CPU/memory/disk pressure, services down, failed or missed backups, failed agent updates — de-duplicated and auto-resolving. |
| **Telegram** | Notifications and read-only commands; operators can start a backup with an inline confirmation. |
| **Users &amp; audit** | Admin / Operator / Viewer roles, Argon2id passwords, rotating refresh sessions, account lockout and a full audit log. |
| **Updates** | One-click Core updates with backup, migrations, health check and automatic rollback; signed agent releases rolled out from the dashboard. |

## Security by design

- **Outbound-only agents** — managed servers need no open inbound port.
- **No destructive capability** — agent commands are limited to `ping`, `config.sync`, `monitor.collect`, `backup.run` and `agent.update`. No shell execution, no file or database deletion. The only files an agent removes are its own expired backup archives, behind strict name and path checks.
- **Signed protocol** — every agent message is signed (Ed25519 + HMAC) with replay protection.
- **Secrets encrypted at rest** — AES-256-GCM with a master key that never touches the database; secrets are delivered only to the node that needs them.
- **Signed agent updates** — agents refuse unsigned or wrongly signed releases and roll back automatically on failure.

See [`IMS-Core/SECURITY.md`](IMS-Core/SECURITY.md) for the full security model and hardening checklist.

## Repository layout

```
IMS-Core/           Management platform
  backend/            NestJS API, Prisma schema and migrations
  frontend/           React 19 + Vite + Tailwind dashboard
  docker/             Dockerfiles, Caddyfile, entrypoint, secret generation
  database/           PostgreSQL init SQL, Core backup/restore scripts
  scripts/            Installer, host updater, agent install script
  docs/               Architecture, protocol, API, configuration, troubleshooting
IMS-Agent/          Ubuntu agent (TypeScript, bundled into a single JS file)
IMS-CPanel-Agent/   Shared-hosting agent (plain PHP, no Composer)
```

## Quick start

### 1 · Run IMS-Core

Requirements: a Linux host with Docker and Docker Compose, and a domain pointing to it (ports 80/443 open).

```bash
git clone https://github.com/arashvelash/ITWOD-Monitoring-System.git
cd ITWOD-Monitoring-System/IMS-Core
cp .env.example .env          # set IMS_DOMAIN, ACME_EMAIL and IMS_PUBLIC_URL
docker compose up -d
docker compose exec backend cat /run/ims-secrets/setup_token
```

Open `https://<your-domain>/setup`, paste the setup token and create the administrator account. All infrastructure secrets (database, Redis, master key, JWT) are generated automatically on first start.

### 2 · Connect an Ubuntu server

In the dashboard go to **Servers › Add server**, copy the one-time token, then on the server:

```bash
curl -fsSL https://<your-domain>/install-agent.sh | sudo bash
```

### 3 · Connect a shared-hosting account

Upload `IMS-CPanel-Agent/` to `~/ims-agent` (outside `public_html`), then:

```bash
php ~/ims-agent/cron/register.php --core-url=https://<your-domain> --token=<token>
# cPanel › Cron Jobs, every 5 minutes:
/usr/local/bin/php ~/ims-agent/cron/ims-cron.php >/dev/null 2>&1
```

## Documentation

| Component | Guides |
| --- | --- |
| **IMS-Core** | [README](IMS-Core/README.md) · [Installation](IMS-Core/INSTALLATION.md) · [Updates](IMS-Core/UPDATE.md) · [Security](IMS-Core/SECURITY.md) · [Architecture](IMS-Core/docs/ARCHITECTURE.md) · [Protocol](IMS-Core/docs/PROTOCOL.md) · [API](IMS-Core/docs/API.md) · [Configuration](IMS-Core/docs/CONFIGURATION.md) · [Troubleshooting](IMS-Core/docs/TROUBLESHOOTING.md) |
| **IMS-Agent** | [README](IMS-Agent/README.md) · [Installation](IMS-Agent/INSTALLATION.md) · [Updates](IMS-Agent/UPDATE.md) · [Security](IMS-Agent/SECURITY.md) · [Development](IMS-Agent/docs/DEVELOPMENT.md) |
| **IMS-CPanel-Agent** | [README](IMS-CPanel-Agent/README.md) · [Installation](IMS-CPanel-Agent/INSTALLATION.md) · [Updates](IMS-CPanel-Agent/UPDATE.md) · [Security](IMS-CPanel-Agent/SECURITY.md) |

> **Note on the update system.** The component docs describe the original setup with three separate repositories. In this combined repository, point the Core host updater at the `IMS-Core/` folder of your clone and publish agent releases from `IMS-Agent/` as described in [`IMS-Agent/UPDATE.md`](IMS-Agent/UPDATE.md).

## Tech stack

| | |
| --- | --- |
| **Backend** | NestJS · TypeScript · Prisma · PostgreSQL 17 · Redis 7 · BullMQ |
| **Frontend** | React 19 · Vite · Tailwind CSS |
| **Infrastructure** | Docker Compose · Caddy (automatic HTTPS) |
| **Ubuntu agent** | Node.js 22 · TypeScript · PM2 · WebSocket |
| **Shared-hosting agent** | PHP 7.4+ · cron · PDO · no external dependencies |
| **Crypto** | Ed25519 · HMAC-SHA256 · AES-256-GCM · Argon2id |

## Contributing

Issues and pull requests are welcome. Before opening a PR, run the test suites:

```bash
cd IMS-Core && npm ci && npm run typecheck && npm test
cd IMS-Agent && npm ci && npm run typecheck && npm test
cd IMS-CPanel-Agent && php tests/run-tests.php
```

Please report security issues privately rather than in a public issue.

## License

Released under the [MIT License](LICENSE).

---

## فارسی

**سامانه‌ی مانیتورینگ ITWOD (IMS)** یه پلتفرم کامل و خودمیزبان برای بکاپ‌گیری، مانیتورینگ و هشدار سرورهاست که **به درخواست شرکت ITWOD** طراحی و توسعه داده شده.

این پروژه اول برای زیرساخت داخلی ITWOD ساخته شد و **شرکت ITWOD موافقت کرد که به‌صورت ریپازیتوری عمومی منتشر بشه** تا همه بتونن ازش استفاده کنن.

**سه بخش اصلی:**

- **IMS-Core:** پنل مدیریت (داشبورد وب، API، زمان‌بندی، هشدارها و ربات تلگرام) با Docker Compose
- **IMS-Agent:** ایجنت سبک Node.js برای سرورهای اوبونتو
- **IMS-CPanel-Agent:** ایجنت PHP برای هاست‌های اشتراکی (سی‌پنل و…) که با کران اجرا میشه و دسترسی روت نمی‌خواد

**قابلیت‌ها:**

- بکاپ فایل، MySQL/MariaDB و PostgreSQL با زمان‌بندی، رمزنگاری AES-256 و ذخیره روی سرور یا فضای S3
- مانیتورینگ CPU، رم، دیسک، شبکه و سرویس‌ها با نمودار
- هشدار خودکار برای آفلاین شدن سرور، پر شدن دیسک و بکاپ‌های ناموفق
- اعلان و فرمان از طریق تلگرام
- نقش‌های کاربری، لاگ کامل فعالیت‌ها و آپدیت خودکار با قابلیت بازگشت

**امنیت:** ایجنت‌ها فقط به سمت Core وصل میشن (هیچ پورت ورودی‌ای روی سرور باز نمیشه) و هیچ دستوری برای حذف فایل، دیتابیس یا دیسک وجود نداره.

طراحی و توسعه: **آرش فراهانی**
