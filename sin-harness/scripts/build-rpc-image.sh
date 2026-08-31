#!/usr/bin/env bash
# Builds the llama.cpp RPC shard image from the SAME pinned source commit as
# the host build in ../llama.cpp-rpc (protocol compatibility is mandatory:
# ggml RPC has no cross-version guarantee).
#
# Usage: scripts/build-rpc-image.sh
set -euo pipefail

SRC="${LLAMA_RPC_SRC:-}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

[ -n "$SRC" ] || { echo "set LLAMA_RPC_SRC to a pinned llama.cpp checkout"; exit 1; }
test -d "$SRC/.git" || { echo "missing llama.cpp source at $SRC"; exit 1; }

# Keep the external llama.cpp checkout immutable. BuildKit's named context
# supplies its source while the default context remains this repository.
DOCKER_BUILDKIT=1 docker build \
  --build-context llama="$SRC" \
  --build-arg SOURCE_COMMIT="$(git -C "$SRC" rev-parse HEAD)" \
  -t sin/rpc-server:latest \
  -f "$HERE/docker/Dockerfile.rpc" "$HERE"

echo "built sin/rpc-server:latest from $(git -C "$SRC" rev-parse --short HEAD)"
echo "verify the host llama-server was built from the same commit before connecting"
