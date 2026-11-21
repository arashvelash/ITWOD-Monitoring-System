# Installing the IMS cPanel Agent

## 1. Repository

`IMS-CPanel-Agent` is a private repository of the ITWOD organisation (see IMS-Core `docs/REPOSITORY_SETUP.md`). Hosting accounts receive a copy of its files; they never need git access.

To prepare an upload archive from a release tag:

```bash
git clone git@github.com:<org>/IMS-CPanel-Agent.git && cd IMS-CPanel-Agent
git checkout v1.0.0
zip -r ims-agent.zip VERSION .htaccess src cron config -x 'config/identity.php'
```

## 2. Requirements

| Item | Requirement |
| --- | --- |
| PHP (CLI) | 7.4 or newer with `curl`, `openssl`, `json`, `hash`; `zlib` for backups; `pdo_mysql` for MySQL backups; `sodium` recommended (Ed25519 request signatures) |
| Hosting | Cron jobs (every 5 minutes), outbound HTTPS to IMS-Core |
| Disk | Room for local archives in `~/ims-backups` (or use an S3 destination) |

In cPanel you can select the PHP version and extensions under **Select PHP Version**. Check the CLI version with `php -v` in the terminal (the cron job must use the same binary).

## 3. Add the account in IMS

Dashboard › **Servers › Add server**, type *cPanel hosting*. Copy the registration token and the command shown (valid 24 h, single use).

## 4. Upload the agent

Upload the files to **`~/ims-agent`** – a directory in the account's home, **outside `public_html`** (File Manager › upload the zip › Extract). The result must look like:

```
~/ims-agent/VERSION
~/ims-agent/.htaccess
~/ims-agent/cron/ims-cron.php
~/ims-agent/src/…
~/ims-agent/config/.htaccess
```

Restrict permissions (Terminal or File Manager › Permissions):

```bash
chmod 700 ~/ims-agent
```

## 5. Register

In cPanel **Terminal** (or via SSH):

```bash
php ~/ims-agent/cron/register.php --core-url=https://itwodms.ir --token=imsr_…
```

To keep the token out of the shell history:

```bash
read -rs T && printf '%s' "$T" > ~/.ims-token && chmod 600 ~/.ims-token
php ~/ims-agent/cron/register.php --core-url=https://itwodms.ir --token-file="$HOME/.ims-token" && rm ~/.ims-token
```

Output: `Registered as ims-node-0003`. The identity is stored in `~/ims-agent/config/identity.php` (0600). Without libsodium the agent registers in HMAC-only mode (the dashboard shows "HMAC only").

No terminal? Create a temporary cron job that runs the register command once (e.g. in 2 minutes), then delete it.

## 6. Cron job

cPanel › **Cron Jobs** › *Once Per Five Minutes* (`*/5 * * * *`):

```
/usr/local/bin/php $HOME/ims-agent/cron/ims-cron.php >/dev/null 2>&1
```

Use the PHP binary of your selected version if it differs (e.g. `/opt/cpanel/ea-php82/root/usr/bin/php` or `/opt/alt/php82/usr/bin/php` on CloudLinux). Within five minutes the server turns **Online** in the dashboard. A lock file prevents overlapping cycles when a backup takes longer than five minutes.

Test a cycle manually:

```bash
php ~/ims-agent/cron/ims-cron.php --verbose
```

## 7. Configure backups

Everything is configured in the dashboard (**Backups › New job**, choose this server):

- **Files**: paths relative to the home directory (e.g. `public_html`), excludes (e.g. `public_html/cache`). Paths outside the home directory are refused.
- **MySQL**: host (`localhost`), database, user and password – create a dedicated user in cPanel › MySQL Databases with *SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, EVENT* privileges.
- **Destination**: local (`~/ims-backups/<job>/`) or S3-compatible storage (single upload up to 5 GB per archive).
- **Encryption**: enable to encrypt archives with a per-job key (retrieve it under Backups › job › Encryption key).

Schedules are evaluated by the agent at each cron cycle, so the effective precision is five minutes.

## 8. Restore

- Files: download the archive, decrypt if needed, extract with `tar -xzf`.
- MySQL: `gunzip < ims-<job>-<timestamp>.sql.gz | mysql -u <user> -p <database>`.
- Decrypt on the hosting account: `php ~/ims-agent/cron/decrypt.php archive.tar.gz.enc archive.tar.gz --key-file=key.txt` (or `ims-agent decrypt` on any Ubuntu server with the agent).

## 9. Troubleshooting

| Symptom | Check / fix |
| --- | --- |
| `Required PHP extension missing: …` | Enable the extension for the CLI PHP version used by cron |
| `Registration failed (401)` | Token expired or already used – create a new one in the dashboard |
| Server stays offline | Cron job saved? Correct PHP path? Run the cron command manually with `--verbose`; outbound HTTPS may be blocked by the host (ask support to allow your Core domain) |
| `must not be readable by group/others` | `chmod 600 ~/ims-agent/config/identity.php` |
| `Previous run still in progress` | A long backup is running; normal. Stale lock after a crash is released automatically |
| Backup times out / killed | Hosts limit CPU time of cron processes: exclude caches and media, split large sites into several jobs, use S3 for large archives |
| MySQL access denied | Use `localhost`, check the user's privileges and the password stored in the job |
| Log | `~/ims-agent/logs/agent.log` (rotated at 5 MB) |
