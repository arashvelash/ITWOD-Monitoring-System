#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# IMS Agent installer (Ubuntu 20.04+). Normally started by the bootstrap
# script served by Core:
#
#   curl -fsSL https://itwodms.ir/install-agent.sh | sudo bash
#
# Manual use from an extracted package:
#   sudo IMS_REGISTRATION_TOKEN=imsr_... ./installer/install.sh --core-url https://itwodms.ir
#
# Options:
#   --core-url <url>      Core URL (required for registration)
#   --package-dir <dir>   extracted package (default: parent of this script)
#   --package <file>      original .tgz (informational)
#   --run-as-root         run the agent as root (needed only if backups must read
#                         files the ims-agent user cannot access)
#   --skip-register       install/upgrade files only
#   --force-register      register again with a new token (replaces the identity)
#
# Touches only: /opt/ims-agent, /etc/ims-agent, /var/lib/ims-agent,
# /var/log/ims-agent, /var/backups/ims, /usr/local/bin/ims-agent, the
# pm2-<user> systemd unit, and installs Node.js 22 + PM2 when missing.
# ---------------------------------------------------------------------------
set -euo pipefail
umask 022

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CORE_URL=""
RUN_USER="ims-agent"
REGISTER=1
FORCE_REGISTER=0
PM2_VERSION="6.0.14"
NODE_MAJOR=22

INSTALL_DIR=/opt/ims-agent
CONFIG_DIR=/etc/ims-agent
STATE_DIR=/var/lib/ims-agent
LOG_DIR=/var/log/ims-agent
BACKUP_DIR=/var/backups/ims

log()  { printf '\033[1;34m[ims-agent]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[ims-agent]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[ims-agent] error:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --core-url) CORE_URL="${2:-}"; shift 2 ;;
    --package-dir) PKG_DIR="$(cd "${2:?}" && pwd)"; shift 2 ;;
    --package) shift 2 ;;
    --run-as-root) RUN_USER="root"; shift ;;
    --skip-register) REGISTER=0; shift ;;
    --force-register) FORCE_REGISTER=1; shift ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || fail "run as root"
[ -f "$PKG_DIR/manifest.json" ] || fail "manifest.json not found in $PKG_DIR"
command -v systemctl >/dev/null || fail "systemd is required"

# ---- Node.js ----------------------------------------------------------------------
node_ok() {
  command -v node >/dev/null || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=19)?0:1)'
}
if ! node_ok; then
  log "installing Node.js ${NODE_MAJOR}.x from the official NodeSource repository"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
  node_ok || fail "Node.js >= 20.19 is required"
fi
NODE_BIN="$(command -v node)"
log "using Node.js $(node --version)"

if ! command -v pm2 >/dev/null; then
  log "installing PM2 ${PM2_VERSION}"
  npm install -g --no-fund --no-audit "pm2@${PM2_VERSION}" >/dev/null
fi
PM2_BIN="$(command -v pm2)"

VERSION="$(node -e 'const m=require(process.argv[1]);if(m.name!=="ims-agent")process.exit(1);process.stdout.write(m.version)' "$PKG_DIR/manifest.json")" || fail "invalid manifest"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || fail "invalid version in manifest"

# ---- user & directories ------------------------------------------------------------
if [ "$RUN_USER" != "root" ] && ! id -u "$RUN_USER" >/dev/null 2>&1; then
  log "creating system user $RUN_USER"
  useradd --system --home-dir "$STATE_DIR" --shell /usr/sbin/nologin --user-group "$RUN_USER"
fi
RUN_HOME="$STATE_DIR"
[ "$RUN_USER" = "root" ] && RUN_HOME=/root

install -d -m 0755 -o "$RUN_USER" -g "$RUN_USER" "$INSTALL_DIR" "$INSTALL_DIR/releases"
install -d -m 0700 -o "$RUN_USER" -g "$RUN_USER" "$CONFIG_DIR" "$STATE_DIR" "$BACKUP_DIR"
install -d -m 0750 -o "$RUN_USER" -g "$RUN_USER" "$LOG_DIR"
echo "$RUN_USER" > "$CONFIG_DIR/run-as"
chmod 0644 "$CONFIG_DIR/run-as"
if [ ! -f "$CONFIG_DIR/agent.env" ]; then
  printf '# IMS Agent overrides (see .env.example in the IMS-Agent repository)\nIMS_AGENT_LOG_LEVEL=info\n' > "$CONFIG_DIR/agent.env"
  chown "$RUN_USER:$RUN_USER" "$CONFIG_DIR/agent.env"
  chmod 0600 "$CONFIG_DIR/agent.env"
fi

