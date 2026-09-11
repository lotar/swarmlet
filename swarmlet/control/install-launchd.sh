#!/bin/bash
# Run the control plane at login on macOS (LaunchAgent ai.swarmlet.control). Idempotent.
#   swarmlet/control/install-launchd.sh [--uninstall]
# Env (optional): SWARMLET_CONTROL_HOST (default 0.0.0.0), SWARMLET_CONTROL_URL (default http://<en0 ip>:47900),
#                 SWARMLET_CONTROL_DIR (default ~/.swarmlet/control). The admin token is in $SWARMLET_CONTROL_DIR/control.json.
set -euo pipefail
LABEL=ai.swarmlet.control
PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
DOMAIN=gui/$(id -u)
HERE=$(cd "$(dirname "$0")/.." && pwd)
if [ "${1:-}" = "--uninstall" ]; then launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true; rm -f "$PLIST"; echo "uninstalled $LABEL"; exit 0; fi
BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
DIR=${SWARMLET_CONTROL_DIR:-$HOME/.swarmlet/control}; mkdir -p "$DIR" "$HOME/Library/LaunchAgents"
HOST=${SWARMLET_CONTROL_HOST:-0.0.0.0}
URL=${SWARMLET_CONTROL_URL:-http://$(ipconfig getifaddr en0 2>/dev/null || echo 127.0.0.1):47900}
# Serialize to a sibling temporary file; a malformed replacement must not destroy
# the previous service definition. Paths may contain XML metacharacters.
TEMP_PLIST=$(mktemp "$PLIST.XXXXXX")
trap 'rm -f "$TEMP_PLIST"' EXIT
python3 - "$TEMP_PLIST" "$LABEL" "$BUN" "$HERE" "$DIR" "$HOST" "$URL" <<'PY_PLIST'
import pathlib, plistlib, sys
output, label, bun, here, directory, host, url = sys.argv[1:]
plist = {
    "Label": label,
    "ProgramArguments": [bun, "run", str(pathlib.Path(here) / "control/main.ts")],
    "WorkingDirectory": here,
    "EnvironmentVariables": {
        "SWARMLET_CONTROL_DIR": directory,
        "SWARMLET_CONTROL_HOST": host,
        "SWARMLET_CONTROL_URL": url,
        "PATH": str(pathlib.Path(bun).parent) + ":/opt/homebrew/bin:/usr/bin:/bin",
    },
    "RunAtLoad": True,
    "KeepAlive": True,
    "ThrottleInterval": 10,
    "StandardOutPath": str(pathlib.Path(directory) / "control.out.log"),
    "StandardErrorPath": str(pathlib.Path(directory) / "control.err.log"),
}
pathlib.Path(output).write_bytes(plistlib.dumps(plist))
PY_PLIST
plutil -lint "$TEMP_PLIST" >/dev/null
mv -f "$TEMP_PLIST" "$PLIST"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
for _ in $(seq 1 30); do
  if curl -sf --connect-timeout 2 --max-time 3 "http://127.0.0.1:47900/health" >/dev/null 2>&1; then
    echo "installed $LABEL -> $URL (admin token: $DIR/control.json)"
    exit 0
  fi
  sleep 1
done
echo "control health check failed; see $DIR/control.err.log and $DIR/control.out.log" >&2
exit 1
