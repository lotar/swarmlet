#!/usr/bin/env bash
# Native app/deb only. Run after the operator's idle gate; this never installs or restarts.
# Usage: build-release.sh [--reuse-agent]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$os" in
  darwin) bundle=app; subdir=macos ;;
  linux) bundle=deb; subdir=deb ;;
  *) echo "unsupported os: $os" >&2; exit 2 ;;
esac
"$here/build-sidecar.sh" "$os" "${1:-}"
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
(cd "$here/../src-tauri" && cargo tauri build --bundles "$bundle")
build_target="${CARGO_TARGET_DIR:-$here/../src-tauri/target}"
out="$root/dist/shell/$os"
mkdir -p "$out"
# Clear only this script's known output name, so old releases cannot masquerade as this build.
if [ "$os" = darwin ]; then
  rm -rf "$out/Swarmlet Node.app"
  cp -R "$build_target/release/bundle/$subdir/Swarmlet Node.app" "$out/"
else
  version="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$here/../src-tauri/tauri.conf.json")"
  product="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["productName"])' "$here/../src-tauri/tauri.conf.json")"
  cp "$build_target/release/bundle/$subdir/${product}_${version}_amd64.deb" "$out/swarmlet-node_${version}_amd64.deb"
fi
cp "$root/dist/agent/$os/agent-build.json" "$out/agent-build.json"
echo "release staged at $out; service artifact at $root/dist/agent/$os (not installed)"
