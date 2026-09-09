#!/usr/bin/env bash
# Standalone pinned upstream engine + real stage overlay; does not change the installed RPC engine.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${ENGINE_SOURCE:-$HERE/../.build/llama.cpp-stages}
BUILD=${STAGE_BUILD:-$HERE/../.build/stages-build}
REF=$(cat "$HERE/../patches/UPSTREAM_REF")
if [ ! -e "$SRC/.git" ]; then
  mkdir -p "$SRC"
  git -C "$SRC" init -q
  git -C "$SRC" fetch --depth 1 https://github.com/ggml-org/llama.cpp.git "$REF"
  git -C "$SRC" checkout --detach FETCH_HEAD
fi
[ "$(git -C "$SRC" rev-parse HEAD)" = "$REF" ] || { echo 'stage engine base mismatch' >&2; exit 1; }
if git -C "$SRC" apply --check "$HERE/qwen35-stage.patch" 2>/dev/null; then
  git -C "$SRC" apply "$HERE/qwen35-stage.patch"
else
  git -C "$SRC" apply --reverse --check "$HERE/qwen35-stage.patch"
fi
python3 "$HERE/source_identity.py" "$SRC" "$HERE/qwen35-stage.patch" "$REF"
ENGINE_ID=$(python3 - "$HERE" <<'PY'
import hashlib,pathlib,sys
p=pathlib.Path(sys.argv[1]);h=hashlib.sha256()
for n in ['qwen35-stage.patch','worker.cpp','capsule_io.hpp','CMakeLists.txt','build.sh','source_identity.py']:
 h.update((p/n).read_bytes())
h.update((p.parent/'patches/UPSTREAM_REF').read_bytes());print(h.hexdigest())
PY
)
METAL=OFF
if [ "$(uname -s)" = Darwin ]; then METAL=ON; fi
cmake -S "$HERE" -B "$BUILD" -DENGINE_SOURCE="$SRC" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_METAL="$METAL" -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_CUDA="${CUDA:-OFF}" -DCMAKE_CUDA_ARCHITECTURES="${CUDA_ARCH:-75}" -DGGML_BLAS=OFF -DENGINE_ID="$ENGINE_ID"
cmake --build "$BUILD" --target mesh-stage-worker -j 2
