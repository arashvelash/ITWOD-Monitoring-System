# Repository setup and release workflow

## 1. Repositories

Create three **private** repositories in the ITWOD GitHub organisation:

| Repository | Default branch | Tags | Release assets |
| --- | --- | --- | --- |
| `IMS-Core` | `main` | `vX.Y.Z` (matches `VERSION`) | – (installed from the tag) |
| `IMS-Agent` | `main` | `vX.Y.Z` (matches `package.json`) | `ims-agent-X.Y.Z.tgz`, `.sha256`, `.sig` |
| `IMS-CPanel-Agent` | `main` | `vX.Y.Z` (matches `VERSION`) | optional zip for manual upload |

Recommended branch protection for `main`: pull requests required, status checks (`npm ci && npm run typecheck && npm test`; PHP: `php tests/run-tests.php`), no force pushes, signed commits optional.

Initial push (per repository):

```bash
git init -b main
git add .
git commit -m "Initial import"
git remote add origin git@github.com:<org>/<repo>.git
git push -u origin main
```

Never commit `.env`, `data/`, `release/`, signing keys (`*.key`) or `config/identity.php` – the `.gitignore` files exclude them.

## 2. Access for the Core host (git)

The host updater runs `git fetch` in the Core checkout. Give the host a **read-only deploy key** for `IMS-Core`:

```bash
sudo ssh-keygen -t ed25519 -N "" -C "ims-core-host" -f /root/.ssh/ims_core_deploy
sudo cat /root/.ssh/ims_core_deploy.pub     # GitHub › IMS-Core › Settings › Deploy keys › Add (read-only)
sudo tee -a /root/.ssh/config <<'EOF'
Host github.com
  IdentityFile /root/.ssh/ims_core_deploy
  IdentitiesOnly yes
EOF
sudo ssh -T git@github.com                  # accept the host key once
sudo git clone git@github.com:<org>/IMS-Core.git /opt/ims-core
```

## 3. Access for the dashboard (GitHub API)

Core reads release metadata and downloads agent packages through the GitHub REST API. Create a **fine-grained personal access token** (or a GitHub App installation token) with:

- Repository access: only `IMS-Core` and `IMS-Agent`
- Permissions: *Contents: Read-only* (includes releases), *Metadata: Read-only*
- An expiry date – put a reminder in your calendar to rotate it

Enter it in **Updates › Release source** together with the repository names (`<org>/IMS-Core`, `<org>/IMS-Agent`). The token is stored encrypted and never returned by the API.

## 4. Release signing key for agents

Create the key pair once on an offline/admin machine:

```bash
cd IMS-Agent
node scripts/build.mjs --keygen ~/ims-release-keys
# → ims-release-signing.key (private, keep offline, back it up)
# → ims-release-public.key  (public, distribute to servers)
```

Pin the public key on every Ubuntu server:

```bash
echo '<base64 public key>' | sudo tee /etc/ims-agent/release-public.key
sudo chown ims-agent:ims-agent /etc/ims-agent/release-public.key && sudo chmod 0644 /etc/ims-agent/release-public.key
```

From then on the agent refuses unsigned or wrongly signed updates.

## 5. Release checklists

### IMS-Core

1. `npm ci && npm run typecheck && npm test`
2. Integration test on a staging host: `docker compose up -d --build`, setup wizard, register one Ubuntu and one cPanel agent, run a backup, trigger an alert.
3. Bump `VERSION`, add migrations if the schema changed, update docs.
4. `git tag -a vX.Y.Z -m "IMS-Core X.Y.Z" && git push origin main vX.Y.Z`
5. Create the GitHub release with notes (what changed, migrations, manual steps).

### IMS-Agent

1. `npm ci && npm run typecheck && npm test`
2. Bump `version` in `package.json`.
3. `IMS_RELEASE_SIGNING_KEY=<path> npm run package`
4. Tag `vX.Y.Z`, create the GitHub release and attach `release/ims-agent-X.Y.Z.tgz`, `.sha256` and `.sig`.
5. In the dashboard: **Updates › Agents › Sync from GitHub**, update one server first, then the rest.

### IMS-CPanel-Agent

1. `php -d extension=sodium tests/run-tests.php` on PHP 7.4 and the newest supported PHP.
2. Bump `VERSION`, tag `vX.Y.Z`, create the release (optionally attach a zip of `src/`, `cron/`, `config/`, `VERSION`).
3. Update the accounts manually as described in its UPDATE.md.
