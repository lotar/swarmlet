#!/bin/bash
# Boots the MoE with expert tensors distributed across the dockerized RPC
# shards ("small inference hardware"). The host acts purely as inference
# coordinator; tensor data crosses the bridge network at load time and every
# generated token traverses it during decode.
#
#   NGL=<n> ./scripts/start-mesh-model.sh       # default 99 = offload everything
#                                                # possible to accelerator devices
#   TSPLIT="1,1,1,0"                            # shard1:shard2:shard3:Metal weights
#                                                 # (default: even thirds across shards,
#                                                 #  nothing on host Metal — device order
#                                                 #  is [rpc1,rpc2,rpc3,Metal])
#
# EXPERT-SPLIT MODE (EXPERT_SPLIT=1):
#   Each shard owns SPECIFIC EXPERT TENSORS — attention, router, embeddings,
#   lm_head AND the KV cache stay on host Metal; only blk.N.ffn_(gate|up|down)_exps
#   tensors are pinned to shards via --override-tensor. OLMoE has 16 MoE layers;
#   even thirds: blk.0-5 -> RPC0, blk.6-11 -> RPC1, blk.12-15 -> RPC2.
#   Rules discovered by exploration (pinned commit 7584430):
#     - --rpc MUST precede every -ot flag (RPC buffer types register lazily)
#     - -ot RHS is a BUFFER-TYPE name: "RPC0[127.0.0.1:51052]" etc.
#     - multiple -ot accumulate; first match wins per tensor
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
LLAMA_SERVER="${LLAMA_RPC_BUILD:-/Users/lotar/projects/local-llm/llama.cpp-rpc/build-host/bin/llama-server}"
MODEL="${MODEL:-/Users/lotar/projects/ai-mesh/models/OLMoE-1B-7B-0125-Instruct-Q8_0.gguf}"
PORT=8081
NGL="${NGL:-99}"
TSPLIT="${TSPLIT:-1,1,1,0}"
CTX="${CTX:-4096}"
EXPERT_SPLIT="${EXPERT_SPLIT:-0}"

test -x "$LLAMA_SERVER" || { echo "missing $LLAMA_SERVER — build first (GGML_RPC=ON)"; exit 1; }
test -f "$MODEL" || { echo "missing model $MODEL"; exit 1; }

# Kernel-panic guard: this topology is sized for <=20GB models inside a
# 28GB/6cpu Docker VM. Refuse anything bigger BEFORE touching docker.
MODEL_GB=$(($(stat -f%z "$MODEL") / 1024 / 1024 / 1024))
[ "$MODEL_GB" -le 20 ] || { echo "refusing: model ${MODEL_GB}GB > 20GB safety envelope"; exit 1; }

for port in 51052 51053 51054; do
  nc -z 127.0.0.1 "$port" || { echo "rpc shard on :$port not up — run: docker compose -f $HERE/compose.yaml up -d rpc1 rpc2 rpc3"; exit 1; }
done

mkdir -p "$HERE/data"
LOG="$HERE/data/mesh-model.log"
PIDFILE="$HERE/data/mesh-model.pid"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "mesh model already running (pid $(cat "$PIDFILE"))"; exit 0
fi

# Expert-split: build per-shard -ot pinning flags. NOTE: these must come
# AFTER --rpc in argv (see header). TSPLIT 0,0,0,1 routes everything NOT
# matched by an override to host Metal (device order [rpc1,rpc2,rpc3,Metal]).
# LIVE-VERIFIED on commit 7584430: repeated -ot flags DO NOT accumulate
# ("only last value will be used") → ONE flag with comma-separated pairs;
# and every shard registers its buffer type as RPC0[<endpoint>] — the
# endpoint string is the only discriminator.
EXPERT_ARGS=()
if [ -n "${VERBOSITY:-}" ]; then
  EXPERT_ARGS+=( -lv "$VERBOSITY" )
fi
if [ "$EXPERT_SPLIT" = "1" ]; then
  TSPLIT="0,0,0,1"
  EP1=127.0.0.1:51052; EP2=127.0.0.1:51053; EP3=127.0.0.1:51054
  EXPERT_ARGS+=(
    -ot "blk\\.(0|1|2|3|4|5)\\.ffn_.*_exps.*=RPC0[${EP1}],blk\\.(6|7|8|9|10|11)\\.ffn_.*_exps.*=RPC0[${EP2}],blk\\.(12|13|14|15)\\.ffn_.*_exps.*=RPC0[${EP3}]"
  )
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
  "${EXPERT_ARGS[@]}" \
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
