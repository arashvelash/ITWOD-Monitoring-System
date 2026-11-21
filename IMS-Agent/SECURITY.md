# IMS Agent – Security

Report vulnerabilities privately to security@itwodms.ir (see IMS-Core `SECURITY.md`).

## Trust model

- The agent trusts **only** the Core URL and credentials created at registration. It never accepts inbound connections.
- Core is not trusted blindly: every command must carry a valid HMAC signature made with this node's secret, be addressed to this node, be unexpired and not seen before (command ids are remembered for 24 h). Only five command types exist; anything else is rejected locally, regardless of what Core sends.
- There is **no** command for shell execution, file deletion, package removal or disk operations. Retention only removes archives the agent created itself, matching `ims-<job>-<timestamp>.<ext>[.enc]` inside the job's directory or S3 prefix, and always keeps the newest.

## Credentials on the server

| File | Content | Protection |
| --- | --- | --- |
| `/etc/ims-agent/identity.json` | Node ID, Core URL, node secret | 0600, owner `ims-agent`, directory 0700; the agent refuses to start if group/others can read it |
| `/etc/ims-agent/node.key` | Ed25519 private key (PKCS#8), generated locally, never transmitted | 0600, same checks |
| `/var/lib/ims-agent/config-cache.json` | Last configuration from Core (jobs); secrets inside stay in the encrypted envelope | 0600 |
| `/var/lib/ims-agent/outbox/` | Unsent reports (no secrets) | 0700 |

The registration token is single-use; the installer passes it through a temporary 0600 file and deletes it. It is never written to logs or the process list.

Secrets needed for backups (database passwords, S3 keys, archive keys) arrive in the configuration response inside an AES-256-GCM envelope derived from the node secret. They are decrypted in memory only. Database passwords are handed to `mysqldump` through a temporary 0600 option file (removed after the dump) and to `pg_dump` via `PGPASSWORD` in the child's environment – never as command-line arguments.

## Transport

- HTTPS/WSS only (`http://` Core URLs are refused unless `IMS_ALLOW_INSECURE_CORE=true` for development). Certificates are validated by Node.js; redirects are not followed.
- Each HTTP request: HMAC-SHA256 over method, path, timestamp, nonce and body hash + Ed25519 signature; WebSocket authentication uses the same scheme. Requests are valid for ±300 s and nonces are single-use on Core.
- Downloads are size-limited and hashed while streaming.

## Process hardening

- Runs as the unprivileged system user `ims-agent` (no shell) under PM2; `--run-as-root` only on explicit request.
- Child processes (`tar`, `mysqldump`, `pg_dump`, `systemctl is-active`) are started with `spawn`/`execFile` and argument arrays – never through a shell. Service names are validated against `^[a-zA-Z0-9@._][a-zA-Z0-9@._-]{0,63}$` and passed after `--`.
- File backups exclude the agent's own directories and the backup directory.
- Logs are structured JSON; keys that look like secrets (`secret`, `password`, `token`, `key`, `signature`, `authorization`) are redacted.
- Memory is capped (`--max-old-space-size=256`, PM2 restart above 400 MB).

## Updates

- Packages are downloaded only from the configured Core through the authenticated channel, verified by exact size and SHA-256, and – when `/etc/ims-agent/release-public.key` or `IMS_RELEASE_PUBLIC_KEY` is set – by an **Ed25519 signature** from the offline release key. **Pin the key in production**; without it, the agent trusts Core to deliver the right package.
- The extractor accepts only regular files and directories, rejects absolute paths, `..` segments, links and device files, and caps entry count and total size. setuid/setgid bits are never applied.
- New releases must pass a self-test before activation, are switched atomically and roll back automatically (crash loop or no connection to Core within 5 minutes). The launcher that performs the rollback is only replaced after the new release is confirmed.

## Operator checklist

- [ ] Pin the release public key.
- [ ] Grant the `ims-agent` user read-only access to backup sources; use dedicated read-only database users.
- [ ] Use S3 keys restricted to the job's bucket prefix; enable bucket versioning / object lock.
- [ ] Enable archive encryption for jobs that leave the server; store the job keys (Backups › job › Encryption key) in your password manager.
- [ ] Keep the system clock synchronised (`timedatectl set-ntp true`).
- [ ] Keep Ubuntu and Node.js patched (`unattended-upgrades` covers the NodeSource repository once added to its origins).

## If a server is compromised

Revoke the node in the dashboard (immediate), rotate the database and S3 credentials used by its jobs, reinstall the server, then enrol it again with a new registration token (`install.sh --force-register`). Backups already stored in S3 remain readable with their job keys.
