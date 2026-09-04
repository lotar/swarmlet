#!/usr/bin/env bash
# Build the sidecar (the Bun-compiled node agent) and copy the engine binaries for the host
# platform into src-tauri/, where tauri.conf.json expects them:
#   src-tauri/binaries/swarmlet-node-<target-triple>   (bundle.externalBin)
#   src-tauri/binaries/engine/                          (bundle.resources -> Contents/Resources/engine)
# Usage: scripts/build-sidecar.sh [darwin|linux]   (default: host OS)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"                # swarmlet/
os="${1:-$(uname -s | tr '[:upper:]' '[:lower:]')}"
case "$os" in
  darwin) triple="aarch64-apple-darwin";      bun_target="bun-darwin-arm64" ;;
  linux)  triple="x86_64-unknown-linux-gnu";  bun_target="bun-linux-x64" ;;
  *) echo "unsupported os: $os" >&2; exit 2 ;;
esac
out="$here/../src-tauri/binaries"
mkdir -p "$out"
echo "compiling node agent -> $out/swarmlet-node-$triple"
(cd "$root" && bun build --compile --minify "--target=$bun_target" node-agent/main.ts --outfile "$out/swarmlet-node-$triple")
engine="$root/engine/dist/$os"
if [ -d "$engine" ]; then
  rm -rf "$out/engine" && mkdir -p "$out/engine" && cp "$engine"/* "$out/engine/"
  (cd "$out/engine" && shasum -a 256 -c sha256.txt)
  echo "engine copied from $engine"
else
  echo "note: no engine dist at $engine (build it with engine/build.sh $os); the agent will fall back to its default engine path" >&2
fi
