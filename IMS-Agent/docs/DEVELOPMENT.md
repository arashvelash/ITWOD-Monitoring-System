# IMS Agent – Development

## Layout

```
src/           CLI (index.ts), agent wiring, transport (ws-client, core-client), protocol, identity, paths, logger
services/      command, config, outbox, scheduler, backup, monitor services
modules/
  backup/      sources (tar / mysqldump / pg_dump), pipeline, naming, retention, path rules
  crypto/      IMSENC1 archive encryption
  destinations/ local and S3 destinations
  metrics/     cpu, memory, disk, network, systemd services, collector
updater/       update service, launcher, update state, strict tar extractor
installer/     install.sh, uninstall.sh, PM2 ecosystem file, CLI wrapper
scripts/       build.mjs (esbuild bundle, packaging, signing, key generation)
tests/         Vitest suites + shared protocol vectors (tests/vectors/protocol-v1.json)
```

## Tooling

| Tool | Version (pinned) |
| --- | --- |
| Node.js | ≥ 20.19 (CI and servers: 22 LTS) |
| TypeScript | 5.9.3 |
| esbuild | 0.28.2 |
| Vitest | 4.1.11 |
| Runtime deps | `ws`, `cron-parser`, `@aws-sdk/client-s3`, `@aws-sdk/lib-storage` (all bundled into `dist/ims-agent.js`) |

```bash
npm ci
npm run typecheck
npm test
npm run build                  # dist/ims-agent.js + dist/launcher.js
npm run package                # release/ims-agent-<version>.tgz (+ .sha256 / .sig)
node dist/ims-agent.js self-test
```

`npm test` includes an end-to-end check of the latest package in `release/` (extraction with the updater's extractor and a boot through the launcher) when one has been built.

## Running locally against a development Core

```bash
export IMS_AGENT_CONFIG_DIR=$PWD/.dev/etc IMS_AGENT_STATE_DIR=$PWD/.dev/state IMS_AGENT_INSTALL_DIR=$PWD/.dev/opt IMS_AGENT_BACKUP_DIR=$PWD/.dev/backups
export IMS_ALLOW_INSECURE_CORE=true            # only for http://localhost Core
IMS_REGISTRATION_TOKEN=imsr_… node dist/ims-agent.js register --core-url http://localhost:3000
node dist/ims-agent.js run
```

On Windows the metrics collectors fall back to `os` APIs (no `/proc`), service checks report nothing.

## Protocol changes

The wire protocol is specified in IMS-Core `docs/PROTOCOL.md`. Any change must

1. update the specification,
2. regenerate the shared vectors (`npm run vectors` in IMS-Core) and copy `protocol-v1.json` to `tests/vectors/` here and in IMS-CPanel-Agent,
3. keep older agents working (Core accepts both formats during a transition) or bump the protocol version.

## Release checklist

1. `npm ci && npm run typecheck && npm test`
2. Bump `version` in `package.json`
3. `IMS_RELEASE_SIGNING_KEY=<key> npm run package`
4. Tag `vX.Y.Z`, GitHub release with `.tgz`, `.sha256`, `.sig`
5. Core: Updates › Agents › Sync from GitHub → update one server → update all