# ---- release files -----------------------------------------------------------------
RELEASE="$INSTALL_DIR/releases/$VERSION"
log "installing IMS Agent $VERSION into $RELEASE"
rm -rf "$RELEASE.tmp"
mkdir -p "$RELEASE.tmp"
cp -R "$PKG_DIR/." "$RELEASE.tmp/"
chown -R "$RUN_USER:$RUN_USER" "$RELEASE.tmp"
rm -rf "$RELEASE"
mv "$RELEASE.tmp" "$RELEASE"
ln -sfn "$RELEASE" "$INSTALL_DIR/current.next"
mv -Tf "$INSTALL_DIR/current.next" "$INSTALL_DIR/current"
chown -h "$RUN_USER:$RUN_USER" "$INSTALL_DIR/current"
install -m 0755 -o "$RUN_USER" -g "$RUN_USER" "$RELEASE/dist/launcher.js" "$INSTALL_DIR/launcher.js"
install -m 0644 -o root -g root "$RELEASE/installer/ecosystem.config.cjs" "$INSTALL_DIR/ecosystem.config.cjs"
install -m 0755 -o root -g root "$RELEASE/installer/ims-agent.sh" /usr/local/bin/ims-agent
# A fresh manual install supersedes any unfinished self-update.
rm -f "$STATE_DIR/update-state.json"

as_agent() {
  if [ "$RUN_USER" = "root" ]; then "$@"; else runuser -u "$RUN_USER" -- "$@"; fi
}

# ---- registration ------------------------------------------------------------------
if [ "$REGISTER" = "1" ]; then
  if [ -f "$CONFIG_DIR/identity.json" ] && [ "$FORCE_REGISTER" != "1" ]; then
    log "already registered ($(as_agent "$NODE_BIN" "$INSTALL_DIR/launcher.js" status 2>/dev/null | sed -n 's/.*"nodeId": "\(.*\)".*/\1/p')); keeping the identity"
  else
    [ -n "$CORE_URL" ] || fail "--core-url is required for registration"
    [ -n "${IMS_REGISTRATION_TOKEN:-}" ] || fail "IMS_REGISTRATION_TOKEN is not set"
    TOKEN_FILE="$(mktemp "$STATE_DIR/.token.XXXXXX")"
    trap 'rm -f "$TOKEN_FILE"' EXIT
    printf '%s' "$IMS_REGISTRATION_TOKEN" > "$TOKEN_FILE"
    chown "$RUN_USER:$RUN_USER" "$TOKEN_FILE"
    chmod 0600 "$TOKEN_FILE"
    unset IMS_REGISTRATION_TOKEN
    FORCE=()
    [ "$FORCE_REGISTER" = "1" ] && FORCE=(--force)
    log "registering with $CORE_URL"
    as_agent "$NODE_BIN" "$INSTALL_DIR/launcher.js" register --core-url "$CORE_URL" --token-file "$TOKEN_FILE" "${FORCE[@]}"
    rm -f "$TOKEN_FILE"
  fi
fi

# ---- PM2 service -------------------------------------------------------------------
log "starting the agent with PM2 (user $RUN_USER)"
as_agent env HOME="$RUN_HOME" PM2_HOME="$RUN_HOME/.pm2" "$PM2_BIN" startOrReload "$INSTALL_DIR/ecosystem.config.cjs" --update-env >/dev/null
as_agent env HOME="$RUN_HOME" PM2_HOME="$RUN_HOME/.pm2" "$PM2_BIN" save --force >/dev/null
env PATH="$PATH:$(dirname "$NODE_BIN")" "$PM2_BIN" startup systemd -u "$RUN_USER" --hp "$RUN_HOME" >/dev/null
systemctl enable "pm2-$RUN_USER" >/dev/null 2>&1 || true

if ! as_agent env HOME="$RUN_HOME" PM2_HOME="$RUN_HOME/.pm2" "$PM2_BIN" describe pm2-logrotate >/dev/null 2>&1; then
  log "installing pm2-logrotate"
  as_agent env HOME="$RUN_HOME" PM2_HOME="$RUN_HOME/.pm2" "$PM2_BIN" install pm2-logrotate >/dev/null 2>&1 || warn "pm2-logrotate could not be installed (logs will not rotate)"
  as_agent env HOME="$RUN_HOME" PM2_HOME="$RUN_HOME/.pm2" "$PM2_BIN" set pm2-logrotate:max_size 10M >/dev/null 2>&1 || true
  as_agent env HOME="$RUN_HOME" PM2_HOME="$RUN_HOME/.pm2" "$PM2_BIN" set pm2-logrotate:retain 7 >/dev/null 2>&1 || true
  as_agent env HOME="$RUN_HOME" PM2_HOME="$RUN_HOME/.pm2" "$PM2_BIN" set pm2-logrotate:compress true >/dev/null 2>&1 || true
fi

# Keep only the active and the previous release.
find "$INSTALL_DIR/releases" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex '.*/[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?' \
  | sort -V | head -n -2 | grep -v -x -F "$RELEASE" | xargs -r rm -rf || true

log "IMS Agent $VERSION is installed and running."
[ "$RUN_USER" != "root" ] && log "Backups run as '$RUN_USER'. Grant read access to backup sources (e.g. usermod -aG www-data $RUN_USER) or reinstall with --run-as-root."
log "Status: sudo ims-agent status   ·   Logs: $LOG_DIR/"
