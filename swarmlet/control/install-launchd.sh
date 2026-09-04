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
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BUN</string><string>run</string><string>$HERE/control/main.ts</string></array>
  <key>WorkingDirectory</key><string>$HERE</string>
  <key>EnvironmentVariables</key><dict>
    <key>SWARMLET_CONTROL_DIR</key><string>$DIR</string>
    <key>SWARMLET_CONTROL_HOST</key><string>$HOST</string>
    <key>SWARMLET_CONTROL_URL</key><string>$URL</string>
    <key>PATH</key><string>$(dirname "$BUN"):/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$DIR/control.out.log</string>
  <key>StandardErrorPath</key><string>$DIR/control.err.log</string>
</dict></plist>
EOF
plutil -lint "$PLIST" >/dev/null
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:47900/health" >/dev/null 2>&1 && break; sleep 1; done
echo "installed $LABEL -> $URL (admin token: $DIR/control.json)"
