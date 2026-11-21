# IMS cPanel Agent – Security

Report vulnerabilities privately to security@itwodms.ir (see IMS-Core `SECURITY.md`).

## Model

- **CLI only.** `src/bootstrap.php` exits with 404 when not run through the PHP CLI, and `.htaccess` files deny web access. Install the agent outside `public_html`.
- **Outbound only.** The agent polls Core over HTTPS (TLS verification enforced, HTTPS-only cURL protocols, no redirects). No endpoint is exposed on the hosting account.
- **Signed, allow-listed commands.** Commands must carry a valid HMAC from Core with this node's secret, be addressed to this node, be unexpired and unused. The allow-list is `ping`, `config.sync`, `monitor.collect`, `backup.run` (`agent.update` is rejected on shared hosting). There is no shell execution and no deletion command.
- **No shell.** Archives are built by a pure-PHP streaming tar writer; MySQL dumps use PDO. `exec`, `shell_exec`, `proc_open` are never used, so the agent also works where they are disabled.
- **Scoped file access.** File backups only accept paths inside the account's home directory and skip the agent's own directory and the backup directory. Retention deletes only archives created by IMS (`ims-<job>-<timestamp>.<ext>[.enc]`) and always keeps the newest.

## Credentials

| Item | Protection |
| --- | --- |
| `config/identity.php` (node secret, Ed25519 key) | 0600 in a 0700 directory, guard line prevents output over HTTP, refused if readable by group/others |
| Registration token | Single-use and expiring; prefer `--token-file` so it never enters the shell history |
| Database / S3 credentials, archive keys | Delivered by Core inside an encrypted envelope bound to the node secret; kept in memory only while a job runs |
| Logs | Secret-looking fields are redacted; the log is 0600 in a 0700 directory |

Requests are signed with HMAC-SHA256 and – when libsodium is available – additionally with Ed25519. Hosts without libsodium run in HMAC-only mode; enable the `sodium` extension if you can.

## Shared-hosting considerations

- Other accounts on the same server cannot read 0600/0700 files, but the hosting provider (root) can. Do not store backups of highly sensitive data unencrypted on the same host – enable archive encryption and prefer S3 destinations.
- Use a dedicated MySQL user with read-only privileges (`SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, EVENT`) for backups.
- Use S3 keys restricted to one bucket prefix.
- Keep the account's PHP version supported by the PHP project (security fixes).

## If the account is compromised

Revoke the node in the IMS dashboard (immediate), change the account password, the MySQL user password and the S3 key used by its jobs, clean the account, upload a fresh copy of the agent and register it again with a new token (`--force`).
