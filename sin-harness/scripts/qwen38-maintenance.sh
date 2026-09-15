#!/bin/bash
# Safe LaunchAgent ownership/runbook for the Qwen3.8-27B lane (:8090).
# Mirrors sin-harness/scripts/flashnext-maintenance.sh, which the swarmlet agent invokes as
# the node-config "externals[].maintenance" script (check-only|stop|start). The agent calls
# `stop` before a GPU-contending deployment and `start` when that deployment releases the box,
# so this script is the sole-residency contract for whichever mesh deployment needs the GPU.
set -euo pipefail
LABEL=com.lotar.llm-qwen38
DOMAIN=gui/$(id -u)
PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
PORT=8090
SCRIPT=$HOME/projects/local-llm/bin/serve-qwen38.sh
launch_pid(){ launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk '/^[[:space:]]*pid =/{print $3;exit}'; }
verify_plist(){
  test -r "$PLIST"; test -x "$SCRIPT"; plutil -lint "$PLIST" >/dev/null
  plutil -extract Label raw -o - "$PLIST" | grep -qx "$LABEL"
  plutil -extract ProgramArguments json -o - "$PLIST" | python3 -c 'import json,sys;assert json.load(sys.stdin)==["/bin/bash",sys.argv[1]]' "$SCRIPT"
}
status(){
  loaded=no; launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && loaded=yes
  lp=$(launch_pid || true); pids=$(lsof -nP -t -iTCP:$PORT -sTCP:LISTEN 2>/dev/null | sort -u | tr '\n' ' ')
  health=down; curl -sf http://127.0.0.1:$PORT/health >/dev/null 2>&1 && health=ok
  echo "label=$LABEL loaded=$loaded launchPid=${lp:-none} listenerPids=${pids:-none} health=$health"
}
check(){
  verify_plist
  n=$(lsof -nP -t -iTCP:$PORT -sTCP:LISTEN 2>/dev/null | sort -u | wc -l | tr -d ' '); test "$n" -le 1
  lp=$(launch_pid || true); listener=$(lsof -nP -t -iTCP:$PORT -sTCP:LISTEN 2>/dev/null | sort -u | head -1)
  if [ -n "$listener" ]; then test -n "$lp"; test "$listener" = "$lp"; fi
  test -z "$(pgrep -f 'convert_hf_to_gguf|llama-quantize' || true)"
  echo CHECK_OK; status
}
stop_service(){
  check >/dev/null
  clients=$(lsof -nP -iTCP:$PORT 2>/dev/null | awk '$NF=="(ESTABLISHED)" && $1!="llama-ser"{print $2}' | sort -u | tr '\n' ' ')
  if [ -n "$clients" ]; then echo "refusing: active client PIDs $clients" >&2; exit 65; fi
  test "$(launch_pid)" = "$(lsof -nP -t -iTCP:$PORT -sTCP:LISTEN)"
  launchctl bootout "$DOMAIN/$LABEL"
  for _ in $(seq 1 180); do ! lsof -nP -t -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && { echo STOPPED; return; }; sleep 1; done
  echo 'listener did not stop' >&2; exit 66
}
start_service(){
  verify_plist
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || launchctl bootstrap "$DOMAIN" "$PLIST"
  for _ in $(seq 1 900); do
    if curl -sf http://127.0.0.1:$PORT/health >/dev/null 2>&1; then
      listener=$(lsof -nP -t -iTCP:$PORT -sTCP:LISTEN);test "$(echo "$listener"|wc -l|tr -d ' ')" -eq 1;test "$listener" = "$(launch_pid)";echo STARTED;status;return
    fi
    sleep 2
  done
  echo 'health timeout' >&2; exit 67
}
case "${1:-status}" in
 status) status;;
 check-only) check;;
 stop) stop_service;;
 start) start_service;;
 *) echo "usage: $0 {status|check-only|stop|start}" >&2;exit 64;;
esac
