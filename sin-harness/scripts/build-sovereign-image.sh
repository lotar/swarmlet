#!/bin/bash
# Builds sin/sovereign-node:latest — a fully self-contained mesh node.
#
# Staged build context (nothing bind-mounted at RUNTIME; everything baked in):
#   llama.cpp/    <- pinned source tree supplied through LLAMA_RPC_SRC
#   sin-harness/  <- this repo's harness code (pruned of runtime artifacts)
#   model.gguf    <- OLMoE Q4_K_M weights (~4.2 GB)
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${LLAMA_RPC_SRC:-}"
MODEL="${MODEL:-$HERE/../models/OLMoE-1B-7B-0125-Instruct-Q4_K_M.gguf}"

[ -n "$SRC" ] || { echo "set LLAMA_RPC_SRC to a pinned llama.cpp checkout"; exit 1; }
test -d "$SRC/.git" || { echo "missing llama.cpp source at $SRC"; exit 1; }
test -f "$MODEL"     || { echo "missing model at $MODEL"; exit 1; }

CTX=$(mktemp -d)
trap 'rm -rf "$CTX"' EXIT
mkdir -p "$CTX/docker"
cp "$HERE/docker/Dockerfile.sovereign" "$CTX/Dockerfile.sovereign"
cp "$HERE/docker/node-entrypoint.sh"   "$CTX/docker/"
cp "$HERE/test/e2e-docker.test.ts"     /dev/null 2>/dev/null || true
# prune runtime artifacts from the harness copy
tar -C "$HERE/.." --exclude='sin-harness/data' --exclude='sin-harness/data-docker' \
    --exclude='sin-harness/gates' --exclude='sin-harness/node_modules' \
    -cf - sin-harness | tar -C "$CTX" -xf -
ln "$MODEL" "$CTX/model.gguf" 2>/dev/null || cp "$MODEL" "$CTX/model.gguf"
# NOTE: docker cannot follow symlinks that leave the build context -> real copy
rm -rf "$CTX/llama.cpp" && cp -R "$SRC" "$CTX/llama.cpp"

docker build \
  --build-arg SOURCE_COMMIT="$(git -C "$SRC" rev-parse HEAD)" \
  -t sin/sovereign-node:latest \
  -f "$CTX/Dockerfile.sovereign" "$CTX"

echo "built sin/sovereign-node:latest from llama.cpp $(git -C "$SRC" rev-parse --short HEAD)"
