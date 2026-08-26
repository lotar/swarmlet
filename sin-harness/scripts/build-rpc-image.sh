# Builds the llama.cpp RPC shard image from the SAME pinned source commit as
# the host build in ../llama.cpp-rpc (protocol compatibility is mandatory:
# ggml RPC has no cross-version guarantee).
#
# Usage: scripts/build-rpc-image.sh
set -euo pipefail

SRC="${LLAMA_RPC_SRC:-/Users/lotar/projects/local-llm/llama.cpp-rpc}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

test -d "$SRC/.git" || { echo "missing llama.cpp source at $SRC"; exit 1; }

# The build context must be the llama.cpp source tree; stage our files into it.
cp "$HERE/docker/Dockerfile.rpc"   "$SRC/Dockerfile.rpc-sin"
cp "$HERE/docker/rpc-entrypoint.sh" "$SRC/rpc-entrypoint.sh"

docker build \
  --build-arg SOURCE_COMMIT="$(git -C "$SRC" rev-parse HEAD)" \
  -t sin/rpc-server:latest \
  -f "$SRC/Dockerfile.rpc-sin" "$SRC"

echo "built sin/rpc-server:latest from $(git -C "$SRC" rev-parse --short HEAD)"
echo "host binary commit: $(git -C "$HERE/../local-llm/llama.cpp-rpc" rev-parse --short HEAD 2>/dev/null || echo check-manually)"
