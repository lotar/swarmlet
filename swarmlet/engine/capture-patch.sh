#!/bin/bash
# Capture the engine delta from a patched llama.cpp working tree into patches/.
#   usage: capture-patch.sh <lab-tree>      (e.g. /tmp/llama-full-lab)
# Writes patches/UPSTREAM_REF (full upstream sha) and patches/llama-mesh-engine-<short>.patch
# covering modified AND new files (intent-to-add, no index change persists).
set -Eeuo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
LAB=${1:?usage: capture-patch.sh <lab-tree>}
REF=$(git -C "$LAB" rev-parse HEAD); SHORT=${REF:0:7}
mkdir -p "$HERE/patches"
untracked=$(git -C "$LAB" ls-files --others --exclude-standard | grep -v -E '^(build|\.build)' || true)
if [ -n "$untracked" ]; then git -C "$LAB" add -N $untracked; fi
git -C "$LAB" diff --binary > "$HERE/patches/llama-mesh-engine-$SHORT.patch"
if [ -n "$untracked" ]; then git -C "$LAB" reset -q -- $untracked; fi
echo "$REF" > "$HERE/patches/UPSTREAM_REF"
echo "upstream $REF"; git -C "$LAB" diff --stat | tail -1
echo "new files: $(echo "$untracked" | tr '\n' ' ')"
wc -l "$HERE/patches/llama-mesh-engine-$SHORT.patch"
