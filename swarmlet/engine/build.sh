#!/bin/bash
# Build the Swarmlet engine: upstream llama.cpp at the pinned ref + patches/llama-mesh-engine-*.patch
# (pipelined RPC dispatcher, graph cache, push forwarding, batched GETs, wire modes, server trace,
# qwen4exp MTP head-only loading, ring-bench, --mem-cap-mib), for ONE platform.
#
#   usage: build.sh <darwin|linux> [OUT_DIR]
#   env:   SRC_DIR   reuse/create this checkout      (default: <here>/.build/llama.cpp-<target>)
#          JOBS      parallel build jobs             (default: nproc / sysctl hw.ncpu)
#          CUDA_ARCH CUDA architectures, linux only  (default: 75 = GTX 1650/1650 Ti)
#          CUDA=0    linux CPU-only build (no CUDA toolkit needed)
#
# Output: OUT_DIR/{ggml-rpc-server,llama-server,llama-ring-bench}, sha256.txt, engine.json.
# Static binaries (BUILD_SHARED_LIBS=OFF) so each one is a self-contained sidecar.
set -Eeuo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TARGET=${1:?usage: build.sh <darwin|linux> [OUT_DIR]}
case "$TARGET" in darwin|linux) ;; *) echo "unknown target $TARGET (darwin|linux)" >&2; exit 64;; esac
OUT=${2:-$HERE/dist/$TARGET}
SRC=${SRC_DIR:-$HERE/.build/llama.cpp-$TARGET}
REF=$(cat "$HERE/patches/UPSTREAM_REF")
PATCH=$(ls "$HERE"/patches/llama-mesh-engine-*.patch | head -1)
test -s "$PATCH" || { echo "missing patch under $HERE/patches" >&2; exit 65; }
if [ -z "${JOBS:-}" ]; then JOBS=$( (nproc 2>/dev/null || sysctl -n hw.ncpu) ); fi
log(){ echo "[engine $(date -u +%H:%M:%S)] $*"; }

# 1. source at the exact upstream ref (shallow fetch of one commit)
if [ ! -d "$SRC/.git" ]; then
  log "fetching upstream llama.cpp @ $REF -> $SRC"
  mkdir -p "$SRC"; git -C "$SRC" init -q
  git -C "$SRC" remote add origin https://github.com/ggml-org/llama.cpp.git
  git -C "$SRC" fetch -q --depth 1 origin "$REF"
  git -C "$SRC" checkout -q FETCH_HEAD
fi
HEAD=$(git -C "$SRC" rev-parse HEAD)
[ "$HEAD" = "$REF" ] || { echo "checkout at $HEAD, expected $REF" >&2; exit 66; }

# 2. patch (idempotent: skip when already applied, fail loudly on partial state)
if git -C "$SRC" apply --check "$PATCH" 2>/dev/null; then
  log "applying $(basename "$PATCH")"; git -C "$SRC" apply "$PATCH"
elif git -C "$SRC" apply --check --reverse "$PATCH" 2>/dev/null; then
  log "patch already applied"
else
  echo "patch does not apply cleanly to $SRC (dirty tree?)" >&2; exit 67
fi

# 3. configure
BUILD="$SRC/build-$TARGET"
COMMON=( -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_RPC=ON -DGGML_RPC_RDMA=OFF
         -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_TOOLS=ON -DLLAMA_BUILD_SERVER=ON )
case "$TARGET" in
  darwin) FLAGS=( -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_BLAS=ON -DGGML_BLAS_VENDOR=Apple -DGGML_ACCELERATE=ON );;
  linux)  if [ "${CUDA:-1}" = 1 ]; then FLAGS=( -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="${CUDA_ARCH:-75}" ); else FLAGS=( -DGGML_CUDA=OFF ); fi;;
esac
log "configure $BUILD"; cmake -S "$SRC" -B "$BUILD" "${COMMON[@]}" "${FLAGS[@]}" > "$BUILD.configure.log" 2>&1 || { tail -30 "$BUILD.configure.log"; exit 68; }

# 4. build the three deliverables
log "build (-j $JOBS)"; cmake --build "$BUILD" --target ggml-rpc-server llama-server llama-ring-bench -j "$JOBS" > "$BUILD.build.log" 2>&1 || { tail -40 "$BUILD.build.log"; exit 69; }

# 5. collect + manifest
mkdir -p "$OUT"
for b in ggml-rpc-server llama-server llama-ring-bench; do cp -f "$BUILD/bin/$b" "$OUT/$b"; done
( cd "$OUT" && shasum -a 256 ggml-rpc-server llama-server llama-ring-bench > sha256.txt )
python3 - "$OUT" "$TARGET" "$REF" "$PATCH" <<'PY'
import json, sys, hashlib, platform, datetime
out, target, ref, patch = sys.argv[1:5]
json.dump({
  "schemaVersion": 1, "target": target, "upstreamRef": ref,
  "patch": patch.rsplit('/',1)[-1], "patchSha256": hashlib.sha256(open(patch,'rb').read()).hexdigest(),
  "builtOn": platform.platform(), "builtAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
  "binaries": dict(line.split()[::-1] for line in open(f"{out}/sha256.txt")),
}, open(f"{out}/engine.json", "w"), indent=2)
PY
log "done -> $OUT"; cat "$OUT/sha256.txt"
