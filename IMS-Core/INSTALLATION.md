# Installing IMS-Core

This guide takes you from an empty Ubuntu server to a running Core with its first monitored server.

1. [Create the repositories](#1-create-the-repositories)
2. [Requirements](#2-requirements)
3. [Prepare the host](#3-prepare-the-host)
4. [Deploy](#4-deploy)
5. [Setup wizard](#5-setup-wizard)
6. [Install the host updater](#6-install-the-host-updater)
7. [Configure Telegram (optional)](#7-configure-telegram-optional)
8. [Add your first server](#8-add-your-first-server)
9. [Back up Core itself](#9-back-up-core-itself)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Create the repositories

IMS consists of three private repositories:

| Repository | Deployed to |
| --- | --- |
| `IMS-Core` | the Core host (this guide) |
| `IMS-Agent` | built into release packages that Core distributes to Ubuntu servers |
| `IMS-CPanel-Agent` | copied into each cPanel hosting account |

Create them as **private** repositories in your GitHub organisation and push the code:

```bash
cd IMS-Core
git init -b main
git add .
git commit -m "IMS-Core 1.0.0"
git remote add origin git@github.com:<org>/IMS-Core.git
git push -u origin main
git tag -a v1.0.0 -m "IMS-Core 1.0.0" && git push origin v1.0.0
```

Repeat for `IMS-Agent` and `IMS-CPanel-Agent`. Access for the Core host (deploy key) and for the dashboard (read-only token) is described in [docs/REPOSITORY_SETUP.md](docs/REPOSITORY_SETUP.md).

## 2. Requirements

| Item | Minimum | Recommended |
| --- | --- | --- |
| OS | Ubuntu 22.04 LTS (any Linux with Docker works) | Ubuntu 24.04 LTS |
| CPU / RAM | 1 vCPU / 2 GB | 2 vCPU / 4 GB |
| Disk | 20 GB | 40 GB SSD (metrics history, Core backups, agent releases) |
| Software | Docker Engine 24+, Docker Compose plugin v2.20+, git | |
| Network | A DNS name (e.g. `itwodms.ir`) pointing to the host; inbound TCP 80 + 443 (and UDP 443 for HTTP/3) | |

Outbound access is needed to Let's Encrypt, GitHub (updates) and `api.telegram.org` (optional). Agents only need outbound HTTPS to Core.

Everything else (Node.js, PostgreSQL 17, Redis 7, Caddy) runs in containers.

## 3. Prepare the host

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
# Docker Engine + Compose plugin (official repository)
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Firewall: only SSH and the web ports
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp && sudo ufw enable
```

Create the DNS `A`/`AAAA` record for your domain before the first start, otherwise Caddy cannot obtain a certificate.

## 4. Deploy

```bash
sudo mkdir -p /opt && cd /opt
sudo git clone git@github.com:<org>/IMS-Core.git ims-core     # uses the deploy key, see REPOSITORY_SETUP.md
cd ims-core
sudo git checkout v1.0.0                                        # always run a released tag
sudo cp .env.example .env && sudo chmod 600 .env
sudo nano .env                                                  # IMS_DOMAIN, ACME_EMAIL, IMS_PUBLIC_URL
sudo docker compose up -d
```

The path must not contain spaces (the updater refuses such paths).

What happens on the first start:

1. `init` generates all infrastructure secrets (database and Redis passwords, AES-256 master key, JWT secret, setup token) into the Docker volume `ims_ims-secrets` and prepares `./data`. Existing secrets are never rotated implicitly.
2. `postgres` and `redis` start on an internal network without published ports.
3. `backend` applies database migrations and starts the API.
4. `web` (Caddy) obtains a TLS certificate and serves the dashboard.

Check the state:

```bash
sudo docker compose ps          # all services "running", backend "healthy"
sudo docker compose logs -f backend
curl -fsS https://<your-domain>/api/v1/health
```

Alternatively run `sudo ./scripts/install.sh`, which performs steps 4–6 interactively.

## 5. Setup wizard

Get the one-time setup token:

```bash
sudo docker compose exec backend cat /run/ims-secrets/setup_token
```

Open `https://<your-domain>/setup`. The wizard

1. verifies the setup token,
2. checks database, migrations, Redis, master key, JWT secret and HTTPS,
3. creates the administrator (username + password of at least 12 characters, strength-checked),
4. stores general settings (instance name, public URL, timezone),
5. sets the security policy (session idle/absolute lifetime, registration token validity, lockout),
6. optionally stores the Telegram bot token.

After completion the setup endpoints are closed permanently; the token is useless from then on.

> **Important:** back up the secrets volume now (`./database/scripts/backup-core-db.sh`). The master key in it encrypts node secrets, backup credentials and tokens. Without it, encrypted data cannot be recovered.

## 6. Install the host updater

Core updates are executed by a small systemd service on the host, triggered when an administrator clicks **Install update** in the dashboard. Containers never receive the Docker socket or host access.

```bash
cd /opt/ims-core
sudo ./scripts/install-updater.sh
systemctl status ims-updater.path
```

Then configure the release source in **Updates › Release source** (repository names and a read-only token). See [UPDATE.md](UPDATE.md).

## 7. Configure Telegram (optional)

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Dashboard › **Telegram**: paste the token, enable the bot, choose which notifications to send, save. Core uses long polling, no webhook or inbound port is required.
3. Each user links their own chat: **Account › Telegram › Generate link code**, then send `/link IMS-XXXX-XXXX` to the bot in a private chat.
4. Optional: add group/channel chat IDs as notification-only chats.

Commands: `/status`, `/servers`, `/server <name|node-id>`, `/alerts`, `/backups`, `/jobs`, `/backup <job>` (operators, with confirmation), `/unlink`, `/help`. Roles of the linked IMS user apply.

If `api.telegram.org` is not reachable from your network, set `TELEGRAM_API_BASE` in `.env` to a self-hosted Bot API server or relay and run `docker compose up -d`.

## 8. Add your first server

### Ubuntu server

1. Dashboard › **Servers › Add server**: name, type *Ubuntu*, operating system.
2. Core shows the Node ID, a one-time registration token (default validity 24 h) and the install command.
3. Before the first agent install, make an agent release available: **Updates › Agents › Upload** (package built with `npm run package` in IMS-Agent) or **Sync from GitHub**.
4. On the server:

   ```bash
   curl -fsSL https://<your-domain>/install-agent.sh | sudo bash
   ```

   The script asks for the Core URL (pre-filled) and the registration token, verifies the package checksum, installs Node.js 22 + PM2 if needed and registers the node. The server turns **Online** within a few seconds.

### cPanel account

Follow `IMS-CPanel-Agent/INSTALLATION.md`: upload the agent to `~/ims-agent`, run `cron/register.php` with the token shown in the dashboard and add the cron job.

### First backup

**Backups › New job**: choose the server, type (files / MySQL / PostgreSQL), schedule, retention, destination and optionally encryption. Use **Run now** to test it; the run appears in the history with its log.

## 9. Back up Core itself

```bash
sudo ./database/scripts/backup-core-db.sh            # → data/core-backups/ims-core-<timestamp>/
```

The backup contains the database dump, the secrets volume (including the master key), `.env`, the git revision and checksums. Copy it off the host regularly (e.g. with a cron job and `rsync`), and keep it as confidential as the host itself. Restore with `./database/scripts/restore-core-db.sh <dir>`.

Agent backups are not stored on Core – they stay on the servers or in your S3 buckets.

## 10. Troubleshooting

| Symptom | Check |
| --- | --- |
| Browser shows a certificate error | DNS points to this host? Ports 80/443 open? `docker compose logs web` shows ACME errors. |
| `backend` restarts or is unhealthy | `docker compose logs backend` – configuration errors are printed clearly at start-up. `docker compose ps postgres redis` must be healthy. |
| Setup page says "already initialised" | Setup was completed. Log in normally; reset a lost admin password as described in docs/TROUBLESHOOTING.md. |
| Setup token rejected | Use the value from `/run/ims-secrets/setup_token` without spaces; it is only valid before setup completes. |
| Agent install: "Core rejected the request" | Token expired or already used → Servers › server › New registration token. No agent release uploaded yet → Updates › Agents. |
| Server stays "Awaiting agent" | On the server: `sudo ims-agent status`, `tail /var/log/ims-agent/error.log`. Outbound 443 to Core allowed? Clock in sync (`timedatectl`)? Signed requests allow ±5 min skew. |
| No Telegram messages | Telegram page shows the last error; is outbound access to the Bot API possible? Did the user link the chat? |

More in [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).
