#!/bin/bash
# M3 acceptance on the real rig, no production window: control plane + M5 agent on this Mac, both
# Legions already enrolled (e2e/rig-setup.sh), a Qwen3.5-2B split deployed through the app, measured
# with the same spec-client the ring reports used, once with the direct LAN path and once relay-only.
#   usage: e2e/rig-2b.sh [--keep]      env: M5_IP (default: first en0 inet), CTX=2048, TOKENS=96, PROMPTS=4
# Evidence: sin-harness/data/legion-goal/app-rig-2b-<ts>/
set -Eeuo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd); AI=$(cd "$HERE/.." && pwd)
M5_IP=${M5_IP:-$(ipconfig getifaddr en0 2>/dev/null || echo 192.168.1.53)}
CTRL_DIR=$HOME/.swarmlet/control; HOME_AGENT=$HOME/.swarmlet
CONTROL_URL=http://$M5_IP:47900
OUT=$AI/sin-harness/data/legion-goal/app-rig-2b-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$OUT"; exec > >(tee -a "$OUT/console.log") 2>&1
log(){ echo "[rig2b $(date -u +%H:%M:%S)] $*"; }
PIDS=""; DEP=""
cleanup(){ set +e; log "cleanup"; [ -n "$DEP" ] && [ "${KEEP:-0}" != 1 ] && curl -sf -X POST -H "Authorization: Bearer $TOKEN" "$CONTROL_URL/api/deployments/$DEP/stop" >/dev/null; sleep 2
  for p in $PIDS; do kill $p 2>/dev/null; done; log "done -> $OUT"; }
trap cleanup EXIT INT TERM
[ "${1:-}" = "--keep" ] && KEEP=1

# --- control plane on this Mac, reachable from the Legions ---
if curl -sf "$CONTROL_URL/health" >/dev/null 2>&1; then log "control already running @ $CONTROL_URL (reusing)"; else
  log "control @ $CONTROL_URL"
  ( cd "$HERE" && SWARMLET_CONTROL_DIR=$CTRL_DIR SWARMLET_CONTROL_HOST=0.0.0.0 SWARMLET_CONTROL_URL=$CONTROL_URL bun run control/main.ts > "$OUT/control.log" 2>&1 ) & PIDS="$PIDS $!"
  for _ in $(seq 1 30); do curl -sf "$CONTROL_URL/health" >/dev/null 2>&1 && break; sleep 1; done
fi
TOKEN=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["adminToken"])' "$CTRL_DIR/control.json")
api(){ curl -sf -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" "$@"; }

# --- M5 agent: models dir with symlinks (llama.cpp finds split shards next to the first one), offer, externals ---
MODELS=$HOME_AGENT/models; mkdir -p "$MODELS"
FN=/Users/lotar/projects/local-llm/models/qwen3.8-flash-next
for f in "$FN"/UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-0000?-of-00005.gguf "$FN"/mtp/Qwen3.8-Flash-Next-MTP-Q8_0.gguf /Users/lotar/projects/local-llm/models/qwen3.5-draft/Qwen3.5-2B-Q8_0.gguf; do
  [ -f "$f" ] && ln -sfn "$f" "$MODELS/$(basename "$f")"; done
python3 - "$HOME_AGENT" "$MODELS" "$AI" <<'PY'
import json, sys, os
home, models, ai = sys.argv[1:4]; p = os.path.join(home, "node.json")
cfg = json.load(open(p)) if os.path.exists(p) else {}
cfg.setdefault("offer", {}).update({"enabled": True, "roles": {"worker": False, "coordinator": True, "replica": True}, "gpu": [{"id": "metal:0", "memMiB": 110000}], "ramMiB": 118000, "cpuCores": 12, "diskMiB": 100000, "modelsDir": models})
cfg["externals"] = [{"id": "flashnext-prod", "modelName": "qwen3.8-flash-next", "url": "http://127.0.0.1:8099", "healthPath": "/health", "maintenance": f"{ai}/sin-harness/scripts/flashnext-maintenance.sh"}]
cfg.setdefault("uiPort", 47800); cfg.setdefault("dataPort", 47801)
json.dump(cfg, open(p, "w"), indent=2); os.chmod(p, 0o600); print("node.json prepared")
PY
log "M5 agent"
( cd "$HERE" && SWARMLET_HOME=$HOME_AGENT SWARMLET_ENGINE=$HERE/engine/dist/darwin bun run node-agent/main.ts run > "$OUT/agent-m5.log" 2>&1 ) & PIDS="$PIDS $!"
for _ in $(seq 1 30); do curl -sf http://127.0.0.1:47800/api/status >/dev/null 2>&1 && break; sleep 1; done
# offer from the measured limits (GPU total as the engine reports it), so validation never disables it
python3 - "$MODELS" <<'PY2'
import json, sys, urllib.request
models = sys.argv[1]
lim = json.load(urllib.request.urlopen("http://127.0.0.1:47800/api/offer"))["limits"]
gpu = [{"id": g["id"], "memMiB": min(110000, g["totalMiB"])} for g in lim["gpus"][:1]]
offer = {"enabled": True, "roles": {"worker": False, "coordinator": True, "replica": True}, "gpu": gpu, "ramMiB": min(118000, lim["ramMaxMiB"]), "cpuCores": min(12, lim["cpuMax"]), "diskMiB": 100000, "modelsDir": models}
req = urllib.request.Request("http://127.0.0.1:47800/api/offer", data=json.dumps(offer).encode(), headers={"content-type": "application/json"}, method="PUT")
print("offer:", urllib.request.urlopen(req).read().decode(), gpu)
PY2
if ! python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));sys.exit(0 if d.get("agentUrl","").startswith("ws://'"$M5_IP"'") else 1)' "$HOME_AGENT/node.json"; then
  CODE=$(api -X POST "$CONTROL_URL/api/join-codes" | python3 -c 'import json,sys;print(json.load(sys.stdin)["code"])')
  curl -sf -X POST -H "content-type: application/json" -d "{\"controlUrl\":\"$CONTROL_URL\",\"code\":\"$CODE\"}" http://127.0.0.1:47800/api/join; echo
