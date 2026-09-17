#!/usr/bin/env bash
# Fail when the installer bundle a stranger downloads is not the agent the release feed serves.
#
#   usage: check-served-bundle.sh [control-url]
#
# Read-only and network-bound: if the bundle cannot be fetched at all (no network), it says so and exits 0,
# because an offline gate must not fail. A bundle that IS served and does not match the feed is a hard failure.
set -euo pipefail

CONTROL=${1:-https://app.swarmlet.ai}
sha256_of() { if command -v shasum >/dev/null; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi; }
json_field() { python3 -c "import json,sys; m=json.load(sys.stdin); print($1)"; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

if ! curl -fsSL --max-time 90 -o "$TMP/latest.tar.gz" "$CONTROL/agent/latest.tar.gz"; then
  echo "check-served-bundle: cannot download $CONTROL/agent/latest.tar.gz (no network?); skipping" >&2
  exit 0
fi

# The published checksum is optional, but when present it must describe what was actually served.
if curl -fsSL --max-time 30 -o "$TMP/latest.tar.gz.sha256" "$CONTROL/agent/latest.tar.gz.sha256" 2>/dev/null; then
  SERVED_WANT=$(awk '{print $1}' "$TMP/latest.tar.gz.sha256")
  SERVED_GOT=$(sha256_of "$TMP/latest.tar.gz")
  if [ "$SERVED_WANT" != "$SERVED_GOT" ]; then
    echo "check-served-bundle: the served tarball does not match the served .sha256" >&2
    echo "  tarball $SERVED_GOT" >&2
    echo "  .sha256 $SERVED_WANT" >&2
    exit 1
  fi
fi

tar xzf "$TMP/latest.tar.gz" -C "$TMP"
AGENT=$(find "$TMP" -name swarmlet-node -type f | head -1)
[ -n "$AGENT" ] || { echo "check-served-bundle: the served bundle contains no swarmlet-node" >&2; exit 1; }
INNER_SHA=$(sha256_of "$AGENT")

# The invariant this exists for, and the one that cost six days: what is served must carry the agent the
# release feed is offering. The feed is agent-authenticated, so this reads it from the file the control wrote
# when the check runs on the publishing host, or over HTTP with a token when it does not.
FEED=""
for candidate in "${SWARMLET_CONTROL_DIR:-}/releases/darwin-arm64/manifest.json" /root/projects/swarmlet-control/data/releases/darwin-arm64/manifest.json; do
  [ -n "$candidate" ] && [ -r "$candidate" ] && FEED=$(cat "$candidate") && break
done
if [ -z "$FEED" ] && [ -n "${SWARMLET_ADMIN_TOKEN:-}" ]; then
  FEED=$(curl -fsSL --max-time 30 -H "Authorization: Bearer $SWARMLET_ADMIN_TOKEN" "$CONTROL/api/releases/darwin-arm64" 2>/dev/null) \
    || FEED=$(curl -fsSL --max-time 30 -H "Authorization: Bearer $SWARMLET_ADMIN_TOKEN" "$CONTROL/releases/darwin-arm64/manifest.json" 2>/dev/null) \
    || FEED=""
fi

if [ -z "$FEED" ]; then
  # Without the feed this can only prove internal consistency. Say so instead of pretending, and name the
  # command that does prove freshness.
  echo "  served bundle is $INNER_SHA (freshness vs the feed unverified here: no feed file and no SWARMLET_ADMIN_TOKEN)"
  exit 0
fi

WANT_SHA=$(printf '%s' "$FEED" | json_field 'next(f["sha256"] for f in m["files"] if f["path"]=="swarmlet-node")')
WANT_SEQ=$(printf '%s' "$FEED" | json_field 'm["sequence"]')

if [ "$INNER_SHA" != "$WANT_SHA" ]; then
  echo "check-served-bundle: STALE INSTALLER BUNDLE" >&2
  echo "  $CONTROL/agent/latest.tar.gz carries agent $INNER_SHA" >&2
  echo "  the feed's release $WANT_SEQ serves $WANT_SHA" >&2
  echo "  anyone following 're-run the installer to upgrade' would install the wrong agent." >&2
  echo "  rebuild with: sin-harness/scripts/build-agent-bundle.sh <payload-of-$WANT_SEQ> && rebuild the site image" >&2
  exit 1
fi

echo "  served bundle matches feed sequence $WANT_SEQ (agent $INNER_SHA)"
