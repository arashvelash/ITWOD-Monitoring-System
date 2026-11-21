#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Restores the IMS-Core database from a dump created by backup-core-db.sh.
# This replaces the CURRENT Core database content (managed servers are not
# touched). Requires typing the confirmation phrase unless --yes is given
# (used by the automatic rollback in scripts/update.sh).
#
#   ./database/scripts/restore-core-db.sh <backup-dir> [--yes]
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="${1:?usage: restore-core-db.sh <backup-dir> [--yes]}"
CONFIRM="${2:-}"

[ -f "$SRC/database.dump" ] || { echo "No database.dump in $SRC" >&2; exit 1; }
( cd "$SRC" && sha256sum -c --quiet SHA256SUMS ) || { echo "Checksum verification failed" >&2; exit 1; }

if [ "$CONFIRM" != "--yes" ]; then
  echo "This will replace the IMS-Core database with the backup from:"
  echo "  $SRC"
  read -r -p "Type RESTORE to continue: " answer
  [ "$answer" = "RESTORE" ] || { echo "Aborted."; exit 1; }
fi

cd "$ROOT_DIR"
echo "[restore] stopping backend..."
docker compose stop backend
echo "[restore] restoring database..."
docker compose exec -T postgres pg_restore -U ims -d ims --clean --if-exists --no-owner --single-transaction < "$SRC/database.dump"
echo "[restore] starting backend..."
docker compose start backend
echo "[restore] done"