fi
sleep 3
api "$CONTROL_URL/api/nodes" > "$OUT/nodes.json"
python3 - "$OUT/nodes.json" <<'PY'
import json,sys; d=json.load(open(sys.argv[1]))
for n in d["nodes"]: print(f"  {n['hostname']:20s} {n['id']} online={n['online']} roles={n.get('offer',{}).get('roles')} gpu={n.get('offer',{}).get('gpu')} rtt={(n.get('caps') or {}).get('net',{}).get('rttMs')}")
PY
M5=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print([n["id"] for n in d["nodes"] if n["online"] and n["hostname"].startswith("Lotars")][0])' "$OUT/nodes.json")
L1=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print([n["id"] for n in d["nodes"] if n["online"] and n["hostname"]=="lotar-legion"][0])' "$OUT/nodes.json")
L2=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print([n["id"] for n in d["nodes"] if n["online"] and n["hostname"]=="lotar-legion-2"][0])' "$OUT/nodes.json")
log "nodes M5=$M5 L1=$L1 L2=$L2"

run_arm(){ local tag=$1 transport=$2
  local spec="{\"name\":\"rig-2b-$tag\",\"profile\":\"qwen35-2b-q8\",\"kind\":\"split\",\"coordinatorNodeId\":\"$M5\",\"workerNodeIds\":[\"$L1\",\"$L2\"],\"ctx\":${CTX:-2048},\"parallel\":1,\"chain\":0,\"transport\":\"$transport\"}"
  api -X POST -d "$spec" "$CONTROL_URL/api/deployments/plan-preview" > "$OUT/plan-$tag.json" || { log "plan refused: $(cat "$OUT/plan-$tag.json")"; return 1; }
  python3 -c 'import json,sys;p=json.load(open(sys.argv[1]));print("  plan split",p["tensorSplit"],"env",p["env"]);[print("   -",r) for r in p["reasons"]]' "$OUT/plan-$tag.json"
  DEP=$(api -X POST -d "$spec" "$CONTROL_URL/api/deployments" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
  api -X POST "$CONTROL_URL/api/deployments/$DEP/start" >/dev/null
  local t0=$(date +%s) state=""
  for _ in $(seq 1 600); do state=$(api "$CONTROL_URL/api/deployments/$DEP" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["state"], d.get("error") or "")'); case "$state" in ready*|failed*) break;; esac; sleep 1; done
  api "$CONTROL_URL/api/deployments/$DEP" > "$OUT/deployment-$tag.json"
  log "$tag: $state after $(( $(date +%s) - t0 ))s"
  case "$state" in ready*) ;; *) return 1;; esac
  python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));[print("  ",a["body"]["kind"],a["nodeId"],a["state"],a.get("detail")) for a in d["assignments"]]' "$OUT/deployment-$tag.json"
  local port=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["endpoint"]["port"])' "$OUT/deployment-$tag.json")
  # router smoke (OpenAI path through control) + measurement on the coordinator's native /completion (same client as the ring reports)
  local key=$(api -X POST -d '{"name":"rig"}' "$CONTROL_URL/api/api-keys" | python3 -c 'import json,sys;print(json.load(sys.stdin)["key"])')
  curl -s -H "Authorization: Bearer $key" -H "content-type: application/json" -d '{"model":"qwen3.5-2b","messages":[{"role":"user","content":"Say hello in five words."}],"max_tokens":16}' "$CONTROL_URL/v1/chat/completions" | cut -c1-300; echo
  python3 "$HERE/e2e/tools/spec-client.py" --url "http://127.0.0.1:$port" --out "$OUT/$tag-c1" --concurrency 1 --prompts "${PROMPTS:-4}" --tokens "${TOKENS:-96}" --label "$tag" | grep RESULT | sed 's/^/   /'
  api -X POST "$CONTROL_URL/api/deployments/$DEP/stop" >/dev/null; for _ in $(seq 1 60); do [ "$(api "$CONTROL_URL/api/deployments/$DEP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["state"])')" = stopped ] && break; sleep 1; done
  log "$tag: stopped"; DEP=""
}
log "=== arm direct (LAN path) ==="; run_arm direct auto || log "direct arm failed"
log "=== arm relay (through control) ==="; run_arm relay relay || log "relay arm failed"
api "$CONTROL_URL/api/events?limit=100" > "$OUT/events.json"
log "reference: docs/RING_ORCHESTRATION_E2E_20260903.md (2B ring, LAN direct 19-23 ms per Legion hop) and sin-harness/data/legion-goal/fn-ringstep-* (Cloudflare relay 108 ms/token)"
