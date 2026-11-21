#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Installs the host-side updater (systemd path + service unit).
#
#   sudo ./scripts/install-updater.sh            # install / refresh
#   sudo ./scripts/install-updater.sh --remove   # uninstall the units only
#
# The path unit watches data/update/request.json, which the dashboard writes
# when an administrator clicks "Install update". The service then runs
# scripts/update.sh --from-request as root on the host. No Docker socket or
# host access is ever given to the containers.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR=/etc/systemd/system
UPDATE_DIR="$ROOT_DIR/data/update"

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemd is required" >&2; exit 1; }
case "$ROOT_DIR" in *[[:space:]]*) echo "The IMS-Core path must not contain spaces: $ROOT_DIR" >&2; exit 1 ;; esac

if [ "${1:-}" = "--remove" ]; then
  systemctl disable --now ims-updater.path 2>/dev/null || true
  rm -f "$UNIT_DIR/ims-updater.path" "$UNIT_DIR/ims-updater.service" "$UPDATE_DIR/updater.json"
  systemctl daemon-reload
  echo "[ims] updater removed"
  exit 0
fi

mkdir -p "$UPDATE_DIR"
chmod 0755 "$ROOT_DIR/scripts/update.sh"

sed "s#@ROOT_DIR@#$ROOT_DIR#g" "$ROOT_DIR/scripts/systemd/ims-updater.service" > "$UNIT_DIR/ims-updater.service"
sed "s#@ROOT_DIR@#$ROOT_DIR#g" "$ROOT_DIR/scripts/systemd/ims-updater.path" > "$UNIT_DIR/ims-updater.path"
chmod 0644 "$UNIT_DIR/ims-updater.service" "$UNIT_DIR/ims-updater.path"

systemctl daemon-reload
systemctl enable --now ims-updater.path

printf '{"installed":true,"installedAt":"%s","root":"%s"}\n' "$(date -u +%FT%TZ)" "$ROOT_DIR" > "$UPDATE_DIR/updater.json"
chmod 0644 "$UPDATE_DIR/updater.json"

echo "[ims] updater installed. Updates can now be started from Dashboard › Updates."
echo "[ims] logs: journalctl -u ims-updater.service -f   (and $UPDATE_DIR/last-run.log)"
