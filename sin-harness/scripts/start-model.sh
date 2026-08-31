#!/usr/bin/env bash
# Boots llama-server with the PoC MoE model (OLMoE-1B-7B Q8_0) on :8081.
# Idempotent: exits 0 immediately if the endpoint is already healthy.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL="${MODEL:-$ROOT/../models/OLMoE-1B-7B-0125-Instruct-Q8_0.gguf}"
LLAMA_SERVER="${LLAMA_SERVER:-$(command -v llama-server || true)}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8081}"
LOG="$ROOT/data/llama-server.log"
PIDFILE="$ROOT/data/llama-server.pid"

mkdir -p "$ROOT/data"

health() { curl -sf "http://$HOST:$PORT/health" >/dev/null 2>&1; }

if health; then
  echo "[start-model] already healthy at http://$HOST:$PORT"
  exit 0
fi

if [ ! -f "$MODEL" ]; then
  echo "[start-model] ERROR: model file missing: $MODEL" >&2
  echo "[start-model] download with:" >&2
  echo "  curl -L -o '$MODEL' https://huggingface.co/allenai/OLMoE-1B-7B-0125-Instruct-GGUF/resolve/main/OLMoE-1B-7B-0125-Instruct-Q8_0.gguf" >&2
  exit 1
fi

test -n "$LLAMA_SERVER" && test -x "$LLAMA_SERVER" || { echo "[start-model] ERROR: llama-server missing; set LLAMA_SERVER" >&2; exit 1; }
echo "[start-model] launching llama-server (OLMoE-1B-7B Q8_0) on $HOST:$PORT ..."
nohup "$LLAMA_SERVER" \
  -m "$MODEL" \
  --host "$HOST" \
  --port "$PORT" \
  --ctx-size 8192 \
  --cache-reuse 256 \
  >>"$LOG" 2>&1 &

echo $! >"$PIDFILE"

for i in $(seq 1 180); do
  if health; then
    echo "[start-model] ready after ${i}s (pid $(cat "$PIDFILE"), log: $LOG)"
    exit 0
  fi
  if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "[start-model] ERROR: llama-server exited early — last log lines:" >&2
    tail -20 "$LOG" >&2
    exit 1
  fi
  sleep 1
done

echo "[start-model] ERROR: health check timed out after 180s" >&2
exit 1
