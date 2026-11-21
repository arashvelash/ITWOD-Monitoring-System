# How the cPanel agent works

## Cron cycle (`cron/ims-cron.php`, every 5 minutes)

1. Acquire `state/agent.lock` (`flock`, released automatically if the process dies). If another cycle is still running, exit.
2. `POST /api/v1/agent/reports` with a heartbeat and a metrics sample. The response carries the current `configVersion`.
3. If the version differs from `state/config-cache.json`, `GET /api/v1/agent/config` and cache it (secrets stay in their encrypted envelope).
4. `GET /api/v1/agent/commands`; verify each signed command, execute allow-listed ones, remember executed ids for 24 h (`state/executed-commands.json`) and queue `command.ack` / `command.result` reports.
5. Run due backup jobs (`state/schedule-state.json` remembers the last handled slot per job; missed slots older than the catch-up window are skipped, never back-filled in bulk).
6. Flush the outbox (`state/outbox/*.json`, max 2000 files, oldest dropped first) in batches of up to 100 reports.

Because the agent only runs every five minutes, Core treats a cPanel node as offline only after 17 minutes without a heartbeat.

## Backups

| Type | Implementation | Output |
| --- | --- | --- |
| Files | `FileArchiver` walks the configured paths (relative to `$HOME`), applies excludes, streams a GNU-compatible tar (`TarWriter`, long names via LongLink) into a zlib gzip stream (`gzopen`) | `ims-<job>-<YYYYMMDDTHHMMSSZ>.tar.gz` |
| MySQL | `MysqlDumper` over PDO inside `START TRANSACTION WITH CONSISTENT SNAPSHOT`: table structures, data, then views; wrapped in `SET FOREIGN_KEY_CHECKS=0/1` | `ims-<job>-<…>.sql.gz` |

Optional encryption (`ArchiveEncryptor`) produces the `IMSENC1` format shared with the Ubuntu agent (AES-256-GCM, 1 MiB chunks, `.enc` suffix). Destinations: `LocalDestination` (`~/ims-backups/<jobId>/`) and `S3Destination` (SigV4, single PUT ≤ 5 GB, path-style or virtual-hosted). After a successful upload `Retention` removes the job's own older archives beyond the configured count/age, always keeping the newest.

Each run is reported as `backup.report` (RUNNING, then SUCCESS/FAILED with size, SHA-256, file name, location and a log tail).

## Files and permissions

```
~/ims-agent/                0700
  config/identity.php       0600  node identity (guarded PHP array)
  state/                    0700  config cache, schedule, outbox, lock, executed commands
  logs/agent.log            0600  JSON lines, rotated at 5 MB (one old file kept)
~/ims-backups/              0700  local archives
```

`umask(0077)` is set at start-up, so every file the agent creates is private to the account.

## Compatibility

- PHP 7.4+ (syntax kept 7.4-compatible; test suite run on PHP 8.2), extensions `curl`, `openssl`, `json`, `hash`; `zlib` for backups, `pdo_mysql` for MySQL jobs, `sodium` recommended.
- Stored procedures, functions and triggers are not part of the PDO dump; use the Ubuntu agent (mysqldump) where they matter.
- No Composer, no `exec`/`proc_open`, works with `open_basedir` restrictions as long as `$HOME` is allowed.
- Protocol compatibility is ensured by the shared vectors in `tests/vectors/protocol-v1.json` (same file as IMS-Core and IMS-Agent).
