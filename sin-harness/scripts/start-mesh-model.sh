#!/bin/bash
# Boots the LARGE MoE (Qwen3.8-27B Q8) with layers distributed across the
# dockerized RPC shards ("small inference hardware"). The host acts purely as
# inference coordinator; tensor data crosses the bridge network at load time
# and every generated token traverses it during decode.
#
#   NGL=<n> ./scripts/start-mesh-model.sh       # default 99 = offload everything
#                                                # possible to accelerator devices
#   TSPLIT="1,1,1,0"                            # shard1:shard2:shard3:Metal weights
#                                                 # (default: even thirds across shards,
#                                                 #  nothing on host Metal — device order
#                                                 #  is [rpc1,rpc2,rpc3,Metal])
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
LLAMA_SERVER="${LLAMA_RPC_BUILD:-/Users/lotar/projects/local-llm/llama.cpp-rpc/build-host/bin/llama-server}"
MODEL="${MODEL:-/Users/lotar/projects/local-llm/models/qwen3.8-27b/Qwen3.8-27B-Q8_0.gguf}"
PORT=8081
NGL="${NGL:-99}"
TSPLIT="${TSPLIT:-1,1,1,0}"
CTX="${CTX:-4096}"

test -x "$LLAMA_SERVER" || { echo "missing $LLAMA_SERVER — build first (GGML_RPC=ON)"; exit 1; }
test -f "$MODEL" || { echo "missing model $MODEL"; exit 1; }

for port in 51052 51053 51054; do
  nc -z 127.0.0.1 "$port" || { echo "rpc shard on :$port not up — run: docker compose -f $HERE/compose.yaml up -d rpc1 rpc2 rpc3"; exit 1; }
done

mkdir -p "$HERE/data"
LOG="$HERE/data/mesh-model.log"
PIDFILE="$HERE/data/mesh-model.pid"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "mesh model already running (pid $(cat "$PIDFILE"))"; exit 0
fi

nohup "$LLAMA_SERVER" \
  -m "$MODEL" \
  --host 127.0.0.1 --port "$PORT" \
  --ctx-size "$CTX" \
  --cache-reuse 256 \
  --rpc 127.0.0.1:51052,127.0.0.1:51053,127.0.0.1:51054 \
  --n-gpu-layers "$NGL" \
  --split-mode layer \
  --tensor-split "$TSPLIT" \
  -fa on \
  --jinja \
  --chat-template-kwargs '{"enable_thinking": false}' \
  > "$LOG" 2>&1 &

echo $! > "$PIDFILE"
echo "llama-server (RPC mesh) starting: pid $(cat "$PIDFILE"), NGL=$NGL, log=$LOG"

for i in $(seq 1 240); do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "healthy after ~${i}x2s"
    grep -E "rpc|layers|offload" "$LOG" | tail -8 || true
    exit 0
  fi
  if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "llama-server died during startup:"; tail -20 "$LOG"; exit 1
  fi
  sleep 2
done
echo "timeout waiting for health"; tail -20 "$LOG"; exit 1
