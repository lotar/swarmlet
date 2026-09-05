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
  # Local builds have only a linker signature until the complete app is sealed.
  # Preserve an explicitly configured signing identity; otherwise use local ad-hoc signing.
  if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
    codesign --force --deep --sign - "$build_target/release/bundle/$subdir/Swarmlet Node.app"
  fi
  codesign --verify --deep --strict "$build_target/release/bundle/$subdir/Swarmlet Node.app"
  # Signing can change the sidecar bytes. Publish that exact artifact for both service
  # and GUI, and record its final hash instead of the pre-signing compiler output.
  python3 - "$root/dist/agent/darwin" "$build_target/release/bundle/$subdir/Swarmlet Node.app/Contents/MacOS/swarmlet-node" <<'PY_SIGNED_AGENT'
import hashlib, json, os, pathlib, shutil, sys
folder, sidecar = map(pathlib.Path, sys.argv[1:])
manifest = json.loads((folder / "agent-build.json").read_text())
manifest.setdefault("compiledSha256", manifest["sha256"])
manifest["sha256"] = hashlib.sha256(sidecar.read_bytes()).hexdigest()
temporary = folder / "swarmlet-node.signed"
shutil.copy2(sidecar, temporary)
os.replace(temporary, folder / "swarmlet-node")
(folder / "agent-build.json").write_text(json.dumps(manifest, indent=2) + "\n")
PY_SIGNED_AGENT
  rm -rf "$out/Swarmlet Node.app"
  cp -R "$build_target/release/bundle/$subdir/Swarmlet Node.app" "$out/"
else
  version="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$here/../src-tauri/tauri.conf.json")"
  product="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["productName"])' "$here/../src-tauri/tauri.conf.json")"
  cp "$build_target/release/bundle/$subdir/${product}_${version}_amd64.deb" "$out/swarmlet-node_${version}_amd64.deb"
fi
cp "$root/dist/agent/$os/agent-build.json" "$out/agent-build.json"
echo "release staged at $out; service artifact at $root/dist/agent/$os (not installed)"
