#!/bin/sh
# Sovereign node entrypoint: boot LOCAL inference, then the harness node.
# Nothing here touches the host: model file is baked in, endpoint is
# localhost, keys + sqlite live in this container's own filesystem.
set -e

echo "[sovereign ${NODE_ID}] starting llama-server on ${LLAMA_HOST}:${LLAMA_PORT} (ctx ${CTX_SIZE})"
llama-server \
  -m /app/model.gguf \
  --alias "${MODEL_ALIAS:-OLMoE-1B-7B-0125-Instruct-Q4_K_M}" \
  --host "${LLAMA_HOST}" --port "${LLAMA_PORT}" \
  --ctx-size "${CTX_SIZE}" \
  --cache-reuse 256 \
  --n-gpu-layers 0 \
  -fa on \
  --jinja \
  --chat-template-kwargs '{"enable_thinking": false}' \
  > /tmp/llama.log 2>&1 &

LLAMA_PID=$!
trap 'kill "$LLAMA_PID" 2>/dev/null || true' TERM INT

i=0
until curl -sf "http://${LLAMA_HOST}:${LLAMA_PORT}/health" >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -gt 240 ]; then
    echo "[sovereign ${NODE_ID}] llama-server failed to become healthy:"
    tail -20 /tmp/llama.log
    exit 1
  fi
  if ! kill -0 "$LLAMA_PID" 2>/dev/null; then
    echo "[sovereign ${NODE_ID}] llama-server died during startup:"
    tail -20 /tmp/llama.log
    exit 1
  fi
  sleep 2
done
echo "[sovereign ${NODE_ID}] llama-server healthy after ~$((i*2))s"

exec bun mesh/node.ts \
  --id "${NODE_ID}" \
  --port "${NODE_PORT}" \
  --db "data-docker/events-${NODE_ID}.sqlite" \
  --endpoint "http://127.0.0.1:${LLAMA_PORT}"
