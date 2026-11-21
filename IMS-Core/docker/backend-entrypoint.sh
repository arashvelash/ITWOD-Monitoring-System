#!/bin/sh
# ---------------------------------------------------------------------------
# IMS-Core backend entrypoint
#   serve    (default) apply pending migrations, then start the API
#   migrate  apply pending migrations only (used by scripts/update.sh)
#   *        exec the given command
# Connection URLs are assembled from the generated secret files so that no
# password ever appears in docker-compose.yml or the environment of the host.
# ---------------------------------------------------------------------------
set -eu

SECRETS_DIR="${SECRETS_DIR:-/run/ims-secrets}"
PRISMA="node /app/node_modules/prisma/build/index.js"
SCHEMA="/app/backend/prisma/schema.prisma"

read_secret() {
  if [ ! -s "$SECRETS_DIR/$1" ]; then
    echo "[ims] missing secret $SECRETS_DIR/$1 - did the init container run?" >&2
    exit 1
  fi
  cat "$SECRETS_DIR/$1"
}

if [ -z "${DATABASE_URL:-}" ]; then
  DATABASE_URL="postgresql://${DB_USER:-ims}:$(read_secret postgres_password)@${DB_HOST:-postgres}:${DB_PORT:-5432}/${DB_NAME:-ims}?schema=public"
  export DATABASE_URL
fi
if [ -z "${REDIS_URL:-}" ]; then
  REDIS_URL="redis://:$(read_secret redis_password)@${REDIS_HOST:-redis}:${REDIS_PORT:-6379}/0"
  export REDIS_URL
fi

case "${1:-serve}" in
  migrate)
    exec $PRISMA migrate deploy --schema "$SCHEMA"
    ;;
  serve)
    $PRISMA migrate deploy --schema "$SCHEMA"
    exec node /app/backend/dist/main.js
    ;;
  *)
    exec "$@"
    ;;
esac
