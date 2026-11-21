# Updating IMS

| Component | How it is updated |
| --- | --- |
| IMS-Core | From a release tag of the private `IMS-Core` repository, started in the dashboard (or on the host), executed by the host updater with backup and automatic rollback |
| IMS-Agent (Ubuntu) | Release package stored on Core, rolled out from the dashboard; each agent verifies, installs, restarts and rolls back on its own |
| IMS-CPanel-Agent | Manual file replacement (shared hosting has no safe self-update path) – see that repository's UPDATE.md |

## 1. Publishing a Core release

1. Merge the changes into `main`, run `npm test` and `npm run typecheck`.
2. Bump `VERSION` (SemVer, e.g. `1.1.0`). The updater refuses a tag whose `VERSION` file does not match.
3. If the database schema changed, create a migration: `npm run prisma:migrate:dev -w backend -- --name <change>` and commit `backend/prisma/migrations/*`. Migrations must be additive/backwards-compatible where possible; they run before the new containers start.
4. Commit, then tag and push:

   ```bash
   git tag -a v1.1.0 -m "IMS-Core 1.1.0"
   git push origin main v1.1.0
   ```

5. Create a GitHub **release** for the tag with release notes. The dashboard reads the latest non-draft release through the GitHub API (`/releases/latest`); the host updater fetches the tag through git.

Optional: sign tags (`git tag -s`) and set `IMS_REQUIRE_SIGNED_TAGS=1` in the updater environment so only verified tags are installed (the signing key must be in the host's GPG keyring).

## 2. Updating Core from the dashboard

Prerequisites: host updater installed (`sudo ./scripts/install-updater.sh`) and **Updates › Release source** configured.

1. **Updates › IMS-Core › Check for updates** (also runs automatically every 6 hours).
2. Review the release notes and click **Install vX.Y.Z** (administrators only).
3. Core writes `data/update/request.json`. The systemd path unit `ims-updater.path` starts `scripts/update.sh --from-request` on the host.
4. Progress is shown live on the page and recorded in the history; Telegram announces the result.

Steps performed by `scripts/update.sh`:

| Step | What happens |
| --- | --- |
| validate | strict SemVer, no downgrade, single run (flock), clean working tree, ≥ 2 GB free |
| fetch | `git fetch --tags origin`, tag must exist (optionally signed) |
| backup | `database/scripts/backup-core-db.sh`: database dump, secrets volume, `.env`, git ref → `data/core-backups/` |
| checkout | `git checkout vX.Y.Z` (the updater runs from a private copy of itself) |
| build | `docker compose build --pull backend web` |
| migrate | `docker compose run --rm --no-deps backend migrate` |
| restart | `docker compose up -d --remove-orphans` |
| health | backend container healthy **and** `/api/v1/health` reports the new version (default timeout 240 s) |

If any step after the backup fails, the updater **rolls back automatically**: previous git revision, previous images, database restored from the fresh backup if migrations had already run, services restarted and health-checked. The result is `rolled_back` (or `failed` with the backup location if even the rollback's health check fails).

The dashboard is unavailable for a few minutes during an update. Agents keep running their schedules, buffer their reports and reconnect automatically.

## 3. Updating Core manually

```bash
cd /opt/ims-core
sudo ./scripts/update.sh --check              # current and latest tag
sudo ./scripts/update.sh --version 1.1.0      # same procedure as the dashboard
```

Options: `--allow-downgrade` (explicit downgrade to an older tag), `--skip-backup` (not recommended). Logs: `data/update/last-run.log`, `journalctl -u ims-updater.service`.

### Manual rollback

If you ever need to return to an earlier release by hand:

```bash
sudo ./scripts/update.sh --version 1.0.0 --allow-downgrade
# if the newer release changed the schema incompatibly, restore the pre-update backup:
sudo ./database/scripts/restore-core-db.sh data/core-backups/ims-core-<timestamp>
```

## 4. Publishing an agent release

In the `IMS-Agent` repository:

```bash
# bump "version" in package.json, commit
npm ci && npm test && npm run typecheck
IMS_RELEASE_SIGNING_KEY=/secure/ims-release-signing.key npm run package
# → release/ims-agent-X.Y.Z.tgz, .sha256, .sig
```

Then either

- **Upload**: Updates › Agents › Upload (package + contents of `.sig`), or
- **GitHub**: create release `vX.Y.Z` in `IMS-Agent` with the three files as assets; Core imports it on **Sync from GitHub** or automatically every 6 hours. The `.sha256` asset is verified during import.

Core inspects every package before accepting it (manifest, version, required files, no absolute paths, `..` or escaping links) and stores it under `data/agent-releases/<version>/`. Revoked releases are never served again.

## 5. Rolling out agent updates

**Updates › Agents**: select servers and **Update selected**, or **Update all outdated**. Each agent receives a signed `agent.update` command and

1. downloads the package over its authenticated channel and checks size + SHA-256,
2. verifies the Ed25519 signature if a release key is pinned (`/etc/ims-agent/release-public.key` or `IMS_RELEASE_PUBLIC_KEY`),
3. extracts to `/opt/ims-agent/releases/<version>`, runs the new build's self-test,
4. switches `/opt/ims-agent/current` atomically and restarts through PM2,
5. confirms the update once it is connected to Core and stable (reported as *Succeeded*).

If the new version crashes three times or cannot reach Core within five minutes, the launcher restores the previous release and the update is reported as *Failed* with the reason; an `AGENT_UPDATE_FAILED` alert is opened.

cPanel agents are listed but excluded from rollouts.

## 6. Troubleshooting updates

| Symptom | Cause / fix |
| --- | --- |
| "The host updater is not installed" | Run `sudo ./scripts/install-updater.sh` on the Core host. |
| "Only the latest published release can be installed" | Click **Check for updates** first; the release must be the latest non-draft GitHub release. |
| Request stays *Requested* | `systemctl status ims-updater.path ims-updater.service`. After 30 minutes the request is marked failed automatically. |
| `working tree has local modifications` | Someone edited tracked files on the host. `git status`; move local changes to `.env` / `docker-compose.override.yml` or revert them. |
| `tag vX.Y.Z not found` | Tag not pushed, or the host's deploy key cannot fetch the repository (`sudo git fetch origin`). |
| GitHub responded 401/403 | Token missing/expired or lacks read access to the repository (Updates › Release source). |
| Agent update *Failed*: signature | The agent pins a release key but the release was uploaded without (or with a wrong) `.sig`. |
| Agent update *Expired* | The agent was offline for 30 minutes after the command was issued; start the rollout again. |
