#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# IMS-Core host updater
#
#   sudo ./scripts/update.sh --version 1.4.0         # manual update
#   sudo ./scripts/update.sh --from-request          # used by ims-updater.service
#   sudo ./scripts/update.sh --check                 # show current / available versions
#
# Options: --allow-downgrade  --skip-backup (not recommended)
#
# Steps: validate → fetch tag → back up database, secrets and config →
# checkout tag → build images → run migrations → restart → health check.
# Any failure after the backup triggers an automatic rollback to the previous
# git revision, images and (if migrations already ran) database.
#
# The dashboard can only *request* an update by writing
# data/update/request.json; everything is validated again here. Only tags that
# exist in the configured git remote can be installed.
# ---------------------------------------------------------------------------
set -euo pipefail
umask 022

# Re-execute from a private copy: `git checkout` may replace this very file.
if [ -z "${IMS_UPDATER_COPY:-}" ]; then
  ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  COPY="$(mktemp /tmp/ims-update.XXXXXX.sh)"
  cp "${BASH_SOURCE[0]}" "$COPY"
  IMS_UPDATER_COPY="$COPY" IMS_ROOT_DIR="$ROOT_DIR" exec bash "$COPY" "$@"
fi
trap 'rm -f "$IMS_UPDATER_COPY"' EXIT

ROOT_DIR="$IMS_ROOT_DIR"
UPDATE_DIR="$ROOT_DIR/data/update"
REQUEST="$UPDATE_DIR/request.json"
STATUS="$UPDATE_DIR/status.json"
LOG="$UPDATE_DIR/last-run.log"
LOCK="$UPDATE_DIR/.lock"
HEALTH_TIMEOUT="${IMS_HEALTH_TIMEOUT:-240}"
VERSION_RE='^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(-[0-9A-Za-z]+(\.[0-9A-Za-z]+){0,4})?$'
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

TARGET=""
REQUEST_ID=""
MODE="manual"
ALLOW_DOWNGRADE=0
SKIP_BACKUP=0

log() { printf '%s [ims-update] %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "error: $*"; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) TARGET="${2:-}"; shift 2 ;;
    --from-request) MODE="request"; shift ;;
    --check) MODE="check"; shift ;;
    --allow-downgrade) ALLOW_DOWNGRADE=1; shift ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run as root"
cd "$ROOT_DIR"
command -v git >/dev/null || die "git is required"
docker compose version >/dev/null 2>&1 || die "docker compose plugin is required"
mkdir -p "$UPDATE_DIR"

CURRENT_VERSION="$(tr -d '[:space:]' < VERSION)"

if [ "$MODE" = "check" ]; then
  git fetch --quiet --tags origin || die "git fetch failed"
  LATEST="$(git tag -l 'v*' | sed 's/^v//' | grep -E "$VERSION_RE" | sort -V | tail -n1 || true)"
  echo "current: $CURRENT_VERSION"
  echo "latest:  ${LATEST:-none}"
  exit 0
fi

# ---- status file (read by the dashboard) -----------------------------------
json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\r\t' '   ' | cut -c1-1500; }
STARTED_AT="$(date -u +%FT%TZ)"
write_status() {
  local state="$1" step="$2" message="${3:-}" finished=""
  case "$state" in succeeded|failed|rolled_back) finished=",\"finishedAt\":\"$(date -u +%FT%TZ)\"" ;; esac
  local tmp="$STATUS.tmp" id=""
  [ -n "$REQUEST_ID" ] && id="\"id\":\"$REQUEST_ID\","
  printf '{%s"state":"%s","step":"%s","message":"%s","fromVersion":"%s","targetVersion":"%s","startedAt":"%s","updatedAt":"%s"%s}\n' \
    "$id" "$state" "$step" "$(json_escape "$message")" "$CURRENT_VERSION" "$(json_escape "${TARGET:-}")" "$STARTED_AT" "$(date -u +%FT%TZ)" "$finished" > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$STATUS"
}

# ---- read the dashboard request ---------------------------------------------
if [ "$MODE" = "request" ]; then
  [ -f "$REQUEST" ] || { log "no pending request"; exit 0; }
  RAW="$(head -c 4096 "$REQUEST")"
  # Remove first so a bad request can never re-trigger the path unit in a loop.
  rm -f "$REQUEST"
  REQUEST_ID="$(printf '%s' "$RAW" | sed -n 's/.*"id":"\([0-9a-f-]*\)".*/\1/p')"
  TARGET="$(printf '%s' "$RAW" | sed -n 's/.*"version":"\([0-9A-Za-z.-]*\)".*/\1/p')"
  [[ "$REQUEST_ID" =~ $UUID_RE ]] || REQUEST_ID=""
fi

TARGET="${TARGET#v}"
if ! [[ "$TARGET" =~ $VERSION_RE ]]; then
  write_status failed validate "Invalid target version"
  die "invalid target version: '${TARGET}'"
fi

# ---- single run at a time ------------------------------------------------------
exec 9>"$LOCK"
if ! flock -n 9; then
  write_status failed validate "Another update is already running"
  die "another update is already running"
fi

: > "$LOG"
chmod 0644 "$LOG"
exec > >(tee -a "$LOG") 2>&1
log "IMS-Core update $CURRENT_VERSION -> $TARGET ($MODE)"
write_status running prepare "Preparing update"

# ---- preflight --------------------------------------------------------------------
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  write_status failed prepare "Tracked files were modified locally; commit or stash them first"
  die "working tree has local modifications (git status)"
