# Installing the IMS Agent (Ubuntu)

## 1. Repository

`IMS-Agent` is a private repository of the ITWOD organisation (see IMS-Core `docs/REPOSITORY_SETUP.md`). Servers never clone it: they install **release packages** built from it and distributed by IMS-Core. You only need the repository to build and publish releases.

## 2. Requirements

| Item | Requirement |
| --- | --- |
| OS | Ubuntu 20.04, 22.04 or 24.04 (other systemd-based Debian derivatives usually work) |
| Access | root / sudo |
| Network | outbound HTTPS (443) to IMS-Core; nothing inbound |
| Runtime | Node.js ≥ 20.19 and PM2 – installed automatically (Node.js 22 from the official NodeSource repository, PM2 6.0.14 from npm) |
| Backups | `tar` + `gzip` (files), `mysqldump` (MySQL/MariaDB), `pg_dump` (PostgreSQL) – whichever job types you use |
| Resources | ~60 MB RAM idle, negligible CPU; disk for local backups in `/var/backups/ims` |

Before installing, make sure an agent release exists on Core (**Updates › Agents** shows at least one release).

## 3. One-line installation

1. In the dashboard: **Servers › Add server**, type *Ubuntu*. Copy the registration token (valid for 24 h by default, single use).
2. On the server:

   ```bash
   curl -fsSL https://itwodms.ir/install-agent.sh | sudo bash
   ```

3. Enter the Core URL (pre-filled) and the registration token when asked.

Non-interactive variant (token from a file, e.g. via configuration management):

```bash
echo 'imsr_…' > /root/ims-token && chmod 600 /root/ims-token
curl -fsSL https://itwodms.ir/install-agent.sh | sudo bash -s -- --core-url https://itwodms.ir --token-file /root/ims-token
rm /root/ims-token
```

The bootstrap script downloads the newest release from Core (authenticated with the token, which is not consumed yet), verifies its SHA-256 and runs the package's `installer/install.sh`, which

1. installs Node.js 22 and PM2 if missing,
2. creates the system user `ims-agent` (no login shell),
3. creates `/opt/ims-agent`, `/etc/ims-agent` (0700), `/var/lib/ims-agent` (0700), `/var/log/ims-agent`, `/var/backups/ims` (0700),
4. installs the release to `/opt/ims-agent/releases/<version>` and points `/opt/ims-agent/current` to it,
5. registers the node (generates the Ed25519 key locally; the token is passed via a 0600 file, never on the command line),
6. starts the agent with PM2 as `ims-agent`, enables `pm2-ims-agent.service` for boot and installs `pm2-logrotate` (10 MB × 7, compressed).

### Installing from a package file

```bash
mkdir /tmp/ims && tar -xzf ims-agent-1.0.0.tgz -C /tmp/ims
sudo IMS_REGISTRATION_TOKEN='imsr_…' /tmp/ims/installer/install.sh --core-url https://itwodms.ir
```

Installer options: `--run-as-root`, `--skip-register` (upgrade files only), `--force-register` (replace the identity using a new token).

## 4. Configuration

Nearly everything is configured in the dashboard and delivered to the agent (jobs, schedules, retention, destinations, watched services). Local overrides go to `/etc/ims-agent/agent.env` (see `.env.example`); apply them with a restart:

```bash
sudo -u ims-agent PM2_HOME=/var/lib/ims-agent/.pm2 pm2 restart ims-agent --update-env
```

| Variable | Purpose |
| --- | --- |
| `IMS_AGENT_LOG_LEVEL` | `error`, `warn`, `info` (default), `debug` |
| `IMS_RELEASE_PUBLIC_KEY` | Pinned release signing key (alternative to `/etc/ims-agent/release-public.key`) |
| `IMS_AGENT_*_DIR` | Custom directories (keep the defaults unless you know why) |

### Pin the release signing key (recommended)

```bash
echo '<base64 public key>' | sudo tee /etc/ims-agent/release-public.key
sudo chown ims-agent:ims-agent /etc/ims-agent/release-public.key
```

With a pinned key, updates without a valid Ed25519 signature are refused.

### Access to backup sources

The agent runs as `ims-agent`. Give it read access to what it must back up, for example:

```bash
sudo usermod -aG www-data ims-agent          # web roots owned by www-data
sudo -u ims-agent PM2_HOME=/var/lib/ims-agent/.pm2 pm2 restart ims-agent
```

For databases create a dedicated read-only user, e.g. MySQL:

```sql
CREATE USER 'ims_backup'@'localhost' IDENTIFIED BY '<strong password>';
GRANT SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, EVENT ON `appdb`.* TO 'ims_backup'@'localhost';
```

and PostgreSQL: `CREATE ROLE ims_backup LOGIN PASSWORD '…'; GRANT pg_read_all_data TO ims_backup;` (PostgreSQL 14+).

Only if group access is not possible, reinstall with `--run-as-root`.

## 5. Everyday commands

```bash
sudo ims-agent status                       # identity, config version, jobs, update state
sudo ims-agent version
sudo tail -f /var/log/ims-agent/agent.log
sudo -u ims-agent PM2_HOME=/var/lib/ims-agent/.pm2 pm2 status
sudo ims-agent decrypt backup.tar.gz.enc backup.tar.gz --key-file key.txt   # key from Backups › job › Encryption key
```

## 6. Uninstall

```bash
sudo /opt/ims-agent/current/installer/uninstall.sh            # keeps identity, state, logs and backups
sudo /opt/ims-agent/current/installer/uninstall.sh --purge    # also removes /etc, /var/lib, /var/log dirs and the user
```

Backups in `/var/backups/ims` are never removed. Revoke or decommission the server in the dashboard as well.

## 7. Troubleshooting

| Symptom | Check / fix |
| --- | --- |
| `Core rejected the request` during install | Token expired or used, or no agent release on Core |
| `Registration failed (401)` | Issue a new registration token in the dashboard |
| Stays offline | `sudo ims-agent status`; error log; outbound 443; time sync (`timedatectl`) – requests are valid for ±5 min |
| Close code `4403` in the log | Node was revoked: new token + `install.sh --force-register` |
| `EACCES` in backup runs | Grant read access (section 4) |
| `mysqldump: command not found` | `sudo apt-get install mysql-client` (or `mariadb-client`) |
| Update failed / rolled back | Reason in Updates › Agents; `sudo ims-agent status` shows `updateState` |
| High memory | PM2 restarts the agent above 400 MB; check the job sizes and `error.log` |

Logs never contain secrets (secret-looking fields are redacted).
