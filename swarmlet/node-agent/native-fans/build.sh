#!/bin/sh
set -eu
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
target=${1:?darwin or linux required}
out=${2:?output directory required}
mkdir -p "$out"
case "$target" in
  darwin) swiftc -O -target "$(uname -m)-apple-macosx12.0" "$here"/darwin/*.swift -o "$out/swarmlet-fans"; cp "$here/darwin/LICENSE.fanctl" "$out/LICENSE.fanctl" ;;
  linux) cp "$here/linux/swarmlet-fans" "$out/swarmlet-fans"; chmod 755 "$out/swarmlet-fans" ;;
  *) echo "No writable generic fan provider for $target" >&2; exit 1 ;;
esac