fi
FREE_KB="$(df -Pk "$ROOT_DIR" | awk 'NR==2 {print $4}')"
if [ "${FREE_KB:-0}" -lt 2097152 ]; then
  write_status failed prepare "Less than 2 GB free disk space"
  die "less than 2 GB free disk space"
fi

write_status running fetch "Fetching release $TARGET"
timeout 300 git fetch --quiet --tags --force origin || { write_status failed fetch "git fetch failed"; die "git fetch failed"; }
TAG=""
for candidate in "v$TARGET" "$TARGET"; do
  if git rev-parse -q --verify "refs/tags/$candidate^{commit}" >/dev/null; then TAG="$candidate"; break; fi
done
[ -n "$TAG" ] || { write_status failed fetch "Release tag v$TARGET not found in origin"; die "tag v$TARGET not found"; }
if [ "${IMS_REQUIRE_SIGNED_TAGS:-0}" = "1" ]; then
  git verify-tag "$TAG" || { write_status failed fetch "Tag signature verification failed"; die "tag signature invalid"; }
fi

if [ "$ALLOW_DOWNGRADE" != "1" ]; then
  HIGHEST="$(printf '%s\n%s\n' "$CURRENT_VERSION" "$TARGET" | sort -V | tail -n1)"
  if [ "$TARGET" = "$CURRENT_VERSION" ] || [ "$HIGHEST" != "$TARGET" ]; then
    write_status failed validate "Refusing to install $TARGET over $CURRENT_VERSION (no downgrades)"
    die "target is not newer than the current version (use --allow-downgrade)"
  fi
fi

PREV_REF="$(git rev-parse HEAD)"
BACKUP_DIR=""
MIGRATED=0
PHASE="prepare"

rollback() {
  local reason="$1"
  log "update failed during '$PHASE': $reason"
  if [ "$PHASE" = "prepare" ] || [ "$PHASE" = "backup" ]; then
    write_status failed "$PHASE" "$reason"
    return
  fi
  write_status running rollback "Rolling back: $reason"
  set +e
  git -c advice.detachedHead=false checkout --quiet "$PREV_REF"
  docker compose build backend web
  if [ "$MIGRATED" = "1" ] && [ -n "$BACKUP_DIR" ]; then
    log "restoring database from $BACKUP_DIR"
    ./database/scripts/restore-core-db.sh "$BACKUP_DIR" --yes
  fi
  docker compose up -d --remove-orphans
  if wait_healthy "$CURRENT_VERSION"; then
    write_status rolled_back rollback "$reason (previous version $CURRENT_VERSION restored)"
    log "rollback completed"
  else
    write_status failed rollback "$reason; rollback health check failed - manual intervention required (backup: ${BACKUP_DIR:-none})"
    log "ROLLBACK FAILED - see INSTALLATION.md > Troubleshooting (backup: ${BACKUP_DIR:-none})"
  fi
  set -e
}

wait_healthy() {
  local expected="$1" deadline=$(( $(date +%s) + HEALTH_TIMEOUT )) cid state version
  while [ "$(date +%s)" -lt "$deadline" ]; do
    cid="$(docker compose ps -q backend 2>/dev/null || true)"
    if [ -n "$cid" ]; then
      state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)"
      if [ "$state" = "healthy" ]; then
        version="$(docker compose exec -T backend node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>r.json()).then(b=>console.log(b.version)).catch(()=>process.exit(1))" 2>/dev/null | tr -d '[:space:]' || true)"
        if [ "$version" = "$expected" ]; then return 0; fi
        log "backend healthy but reports version '$version' (expected $expected)"
      fi
    fi
    sleep 5
  done
  return 1
}

on_error() {
  local code=$?
  trap - ERR
  rollback "step '$PHASE' exited with code $code"
  exit 1
}
trap on_error ERR

# ---- backup -------------------------------------------------------------------------
PHASE="backup"
if [ "$SKIP_BACKUP" = "1" ]; then
  log "skipping backup (--skip-backup)"
else
  write_status running backup "Backing up database, secrets and configuration"
  BACKUP_DIR="$(./database/scripts/backup-core-db.sh | sed -n 's/^\[backup\] done: //p' | tail -n1)"
  [ -n "$BACKUP_DIR" ] && [ -f "$BACKUP_DIR/database.dump" ] || { write_status failed backup "Backup failed"; die "backup failed"; }
  log "backup stored in $BACKUP_DIR"
fi

# ---- install --------------------------------------------------------------------------
PHASE="checkout"
write_status running checkout "Checking out $TAG"
git -c advice.detachedHead=false checkout --quiet "$TAG"
[ "$(tr -d '[:space:]' < VERSION)" = "$TARGET" ] || { false; }

PHASE="build"
write_status running build "Building images"
docker compose build --pull backend web

PHASE="migrate"
write_status running migrate "Applying database migrations"
MIGRATED=1
docker compose run --rm --no-deps backend migrate

PHASE="restart"
write_status running restart "Restarting services"
docker compose up -d --remove-orphans

PHASE="health"
write_status running health "Waiting for the new version to become healthy"
wait_healthy "$TARGET" || { log "health check timed out after ${HEALTH_TIMEOUT}s"; false; }

trap - ERR
write_status succeeded done "Updated to $TARGET"
log "update to $TARGET completed (backup: ${BACKUP_DIR:-skipped})"
