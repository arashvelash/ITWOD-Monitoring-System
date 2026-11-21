#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# IMS Agent bootstrap installer (served by IMS-Core at /install-agent.sh)
#
#   curl -fsSL https://itwodms.ir/install-agent.sh | sudo bash
#
# Optional arguments (after `bash -s --`):
#   --core-url <https://...>   Core URL (default: the Core that served this script)
#   --token-file <path>        read the registration token from a file
#   --run-as-root              run the agent as root instead of the ims-agent user
#
# The script downloads the latest agent release from Core, verifies its
# SHA-256 checksum and hands over to the release's own installer. It never
# modifies anything outside /opt/ims-agent, /etc/ims-agent, /var/lib/ims-agent,
# /var/log/ims-agent and /var/backups/ims (plus Node.js/PM2 if missing).
# ---------------------------------------------------------------------------
set -euo pipefail
umask 077

DEFAULT_CORE_URL="__IMS_DEFAULT_CORE_URL__"
CORE_URL=""
TOKEN=""
PASSTHROUGH=()

log()  { printf '\033[1;34m[ims]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[ims] error:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --core-url) CORE_URL="${2:-}"; shift 2 ;;
    --token-file) TOKEN="$(tr -d '[:space:]' < "${2:?}")"; shift 2 ;;
    --run-as-root) PASSTHROUGH+=("--run-as-root"); shift ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || fail "run as root (pipe into 'sudo bash')"
command -v curl >/dev/null || fail "curl is required"
command -v tar >/dev/null || fail "tar is required"
command -v sha256sum >/dev/null || fail "sha256sum is required"

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  [ "${ID:-}" = "ubuntu" ] || log "warning: this installer is tested on Ubuntu; detected ${PRETTY_NAME:-unknown}"
fi

# Interactive prompts read from the terminal because stdin is the piped script.
prompt() {
  local text="$1" default="${2:-}" silent="${3:-}" value=""
  [ -r /dev/tty ] || fail "no terminal available; pass --core-url and --token-file"
  if [ -n "$silent" ]; then
    read -r -s -p "$text: " value < /dev/tty; echo > /dev/tty
  elif [ -n "$default" ]; then
    read -r -p "$text [$default]: " value < /dev/tty
  else
    read -r -p "$text: " value < /dev/tty
  fi
  printf '%s' "${value:-$default}"
}

# The placeholder is replaced by Core when serving; split so the replacement cannot touch this check.
PLACEHOLDER="__IMS_DEFAULT_""CORE_URL__"
[ "$DEFAULT_CORE_URL" != "$PLACEHOLDER" ] || DEFAULT_CORE_URL=""
[ -n "$CORE_URL" ] || CORE_URL="$(prompt "Core URL" "$DEFAULT_CORE_URL")"
CORE_URL="${CORE_URL%/}"
[[ "$CORE_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || fail "Core URL must look like https://itwodms.ir"

[ -n "$TOKEN" ] || TOKEN="$(prompt "Registration token" "" silent)"
[[ "$TOKEN" =~ ^imsr_[A-Za-z0-9_-]{32}$ ]] || fail "invalid registration token format"

WORK="$(mktemp -d /tmp/ims-agent-install.XXXXXX)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

CURL=(curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-time 300 -H "X-IMS-Registration-Token: $TOKEN")

log "fetching release information from $CORE_URL"
INFO="$("${CURL[@]}" "$CORE_URL/api/v1/agent/install/package-info")" || fail "Core rejected the request (token invalid or expired?)"
VERSION="$(printf '%s' "$INFO" | sed -n 's/.*"version":"\([0-9A-Za-z.+-]*\)".*/\1/p')"
SHA256="$(printf '%s' "$INFO" | sed -n 's/.*"sha256":"\([0-9a-f]\{64\}\)".*/\1/p')"
[ -n "$VERSION" ] && [ -n "$SHA256" ] || fail "unexpected response from Core"

log "downloading IMS Agent $VERSION"
"${CURL[@]}" -o "$WORK/agent.tgz" "$CORE_URL/api/v1/agent/install/package"
echo "$SHA256  $WORK/agent.tgz" | sha256sum -c --quiet - || fail "checksum mismatch - aborting"

mkdir -p "$WORK/pkg"
tar -xzf "$WORK/agent.tgz" -C "$WORK/pkg" --no-same-owner
[ -f "$WORK/pkg/installer/install.sh" ] || fail "package does not contain installer/install.sh"

log "running agent installer"
IMS_REGISTRATION_TOKEN="$TOKEN" bash "$WORK/pkg/installer/install.sh" --core-url "$CORE_URL" --package "$WORK/agent.tgz" --package-dir "$WORK/pkg" "${PASSTHROUGH[@]}"
