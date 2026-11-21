# Updating the IMS Agent

Agents are updated from the IMS dashboard. No SSH access to the servers is needed.

## 1. How a self-update works

```
Core ── signed agent.update {version, sha256, sizeBytes, signature} ──▶ agent
agent:  download /api/v1/agent/releases/<v>/package (signed request, size-limited)
        verify size + SHA-256 (+ Ed25519 signature if a release key is pinned)
        extract to /opt/ims-agent/releases/<v>   (strict extractor: files/dirs only, no ../, no links)
        run "<v>/dist/ims-agent.js self-test"
        write update-state.json {state: pending, previousTarget, commandId}
        switch /opt/ims-agent/current → releases/<v> atomically, exit
PM2  ▶  launcher.js ▶ new release
new release connects to Core, stays up 20 s → state committed → reports SUCCEEDED
```

Rollback is automatic and handled by the stable launcher (`/opt/ims-agent/launcher.js`), which is only replaced after a release has been confirmed:

| Condition | Result |
| --- | --- |
| New release crashes 3 times during start-up | launcher restores the previous release |
| New release cannot connect to Core within 5 minutes | it requests a rollback, exits, launcher restores the previous release |
| Download/checksum/signature/self-test fails | nothing is switched; the command fails with the reason |

After a rollback the previous version reports the update as *Failed* with the reason, and Core opens an `AGENT_UPDATE_FAILED` alert. Only the active and the previous release are kept on disk.

A backup that is running when the update arrives is allowed to finish first (up to 20 minutes) before the agent restarts. Scheduled jobs resume on the new version and never run twice for the same slot.

## 2. Rolling out an update

1. Publish the release (section 3) and make it available on Core (**Updates › Agents › Upload** or **Sync from GitHub**).
2. **Updates › Agents**: update a single server first, check that it reports *Succeeded* and the new version.
3. **Update all outdated**. Offline agents receive the command when they reconnect (it expires after 30 minutes).

## 3. Building and publishing a release

```bash
git pull
npm ci
npm run typecheck && npm test
# bump "version" in package.json (SemVer), commit
IMS_RELEASE_SIGNING_KEY=/secure/ims-release-signing.key npm run package
```

Output in `release/`:

| File | Purpose |
| --- | --- |
| `ims-agent-X.Y.Z.tgz` | Package: `manifest.json`, `dist/ims-agent.js` (single-file bundle), `dist/launcher.js`, `installer/*`, `README.md` |
| `ims-agent-X.Y.Z.tgz.sha256` | Checksum (verified by Core on GitHub import) |
| `ims-agent-X.Y.Z.tgz.sig` | Ed25519 signature over the SHA-256 hex digest (only with a signing key) |

Publish either by uploading the package (and the signature text) in the dashboard, or by tagging `vX.Y.Z` and attaching the three files to a GitHub release of `IMS-Agent`.

Create the signing key once with `node scripts/build.mjs --keygen <dir>` and keep the private key offline.

## 4. Manual update on a server

Useful when a server cannot receive commands (e.g. very old version, broken update state):

```bash
curl -fsSLO https://<your-build-host>/ims-agent-X.Y.Z.tgz        # or copy it with scp
sha256sum ims-agent-X.Y.Z.tgz                                     # compare with the .sha256 file
mkdir /tmp/ims && tar -xzf ims-agent-X.Y.Z.tgz -C /tmp/ims
sudo /tmp/ims/installer/install.sh --skip-register
```

The installer keeps the identity and configuration, installs the new release, resets any unfinished self-update state and reloads PM2.

The bootstrap command also works for upgrades; it detects the existing identity and skips registration:

```bash
curl -fsSL https://itwodms.ir/install-agent.sh | sudo bash    # needs a valid (unused) registration token
```

## 5. Troubleshooting

| Problem | Fix |
| --- | --- |
| *Failed*: "requires signed releases" | The server pins a release key; upload the release with its `.sig` |
| *Failed*: "signature verification failed" | Wrong signing key or modified package – rebuild and re-sign |
| *Failed*: "does not match the published size/checksum" | Corrupted upload/download; upload the package again |
| *Failed*: "could not connect to Core within 5 minutes" | New version cannot reach Core (network, TLS, clock); check `error.log` – the previous version is running again |
| *Expired* | Agent was offline; retry the rollout |
| `A previous update has not finished yet` | Inspect `sudo ims-agent status` (`updateState`); if stuck, run the manual update (section 4) |

`/var/lib/ims-agent/update-state.json` shows the current update state; never edit it while the agent is running.
