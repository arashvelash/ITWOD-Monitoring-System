# IMS-Core database

PostgreSQL 17, accessed exclusively through Prisma (parameterised queries only).

| Path                                   | Purpose                                             |
| -------------------------------------- | --------------------------------------------------- |
| `../backend/prisma/schema.prisma`      | Source of truth for the schema                      |
| `../backend/prisma/migrations/`        | Versioned SQL migrations (applied on backend start) |
| `init/`                                | One-time cluster hardening run by the postgres image |
| `scripts/backup-core-db.sh`            | Consistent dump of the Core database                |
| `scripts/restore-core-db.sh`           | Restore a dump (interactive confirmation)           |

## Entities

| Table                 | Description                                                                 |
| --------------------- | --------------------------------------------------------------------------- |
| `users`               | Dashboard accounts. `password_hash` is Argon2id. Lockout counters.         |
| `sessions`            | Login sessions (idle + absolute expiry, revocation reason).                 |
| `refresh_tokens`      | Rotating refresh tokens, SHA-256 hashed, `used_at` for reuse detection.     |
| `servers`             | Managed nodes. `node_id` (`ims-node-0001`), status, agent version, latest metrics snapshot, `config_version`. |
| `node_credentials`    | Encrypted node secret, Ed25519 public key + fingerprint.                    |
| `registration_tokens` | One-time, expiring tokens (hash + short prefix for display).                |
| `node_commands`       | Durable command queue. Payload never contains secrets.                      |
| `projects`            | Logical grouping of backup jobs (e.g. one customer website).                |
| `backup_jobs`         | Job definition. Credentials in `*_encrypted` columns only.                  |
| `backup_runs`         | Every execution with status, size, checksum, location, log tail.            |
| `node_metrics`        | Time series samples (retention configurable, default 30 days).              |
| `alerts`              | Alert lifecycle with de-duplication fingerprint.                           |
| `telegram_links`      | Chat ↔ user bindings. `telegram_link_codes`: one-time link codes (hashed). |
| `audit_logs`          | Append-only audit trail (secrets scrubbed from metadata).                   |
| `system_settings`     | Settings sections (JSON) and encrypted secret settings.                     |
| `agent_releases`      | Agent packages known to Core (SHA-256, optional signature).                 |
| `core_updates`        | Core update history.                                                        |

## Encryption at rest

Secret columns are encrypted with AES-256-GCM using the master key
(`IMS_MASTER_KEY`, generated into the `ims-secrets` volume). Each ciphertext is
bound to its row via AAD (e.g. `node-secret:<serverId>`), so ciphertexts cannot
be swapped between rows. **Back up the master key together with the database** –
without it encrypted columns cannot be recovered.

## Creating a new migration (development)

```bash
cd backend
export DATABASE_URL=postgresql://ims:ims@localhost:5432/ims
npx prisma migrate dev --name <change_name>
```

Commit the generated folder under `backend/prisma/migrations/`. Production applies
migrations with `prisma migrate deploy` (automatically on container start and as a
dedicated step during updates).
