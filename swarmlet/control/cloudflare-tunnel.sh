#!/bin/bash
# Public internet path for the control plane: a Cloudflare quick tunnel in front of :47900, run as a
# LaunchAgent (ai.swarmlet.control-tunnel). Agents that enroll through the tunnel hostname connect back
# through it, so every relayed RPC byte crosses the Cloudflare edge instead of the LAN.
#   swarmlet/control/cloudflare-tunnel.sh start | stop | url | status
# Quick tunnels get a new random hostname on every start (no account needed); nodes enrolled through an
# old hostname must re-join. Requires `cloudflared` (brew install cloudflared). --config /dev/null keeps a
# machine-wide ~/.cloudflared/config.yml (named-tunnel ingress rules) from capturing the quick tunnel.
set -euo pipefail
LABEL=ai.swarmlet.control-tunnel
DOMAIN=gui/$(id -u)
PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
DIR=${SWARMLET_CONTROL_DIR:-$HOME/.swarmlet/control}
LOG=$DIR/tunnel.log
BIN=$(command -v cloudflared || echo /opt/homebrew/bin/cloudflared)
PORT=${SWARMLET_CONTROL_PORT:-47900}
url_from_log(){ grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | tail -1 || true; }
case "${1:-status}" in
  start)
    mkdir -p "$DIR" "$HOME/Library/LaunchAgents"; : > "$LOG"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BIN</string><string>--config</string><string>/dev/null</string><string>tunnel</string><string>--no-autoupdate</string><string>--edge-ip-version</string><string>4</string><string>--url</string><string>http://127.0.0.1:$PORT</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
EOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    sleep 1
    for _ in 1 2 3; do launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null && break; sleep 2; done
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || { echo "launchd did not start $LABEL" >&2; exit 1; }
    u=""
    for _ in $(seq 1 60); do u=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | tail -1 || true); [ -n "$u" ] && grep -q 'Registered tunnel connection' "$LOG" 2>/dev/null && break; sleep 1; done
    [ -n "$u" ] || { echo "tunnel did not come up; see $LOG" >&2; exit 1; }
    # Public HTTP endpoints (including /health) are closed; tunnel registration above
    # is the startup check. Enrolled agents authenticate on the /agent WebSocket.
    echo "$u"; grep -oE 'location=[a-z0-9]+' "$LOG" | tail -1 ;;
  stop) launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true; rm -f "$PLIST"; echo "tunnel stopped" ;;
  url) url_from_log ;;
  status) launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && echo "running $(url_from_log)" || echo "not running" ;;
  *) echo "usage: $0 start|stop|url|status" >&2; exit 64 ;;
esac
