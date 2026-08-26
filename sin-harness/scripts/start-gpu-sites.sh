#!/bin/bash
# GPU-site simulator: three independent native Metal llama-server sidecars.
# Each process owns its own model mapping, KV cache, port and lifecycle. Docker
# nodes point 1:1 at these endpoints via host.docker.internal.
#
# This is PERFORMANCE simulation, not the sovereignty proof: all three logical
# GPUs share the physical M5 Max. The CPU sovereign topology remains available.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="${LLAMA_SERVER:-/Users/lotar/projects/local-llm/llama.cpp-rpc/build-host/bin/llama-server}"
MODEL="${MODEL:-$HERE/../models/OLMoE-1B-7B-0125-Instruct-Q4_K_M.gguf}"
TARGET="${1:-all}"
mkdir -p "$HERE/data/gpu-sites"

test -x "$SERVER" || { echo "missing $SERVER"; exit 1; }
test -f "$MODEL"  || { echo "missing $MODEL"; exit 1; }

start_one() {
  id=$1; port=$2
  dir="$HERE/data/gpu-sites/$id"; mkdir -p "$dir"
  pidfile="$dir/pid"; log="$dir/llama.log"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "[$id] already running pid=$(cat "$pidfile") :$port"; return
  fi
  if curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
    echo "[$id] refusing: :$port healthy but not owned by pidfile"; exit 1
  fi
  nohup "$SERVER" \
    -m "$MODEL" --alias "OLMoE-GPU-${id}" \
    --host 0.0.0.0 --port "$port" \
    --ctx-size 2048 --parallel 1 --cache-reuse 256 \
    --n-gpu-layers 99 -fa on --jinja \
    --chat-template-kwargs '{"enable_thinking": false}' \
    > "$log" 2>&1 &
  echo $! > "$pidfile"
  for i in $(seq 1 180); do
    curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1 && {
      echo "[$id] Metal sidecar healthy :$port pid=$(cat "$pidfile") after ~$((i*2))s"; return;
    }
    kill -0 "$(cat "$pidfile")" 2>/dev/null || { echo "[$id] died:"; tail -20 "$log"; exit 1; }
    sleep 2
  done
  echo "[$id] startup timeout"; tail -20 "$log"; exit 1
}

case "$TARGET" in
  all) start_one n1 8081; start_one n2 18082; start_one n3 18083 ;;
  n1) start_one n1 8081 ;;
  n2) start_one n2 18082 ;;
  n3) start_one n3 18083 ;;
  *) echo "usage: $0 [all|n1|n2|n3]"; exit 2 ;;
esac
