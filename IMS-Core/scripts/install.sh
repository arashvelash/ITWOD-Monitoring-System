#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# IMS-Core guided installation (optional helper; equivalent to the manual
# steps in INSTALLATION.md).
#
#   git clone <IMS-Core repository> ims-core && cd ims-core
#   sudo ./scripts/install.sh [--domain itwodms.ir --email admin@itwodms.ir] [--no-updater]
#
# Creates .env (if missing), starts the stack, waits until it is healthy and
# prints the one-time setup token for the web setup wizard.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOMAIN=""
EMAIL=""
UPDATER=1

log()  { printf '\033[1;34m[ims]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[ims] error:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --no-updater) UPDATER=0; shift ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || fail "run as root (sudo)"
command -v docker >/dev/null || fail "Docker is not installed. See https://docs.docker.com/engine/install/ubuntu/"
docker compose version >/dev/null 2>&1 || fail "the Docker Compose plugin is missing (apt install docker-compose-plugin)"
cd "$ROOT_DIR"

if [ ! -f .env ]; then
  [ -n "$DOMAIN" ] || read -r -p "Domain of this Core (e.g. itwodms.ir): " DOMAIN
  [ -n "$EMAIL" ] || read -r -p "E-mail for Let's Encrypt: " EMAIL
  [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || fail "invalid domain"
  [[ "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] || fail "invalid e-mail"
  sed -e "s#^IMS_DOMAIN=.*#IMS_DOMAIN=$DOMAIN#" \
      -e "s#^ACME_EMAIL=.*#ACME_EMAIL=$EMAIL#" \
      -e "s#^IMS_PUBLIC_URL=.*#IMS_PUBLIC_URL=https://$DOMAIN#" .env.example > .env
  chmod 0600 .env
  log "created .env for $DOMAIN"
else
  log ".env exists, keeping it"
fi

log "building and starting IMS-Core (first build takes a few minutes)..."
docker compose up -d --build

log "waiting for the backend to become healthy..."
for _ in $(seq 1 60); do
  cid="$(docker compose ps -q backend)"
  state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$cid" 2>/dev/null || true)"
  [ "$state" = "healthy" ] && break
  sleep 5
done
[ "${state:-}" = "healthy" ] || fail "backend did not become healthy; check: docker compose logs backend"

if [ "$UPDATER" = "1" ] && command -v systemctl >/dev/null; then
  "$ROOT_DIR/scripts/install-updater.sh"
fi

TOKEN="$(docker compose exec -T backend cat /run/ims-secrets/setup_token 2>/dev/null || true)"
URL="$(sed -n 's/^IMS_PUBLIC_URL=//p' .env)"
echo
log "IMS-Core is running."
log "Open ${URL:-https://<your-domain>}/setup and enter this one-time setup token:"
echo
echo "    ${TOKEN:-<run: docker compose exec backend cat /run/ims-secrets/setup_token>}"
echo
log "The token is only accepted until the setup wizard has been completed."
