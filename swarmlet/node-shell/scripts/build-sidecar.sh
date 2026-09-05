#!/usr/bin/env bash
# Compile one canonical service artifact, then copy it unchanged into the desktop package.
# Usage: build-sidecar.sh [darwin|linux] [--reuse-agent]
# --reuse-agent stages an already built dist/agent/<os>; checks its recorded hash.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
os="${1:-$(uname -s | tr '[:upper:]' '[:lower:]')}"
case "$os" in
  darwin) triple="aarch64-apple-darwin" ;;
  linux) triple="x86_64-unknown-linux-gnu" ;;
  *) echo "unsupported os: $os" >&2; exit 2 ;;
esac
case "${2:-}" in
  '') (cd "$root" && bun run node-agent/build.ts "$os") ;;
  --reuse-agent) ;;
  *) echo 'second argument must be --reuse-agent or omitted' >&2; exit 2 ;;
esac
agent="$root/dist/agent/$os"
out="$here/../src-tauri/binaries"
# Fail before touching the previous staging directory if the input is incomplete or corrupt.
python3 - "$agent" <<'PY_MANIFEST'
import hashlib, json, pathlib, sys
folder = pathlib.Path(sys.argv[1])
manifest = json.loads((folder / "agent-build.json").read_text())
digest = hashlib.sha256((folder / "swarmlet-node").read_bytes()).hexdigest()
if digest != manifest["sha256"]:
    raise SystemExit("canonical agent hash mismatch")
print(f"canonical agent {digest} ({manifest['revision']})")
PY_MANIFEST
for bin in ggml-rpc-server llama-server llama-ring-bench; do
  test -x "$agent/engine/$bin" || { echo "missing engine executable: $agent/engine/$bin" >&2; exit 1; }
done
(cd "$agent/engine" && shasum -a 256 -c sha256.txt)
mkdir -p "$out"
cp "$agent/swarmlet-node" "$out/swarmlet-node-$triple"
cp "$agent/agent-build.json" "$out/agent-build.json"
rm -rf "$out/engine"
cp -R "$agent/engine" "$out/engine"
cmp "$agent/swarmlet-node" "$out/swarmlet-node-$triple"
echo "staged identical service and shell agents for $os"
