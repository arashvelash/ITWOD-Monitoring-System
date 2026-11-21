#!/bin/sh
# /usr/local/bin/ims-agent - CLI wrapper. Commands started by root run as the
# configured agent user so that created files keep the right ownership.
set -eu
LAUNCHER=/opt/ims-agent/launcher.js
RUN_AS="$(cat /etc/ims-agent/run-as 2>/dev/null || echo ims-agent)"
if [ "$(id -u)" -eq 0 ] && [ "$RUN_AS" != "root" ]; then
  exec runuser -u "$RUN_AS" -- node "$LAUNCHER" "$@"
fi
exec node "$LAUNCHER" "$@"
