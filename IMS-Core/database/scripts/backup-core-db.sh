#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Creates a consistent backup of the IMS-Core database and secrets volume.
#
#   ./database/scripts/backup-core-db.sh [output-dir]
#
# Output: <dir>/ims-core-<timestamp>/{database.dump,secrets.tar.gz,env}
# The secrets archive contains the master key: store it securely (0600).
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_BASE="${1:-$ROOT_DIR/data/core-backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_BASE/ims-core-$STAMP"

cd "$ROOT_DIR"
umask 077
mkdir -p "$OUT"

echo "[backup] dumping database..."
docker compose exec -T postgres pg_dump -U ims -d ims --format=custom --no-owner > "$OUT/database.dump"

echo "[backup] archiving secrets volume..."
docker run --rm -v ims_ims-secrets:/secrets:ro -v "$OUT":/backup alpine:3.22 \
  tar -czf /backup/secrets.tar.gz -C /secrets .

if [ -f .env ]; then cp .env "$OUT/env"; fi
git rev-parse HEAD > "$OUT/git-ref" 2>/dev/null || true
cp VERSION "$OUT/VERSION"

( cd "$OUT" && sha256sum ./* > SHA256SUMS )
echo "[backup] done: $OUT"
