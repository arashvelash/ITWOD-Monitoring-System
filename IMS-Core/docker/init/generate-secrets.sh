#!/bin/sh
# ---------------------------------------------------------------------------
# IMS first-start secret generation (runs in the one-shot `init` container).
#
# Creates each secret only if it does not exist yet, so restarts and updates
# never rotate secrets implicitly. Values come from /dev/urandom.
#
#   postgres_password   hex, 48 chars
#   redis_password      hex, 48 chars
#   master_key          base64, 32 bytes (AES-256-GCM key for secrets at rest)
#   jwt_access_secret   hex, 96 chars
#   setup_token         hex, 48 chars (only needed for the first-run wizard)
# ---------------------------------------------------------------------------
set -eu

SECRETS_DIR=/secrets
DATA_DIR=/data
APP_UID=1000

umask 077
mkdir -p "$SECRETS_DIR"

rand_hex() { head -c "$1" /dev/urandom | od -An -vtx1 | tr -d ' \n'; }
rand_b64() { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }

create() {
  name="$1"; value="$2"
  if [ ! -s "$SECRETS_DIR/$name" ]; then
    printf '%s' "$value" > "$SECRETS_DIR/$name"
    echo "[ims-init] generated $name"
  else
    echo "[ims-init] $name already exists, keeping it"
  fi
}

create postgres_password "$(rand_hex 24)"
create redis_password "$(rand_hex 24)"
create master_key "$(rand_b64 32)"
create jwt_access_secret "$(rand_hex 48)"
create setup_token "$(rand_hex 24)"

# The volume is only mounted into IMS containers (read-only). Files must be
# readable by the non-root users of postgres (70), redis (999) and backend (1000).
chmod 0755 "$SECRETS_DIR"
chmod 0444 "$SECRETS_DIR"/*

# Shared data directory (bind mount ./data): writable by the backend user.
mkdir -p "$DATA_DIR/update" "$DATA_DIR/agent-releases" "$DATA_DIR/tmp" "$DATA_DIR/core-backups"
chown -R "$APP_UID:$APP_UID" "$DATA_DIR/update" "$DATA_DIR/agent-releases" "$DATA_DIR/tmp"
chmod 0750 "$DATA_DIR/agent-releases" "$DATA_DIR/tmp"
# Stale partial uploads from an interrupted request.
find "$DATA_DIR/tmp" -type f -name 'upload-*.tgz' -mmin +60 -delete 2>/dev/null || true
chmod 0755 "$DATA_DIR/update"
chmod 0700 "$DATA_DIR/core-backups"

echo "[ims-init] done"
