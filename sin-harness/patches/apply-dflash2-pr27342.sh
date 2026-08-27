#!/bin/bash
# Rebase upstream llama.cpp DFlash2 runtime logic onto local Qwen4Exp tree.
set -euo pipefail
URL=https://github.com/ggml-org/llama.cpp/pull/27342.patch
SHA=4546522623cb3a5fd0949f91f6d716da781b0330f645896b86a834e70653fbf2
TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT
curl -fsSL "$URL" -o "$TMP"
echo "$SHA  $TMP" | shasum -a 256 -c -
git apply --check "$TMP"
git apply "$TMP"
echo "applied DFlash2 PR #27342 ($SHA)"
