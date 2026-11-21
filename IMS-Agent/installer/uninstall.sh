#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Removes the IMS Agent program from this server.
#
#   sudo /opt/ims-agent/current/installer/uninstall.sh [--purge]
#
# Default: stops the agent and removes /opt/ims-agent and the CLI wrapper.
# Identity, state and logs are kept so the node can be reinstalled.
# --purge additionally removes /etc/ims-agent, /var/lib/ims-agent,
# /var/log/ims-agent and the ims-agent user.
#
# Backup archives in /var/backups/ims are NEVER removed by this script.
# Revoke the node in the IMS dashboard as well.
# ---------------------------------------------------------------------------
set -euo pipefail

PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

RUN_USER="$(cat /etc/ims-agent/run-as 2>/dev/null || echo ims-agent)"
RUN_HOME=/var/lib/ims-agent
[ "$RUN_USER" = "root" ] && RUN_HOME=/root

if command -v pm2 >/dev/null; then
  if [ "$RUN_USER" = "root" ]; then
    pm2 delete ims-agent >/dev/null 2>&1 || true
    pm2 save --force >/dev/null 2>&1 || true
  else
    runuser -u "$RUN_USER" -- env HOME="$RUN_HOME" PM2_HOME="$RUN_HOME/.pm2" pm2 delete ims-agent >/dev/null 2>&1 || true
    runuser -u "$RUN_USER" -- env HOME="$RUN_HOME" PM2_HOME="$RUN_HOME/.pm2" pm2 kill >/dev/null 2>&1 || true
    pm2 unstartup systemd -u "$RUN_USER" --hp "$RUN_HOME" >/dev/null 2>&1 || true
  fi
fi

rm -rf /opt/ims-agent
rm -f /usr/local/bin/ims-agent
echo "[ims-agent] program files removed"

if [ "$PURGE" = "1" ]; then
  rm -rf /etc/ims-agent /var/lib/ims-agent /var/log/ims-agent
  if [ "$RUN_USER" = "ims-agent" ] && id -u ims-agent >/dev/null 2>&1; then userdel ims-agent || true; fi
  echo "[ims-agent] configuration, state and logs removed"
fi
echo "[ims-agent] backups in /var/backups/ims were left untouched"
