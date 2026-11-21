# IMS cPanel Agent

Agent of the **ITWOD Monitoring System (IMS)** for shared hosting accounts (cPanel, DirectAdmin, Plesk and similar) where you cannot install services. It is plain PHP (7.4 or newer, no Composer), runs from **cron every 5 minutes** and talks to IMS-Core over outbound HTTPS only.

Per cycle it

1. sends a heartbeat and a metrics sample (load average, account disk usage, backup directory size, PHP version, uptime where readable),
2. refreshes its configuration when Core reports a new version,
3. fetches and executes signed commands (`ping`, `config.sync`, `monitor.collect`, `backup.run`),
4. runs due backup jobs – **files** (streaming tar.gz written in PHP, no `exec`) and **MySQL/MariaDB** (PDO dump, no `mysqldump` needed) – with optional `IMSENC1` encryption, local and S3 destinations and retention,
5. flushes its outbox of reports.

Not supported on shared hosting: PostgreSQL backups, systemd service monitoring, self-updates (update manually, see [UPDATE.md](UPDATE.md)).

| Document | Content |
| --- | --- |
| [INSTALLATION.md](INSTALLATION.md) | Requirements, upload, registration, cron, configuration, troubleshooting |
| [UPDATE.md](UPDATE.md) | Updating the files safely |
| [SECURITY.md](SECURITY.md) | Security model and hosting-specific precautions |
| [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) | Cycle, files, formats, limits |

## Quick start

```bash
# upload the repository content to ~/ims-agent (outside public_html), then:
php ~/ims-agent/cron/register.php --core-url=https://itwodms.ir --token=imsr_…
# cPanel › Cron Jobs, every 5 minutes:
/usr/local/bin/php ~/ims-agent/cron/ims-cron.php >/dev/null 2>&1
```

## Layout

```
cron/      entry points: ims-cron.php (cron), register.php, decrypt.php
src/       agent classes (namespace Ims\Agent), Backup/* (tar writer, MySQL dumper, S3, encryption)
config/    identity.php (created at registration, 0600), .htaccess
state/     config cache, outbox, schedule state, lock (created at runtime)
logs/      agent.log (rotated at 5 MB)
tests/     dependency-free test runner + shared protocol vectors
```

## Tests

```bash
php -d extension=sodium tests/run-tests.php
```
