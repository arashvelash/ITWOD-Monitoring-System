# IMS Agent

Node agent of the **ITWOD Monitoring System (IMS)** for Ubuntu servers. It runs next to your applications, connects **outbound only** to IMS-Core and

- reports heartbeats and resource metrics (CPU, memory, swap, disks, network, load, systemd services),
- runs the backup jobs configured in the dashboard (files, MySQL/MariaDB, PostgreSQL) on its own schedule, even while Core is unreachable,
- stores archives locally and/or in S3-compatible storage, optionally encrypted (AES-256-GCM, chunked `IMSENC1` format),
- executes a small, fixed set of signed commands from Core (`ping`, `config.sync`, `monitor.collect`, `backup.run`, `agent.update`),
- updates itself safely with checksum/signature verification and automatic rollback.

The agent never opens a listening port and never executes arbitrary shell commands. There is no command that deletes projects, databases or disks.

| Document | Content |
| --- | --- |
| [INSTALLATION.md](INSTALLATION.md) | Requirements, one-line install, manual install, configuration, troubleshooting |
| [UPDATE.md](UPDATE.md) | Self-update flow, rollback, manual update, publishing releases |
| [SECURITY.md](SECURITY.md) | Trust model, protocol, file permissions, hardening |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Repository layout, building, testing, release checklist |

## Quick start

On the server (Ubuntu 20.04 or newer, root):

```bash
curl -fsSL https://itwodms.ir/install-agent.sh | sudo bash
```

The script asks for the Core URL and the one-time registration token shown in the dashboard when you add the server (Servers › Add server). It installs Node.js 22 and PM2 if needed, creates the `ims-agent` system user, registers the node and starts it.

```bash
sudo ims-agent status        # identity, configuration version, update state
sudo ims-agent version
tail -f /var/log/ims-agent/agent.log
```

## Layout on the server

| Path | Purpose | Owner / mode |
| --- | --- | --- |
| `/opt/ims-agent/releases/<version>/` | Installed releases (active + previous) | `ims-agent`, 0755 |
| `/opt/ims-agent/current` | Symlink to the active release | |
| `/opt/ims-agent/launcher.js` | Stable entry point started by PM2 (handles rollback) | |
| `/etc/ims-agent/identity.json`, `node.key` | Node ID, node secret, Ed25519 private key | `ims-agent`, 0600 |
| `/etc/ims-agent/agent.env` | Optional overrides (see `.env.example`) | 0600 |
| `/var/lib/ims-agent/` | Config cache, outbox, schedule and update state | 0700 |
| `/var/backups/ims/` | Local backup archives | 0700 |
| `/var/log/ims-agent/` | Logs (rotated by pm2-logrotate) | 0750 |

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build        # dist/ims-agent.js + dist/launcher.js
npm run package      # release/ims-agent-<version>.tgz (+ .sha256, + .sig if signing key set)
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for details. The wire protocol is specified in IMS-Core `docs/PROTOCOL.md`; shared test vectors live in `tests/vectors/`.
