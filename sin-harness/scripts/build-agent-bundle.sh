#!/usr/bin/env bash
# Assemble the installer bundle (/agent/latest.tar.gz) from ONE signed agent release and refuse to ship it
# unless the agent inside matches what the release feed currently serves.
#
#   usage: build-agent-bundle.sh <release-payload-dir> [control-url]
#
# <release-payload-dir> is any directory laid out like an installed release: swarmlet-node + engine/ beside
# it, optionally agent-build.json (~/.swarmlet/releases/<seq>-*/, or an unpacked release tarball).
#
# The output lands in site/agent/, which deploy/site/Dockerfile COPYs into the site image; that directory is
# gitignored because it is 40 MB of binaries.
#
# Why the check is the point of this script: the bundle used to be built by hand and copied into the running
# container. On 2026-09-17 the served copy was six days old and carried an agent that matched no published
# release, which turned "re-run the installer to upgrade" into a downgrade - and nothing anywhere noticed.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SRC=${1:?usage: build-agent-bundle.sh <release-payload-dir> [control-url]}
CONTROL=${2:-https://app.swarmlet.ai}

sha256_of() { if command -v shasum >/dev/null; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi; }
json_field() { python3 -c "import json,sys; m=json.load(sys.stdin); print($1)"; }

[ -f "$SRC/swarmlet-node" ] || { echo "no swarmlet-node in $SRC" >&2; exit 1; }
[ -d "$SRC/engine" ] || { echo "no engine/ in $SRC (the installer needs the native engine beside the agent)" >&2; exit 1; }

STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/darwin"
cp -a "$SRC/swarmlet-node" "$SRC/engine" "$STAGE/darwin/"
[ -f "$SRC/agent-build.json" ] && cp -a "$SRC/agent-build.json" "$STAGE/darwin/"
# macOS tar adds AppleDouble files for every entry; a ._x.json once crashed a production boot loop.
find "$STAGE" -name '._*' -delete

OUT="$ROOT/site/agent"; mkdir -p "$OUT"
tar czf "$OUT/latest.tar.gz" -C "$STAGE" darwin
( cd "$OUT" && sha256_of latest.tar.gz > latest.tar.gz.sha256 )

BUNDLE_SHA=$(sha256_of "$OUT/latest.tar.gz")
INNER_SHA=$(sha256_of "$SRC/swarmlet-node")

# The feed is agent-authenticated (an unauthenticated GET returns 404), so this comparison only runs when a
# token is supplied. Without one the bundle is still checked for internal consistency, but its freshness
# cannot be proven - and that is exactly how a six-day-old bundle shipped behind an upgrade instruction, so
# refusing unless the operator says otherwise.
NOTE=""
FEED=""
# On the publishing host the feed is a file the control wrote; read it directly rather than asking the network
# for something only enrolled agents may fetch.
for candidate in "${SWARMLET_CONTROL_DIR:-}/releases/darwin-arm64/manifest.json" /root/projects/swarmlet-control/data/releases/darwin-arm64/manifest.json; do
  [ -n "$candidate" ] && [ -r "$candidate" ] && FEED=$(cat "$candidate") && break
done
if [ -z "$FEED" ] && [ -n "${SWARMLET_ADMIN_TOKEN:-}" ]; then
  FEED=$(curl -fsSL --max-time 30 -H "Authorization: Bearer $SWARMLET_ADMIN_TOKEN" "$CONTROL/api/releases/darwin-arm64" 2>/dev/null) \
    || FEED=$(curl -fsSL --max-time 30 -H "Authorization: Bearer $SWARMLET_ADMIN_TOKEN" "$CONTROL/releases/darwin-arm64/manifest.json" 2>/dev/null) \
    || FEED=""
fi

if [ -n "$FEED" ]; then
  WANT_SHA=$(printf '%s' "$FEED" | json_field 'next(f["sha256"] for f in m["files"] if f["path"]=="swarmlet-node")')
  WANT_SEQ=$(printf '%s' "$FEED" | json_field 'm["sequence"]')
  echo "  bundle  $OUT/latest.tar.gz  sha256=$BUNDLE_SHA"
  echo "  agent   $INNER_SHA"
  echo "  feed    sequence $WANT_SEQ serves $WANT_SHA"
  if [ "$INNER_SHA" != "$WANT_SHA" ]; then
    echo "REFUSING to publish this bundle: its agent is not the agent the feed serves." >&2
    echo "  bundle carries $INNER_SHA" >&2
    echo "  feed sequence $WANT_SEQ serves $WANT_SHA" >&2
    echo "  build the bundle from the payload of release $WANT_SEQ instead." >&2
    rm -f "$OUT/latest.tar.gz" "$OUT/latest.tar.gz.sha256"
    exit 1
  fi
  echo "  ok: bundle carries release $WANT_SEQ's agent; ship it with the site image (site/agent/ is COPYed)"
else
  echo "  bundle  $OUT/latest.tar.gz  sha256=$BUNDLE_SHA"
  echo "  agent   $INNER_SHA"
  if [ "${SWARMLET_ALLOW_UNVERIFIED_BUNDLE:-0}" != "1" ]; then
    echo "REFUSING to publish an unverified bundle: the release feed could not be read, so nothing proved" >&2
    echo "  this carries the agent the fleet is being offered. Set SWARMLET_ADMIN_TOKEN to let it check," >&2
    echo "  or SWARMLET_ALLOW_UNVERIFIED_BUNDLE=1 to override deliberately." >&2
    rm -f "$OUT/latest.tar.gz" "$OUT/latest.tar.gz.sha256"
    exit 1
  fi
  echo "  WARNING: freshness unverified (SWARMLET_ALLOW_UNVERIFIED_BUNDLE=1); built from $SRC"
fi
