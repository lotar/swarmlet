#!/bin/bash
# M4 acceptance: the measured best exact Flash-Next configuration (chain 4 + batched GETs, wire off,
# --parallel 3, split 1,1,46, ctx 1536) deployed THROUGH THE APP in one production window.
# Needs an explicit go-ahead: it stops the production LaunchAgent (via the agent, through
# flashnext-maintenance.sh) and the agent restarts it when the deployment ends or fails.
# Prerequisites: control on this Mac (e2e/rig-2b.sh brings it up), Legions enrolled with worker offers.
#   usage: e2e/rig-flashnext.sh     env: CHAIN=4 PAR=3 CTX=1536 TOKENS=64 PROMPTS=6 CONCS="1 3"
# Evidence: sin-harness/data/legion-goal/app-rig-flashnext-<ts>/
set -Eeuo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd); AI=$(cd "$HERE/.." && pwd)
M5_IP=${M5_IP:-$(ipconfig getifaddr en0 2>/dev/null || echo 192.168.1.53)}
CTRL_DIR=$HOME/.swarmlet/control; HOME_AGENT=$HOME/.swarmlet; CONTROL_URL=http://$M5_IP:47900
MAINT=$AI/sin-harness/scripts/flashnext-maintenance.sh
OUT=$AI/sin-harness/data/legion-goal/app-rig-flashnext-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$OUT"; exec > >(tee -a "$OUT/console.log") 2>&1
log(){ echo "[fn $(date -u +%H:%M:%S)] $*"; }
TOKEN=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["adminToken"])' "$CTRL_DIR/control.json")
api(){ curl -sf -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" "$@"; }
PIDS=""; DEP=""; EXT=""
cleanup(){ set +e; log "cleanup"
  [ -n "$DEP" ] && api -X POST "$CONTROL_URL/api/deployments/$DEP/stop" >/dev/null && for _ in $(seq 1 120); do [ "$(api "$CONTROL_URL/api/deployments/$DEP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["state"])')" = stopped ] && break; sleep 2; done
  for _ in $(seq 1 120); do curl -sf --max-time 3 http://127.0.0.1:8099/health >/dev/null 2>&1 && break; sleep 3; done
  curl -sf --max-time 5 http://127.0.0.1:8099/health; echo; ( "$MAINT" check-only 2>&1 || true ) | head -1
  for p in $PIDS; do kill $p 2>/dev/null; done; log "done -> $OUT"; }
trap cleanup EXIT INT TERM

curl -sf "$CONTROL_URL/health" >/dev/null || { log "control not running at $CONTROL_URL (run e2e/rig-2b.sh --keep first or start control)"; exit 2; }
if ! curl -sf http://127.0.0.1:47800/api/status >/dev/null 2>&1; then
  log "M5 agent"; ( cd "$HERE" && SWARMLET_HOME=$HOME_AGENT SWARMLET_ENGINE=$HERE/engine/dist/darwin exec bun run node-agent/main.ts run > "$OUT/agent-m5.log" 2>&1 ) & PIDS="$PIDS $!"
  for _ in $(seq 1 60); do curl -sf http://127.0.0.1:47800/api/status >/dev/null 2>&1 && break; sleep 1; done
fi
curl -sf --max-time 5 http://127.0.0.1:8099/health > "$OUT/production-before.txt"; ( "$MAINT" check-only 2>&1 || true ) | head -1
api "$CONTROL_URL/api/nodes" > "$OUT/nodes.json"
M5=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print([n["id"] for n in d["nodes"] if n["online"] and n["hostname"].startswith("Lotars")][0])' "$OUT/nodes.json")
L1=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print([n["id"] for n in d["nodes"] if n["online"] and n["hostname"]=="lotar-legion"][0])' "$OUT/nodes.json")
L2=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print([n["id"] for n in d["nodes"] if n["online"] and n["hostname"]=="lotar-legion-2"][0])' "$OUT/nodes.json")
log "nodes M5=$M5 L1=$L1 L2=$L2"
state_of(){ api "$CONTROL_URL/api/deployments/$1" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["state"], d.get("error") or "")'; }

# 1. production as an external deployment: routed like a replica, and the thing the split may stop
EXT=$(api "$CONTROL_URL/api/deployments" | python3 -c 'import json,sys;print(next((d["id"] for d in json.load(sys.stdin)["deployments"] if d["spec"]["name"]=="flashnext-prod"),""))')
if [ -z "$EXT" ]; then
  EXT=$(api -X POST -d "{\"name\":\"flashnext-prod\",\"profile\":\"external\",\"kind\":\"external\",\"external\":{\"nodeId\":\"$M5\",\"url\":\"http://127.0.0.1:8099\",\"healthPath\":\"/health\",\"modelName\":\"qwen3.8-flash-next\"}}" "$CONTROL_URL/api/deployments" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
fi
[ "$(state_of $EXT | cut -d' ' -f1)" = ready ] || api -X POST "$CONTROL_URL/api/deployments/$EXT/start" >/dev/null
for _ in $(seq 1 30); do [ "$(state_of $EXT | cut -d' ' -f1)" = ready ] && break; sleep 1; done
log "external flashnext-prod: $(state_of $EXT)"
KEY=$(api -X POST -d '{"name":"fn"}' "$CONTROL_URL/api/api-keys" | python3 -c 'import json,sys;print(json.load(sys.stdin)["key"])')
log "router -> production:"; curl -s -H "Authorization: Bearer $KEY" -H "content-type: application/json" -d '{"model":"qwen3.8-flash-next","messages":[{"role":"user","content":"Reply with the single word ready."}],"max_tokens":8,"chat_template_kwargs":{"enable_thinking":false}}' "$CONTROL_URL/v1/chat/completions" | cut -c1-260; echo

# 2. the split, with permission to stop production through its maintenance script
SPEC="{\"name\":\"fn-chain${CHAIN:-4}\",\"profile\":\"flash-next-ud-q4kxl\",\"kind\":\"split\",\"coordinatorNodeId\":\"$M5\",\"workerNodeIds\":[\"$L1\",\"$L2\"],\"ctx\":${CTX:-1536},\"parallel\":${PAR:-3},\"chain\":${CHAIN:-4},\"batchedGets\":true,\"forwarding\":true,\"wire\":\"off\",\"stopExternal\":true,\"transport\":\"${TRANSPORT:-auto}\"}"
api -X POST -d "$SPEC" "$CONTROL_URL/api/deployments/plan-preview" > "$OUT/plan.json" || { log "plan refused: $(curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$SPEC" "$CONTROL_URL/api/deployments/plan-preview")"; exit 3; }
python3 -c 'import json,sys;p=json.load(open(sys.argv[1]));print("  plan split",p["tensorSplit"],"chain",p["chain"],"env",p["env"]);[print("   -",r) for r in p["reasons"]]' "$OUT/plan.json"
DEP=$(api -X POST -d "$SPEC" "$CONTROL_URL/api/deployments" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
log "starting split $DEP (production will be stopped by the M5 agent via flashnext-maintenance.sh)"; T0=$(date +%s)
api -X POST "$CONTROL_URL/api/deployments/$DEP/start" >/dev/null
last=""; for _ in $(seq 1 1800); do s=$(state_of $DEP); [ "$s" != "$last" ] && { log "  $s"; last=$s; }; case "$s" in ready*|failed*) break;; esac; sleep 2; done
api "$CONTROL_URL/api/deployments/$DEP" > "$OUT/deployment.json"; log "split: $(state_of $DEP) after $(( $(date +%s) - T0 ))s"
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));[print("  ",a["body"]["kind"],a["nodeId"][:8],a["state"],(a.get("detail") or "")[:200]) for a in d["assignments"]]' "$OUT/deployment.json"
case "$(state_of $DEP | cut -d' ' -f1)" in ready) ;; *) exit 4;; esac
PORT=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["endpoint"]["port"])' "$OUT/deployment.json")
log "router -> split:"; curl -s -H "Authorization: Bearer $KEY" -H "content-type: application/json" -d '{"model":"qwen3.8-flash-next","messages":[{"role":"user","content":"Reply with the single word ready."}],"max_tokens":8,"chat_template_kwargs":{"enable_thinking":false}}' "$CONTROL_URL/v1/chat/completions" | cut -c1-260; echo
for c in ${CONCS:-1 3}; do
  python3 "$HERE/e2e/tools/spec-client.py" --url "http://127.0.0.1:$PORT" --out "$OUT/chain${CHAIN:-4}-c$c" --concurrency $c --prompts "${PROMPTS:-6}" --tokens "${TOKENS:-64}" --label "chain${CHAIN:-4}" | grep RESULT | sed 's/^/   /'
done
api "$CONTROL_URL/api/assignments?deployment=$DEP" > "$OUT/assignments.json"
log "reference (docs/FLASHNEXT_RING_LEVERS_20260904.md row 4): chain 4 + batched GETs, relay path 12.59 tok/s c1 / 15.66 agg c3; LAN path nospec 9.30"
