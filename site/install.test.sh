#!/usr/bin/env bash
# Tests for site/install.sh.
#
# Every case runs against a THROWAWAY HOME and a LOCAL bundle, with curl replaced by a stub: the real
# script restarts a live node service, and on 2026-09-16 a bare no-arg run did exactly that on this
# machine - it silently took the upgrade path, rewrote the launchd unit and dropped a generation that
# was mid-flight. These tests exist so that cannot happen again unnoticed.
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT="$ROOT/site/install.sh"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; }
expect_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want '$2' got '$3')"; fi; }
expect_contains() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1 (missing '$3')" ;; esac; }

# ---- a stub release: swarmlet-node records what it was asked to do -------------
PAYLOAD="$WORK/payload"; mkdir -p "$PAYLOAD/engine"
cat > "$PAYLOAD/swarmlet-node" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_LOG"
case "${1:-}" in
  join)    mkdir -p "$HOME/.swarmlet"; printf '{"enrolledNodeId":"test-node-0001"}\n' > "$HOME/.swarmlet/node.json" ;;
  install) mkdir -p "$HOME/Library/LaunchAgents"; printf 'plist v1\n' > "$HOME/Library/LaunchAgents/ai.swarmlet.node.plist" ;;
esac
exit 0
STUB
chmod +x "$PAYLOAD/swarmlet-node"
BUNDLE="$WORK/latest.tar.gz"
tar czf "$BUNDLE" -C "$PAYLOAD" .
if command -v shasum >/dev/null; then shasum -a 256 "$BUNDLE" | awk '{print $1"  latest.tar.gz"}' > "$BUNDLE.sha256"
else sha256sum "$BUNDLE" | awk '{print $1"  latest.tar.gz"}' > "$BUNDLE.sha256"; fi

# ---- a stub curl: serves the local bundle, refuses anything else --------------
mkdir -p "$WORK/bin"
cat > "$WORK/bin/curl" <<'CURL'
#!/usr/bin/env bash
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -C|--retry|--retry-delay|--max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  *.tar.gz.sha256) src="$FAKE_BUNDLE.sha256" ;;
  *.tar.gz)        src="$FAKE_BUNDLE" ;;
  *) printf 'stub curl: refusing %s\n' "$url" >&2; exit 22 ;;
esac
[ -r "$src" ] || { printf 'stub curl: missing %s\n' "$src" >&2; exit 22; }
cp "$src" "$out"
CURL
chmod +x "$WORK/bin/curl"
export FAKE_BUNDLE="$BUNDLE" STUB_LOG="$WORK/stub-calls.log"

# ---- helpers ------------------------------------------------------------------
new_home() { local h="$WORK/$1"; mkdir -p "$h"; printf '%s' "$h"; }
enrolled() { local h="$1"; mkdir -p "$h/.swarmlet"; printf '{"enrolledNodeId":"already-enrolled-0001"}\n' > "$h/.swarmlet/node.json"; }
run_install() { local h="$1"; shift; HOME="$h" PATH="$WORK/bin:$PATH" SWARMLET_BUNDLE_URL="https://fake.invalid/latest.tar.gz" \
  bash "$SCRIPT" "$@" >"$WORK/out.txt" 2>&1; echo $?; }

echo "install.sh tests"

# 1. fresh box, no join code: usage, non-zero, nothing downloaded
h=$(new_home fresh-noargs)
rc=$(run_install "$h")
[ "$rc" != 0 ] && ok "fresh box with no join code exits non-zero" || bad "fresh box with no join code exited 0"
expect_contains "fresh box with no join code prints usage" "$(cat "$WORK/out.txt")" "bash install.sh <JOIN-CODE>"
[ ! -e "$h/swarmlet-agent" ] && ok "fresh box with no join code installed nothing" || bad "fresh box with no join code installed files"

# 2. the incident: enrolled box, bare no-arg run
rm -f "$STUB_LOG"
h=$(new_home enrolled-noargs); enrolled "$h"
rc=$(run_install "$h")
[ "$rc" != 0 ] && ok "enrolled box with no arguments exits non-zero" || bad "enrolled box with no arguments exited 0"
out="$(cat "$WORK/out.txt")"
expect_contains "enrolled box with no arguments says it is refusing" "$out" "refusing to upgrade without being asked"
expect_contains "enrolled box with no arguments prints usage" "$out" "--upgrade"
[ ! -e "$h/swarmlet-agent" ] && ok "enrolled box with no arguments installed nothing" || bad "enrolled box with no arguments rewrote the agent dir"
[ ! -f "$STUB_LOG" ] && ok "enrolled box with no arguments never ran the agent (nothing was restarted)" || bad "enrolled box with no arguments ran the agent: $(cat "$STUB_LOG" 2>/dev/null)"

# 3. --help
rc=$(run_install "$(new_home help)" --help)
expect_eq "--help exits 0" "0" "$rc"
expect_contains "--help prints the upgrade path" "$(cat "$WORK/out.txt")" "--upgrade"

# 4. fresh enrollment with a join code still works end to end
rm -f "$STUB_LOG"
h=$(new_home fresh-code)
rc=$(run_install "$h" "JOIN-CODE-123")
expect_eq "fresh enrollment with a join code exits 0" "0" "$rc"
[ -f "$h/Library/LaunchAgents/ai.swarmlet.node.plist" ] && ok "fresh enrollment installs the service unit" || bad "fresh enrollment did not install the service unit"
grep -q enrolledNodeId "$h/.swarmlet/node.json" 2>/dev/null && ok "fresh enrollment leaves an identity" || bad "fresh enrollment wrote no identity"
grep -qE '^join [^ ]+ JOIN-CODE-123$' "$STUB_LOG" 2>/dev/null && ok "fresh enrollment called join with the code" || bad "fresh enrollment did not call join: $(cat "$STUB_LOG" 2>/dev/null)"
[ -f "$h/swarmlet-agent/.bundle.sha256" ] && ok "fresh enrollment records the installed bundle" || bad "fresh enrollment did not record the bundle digest"

# 5. --upgrade on an enrolled box: explicit, and it does upgrade
rm -f "$STUB_LOG"
h=$(new_home enrolled-upgrade); enrolled "$h"
rc=$(run_install "$h" --upgrade)
expect_eq "--upgrade on an enrolled box exits 0" "0" "$rc"
expect_contains "--upgrade warns that the node will restart" "$(cat "$WORK/out.txt")" "node restarts"
[ -f "$h/Library/LaunchAgents/ai.swarmlet.node.plist" ] && ok "--upgrade installs the service unit" || bad "--upgrade did not install the service unit"

# 6. the same bundle twice is a no-op (idempotence)
before=$(stat -f %m "$h/Library/LaunchAgents/ai.swarmlet.node.plist" 2>/dev/null || stat -c %Y "$h/Library/LaunchAgents/ai.swarmlet.node.plist")
rm -f "$STUB_LOG"
sleep 1
rc=$(run_install "$h" --upgrade)
expect_eq "same bundle again exits 0" "0" "$rc"
expect_contains "same bundle again says it is already installed" "$(cat "$WORK/out.txt")" "already installed"
after=$(stat -f %m "$h/Library/LaunchAgents/ai.swarmlet.node.plist" 2>/dev/null || stat -c %Y "$h/Library/LaunchAgents/ai.swarmlet.node.plist")
expect_eq "same bundle again does not touch the service unit" "$before" "$after"
[ ! -f "$STUB_LOG" ] && ok "same bundle again never ran the agent" || bad "same bundle again ran the agent: $(cat "$STUB_LOG" 2>/dev/null)"

# 7. --force reinstalls the identical bundle anyway
rm -f "$STUB_LOG"
rc=$(run_install "$h" --upgrade --force)
expect_eq "--upgrade --force exits 0" "0" "$rc"
grep -q '^install$' "$STUB_LOG" 2>/dev/null && ok "--force reinstalls the service unit" || bad "--force did not reinstall: $(cat "$STUB_LOG" 2>/dev/null)"

# 8. a typo is an error, not a silent enrollment attempt
rc=$(run_install "$(new_home badopt)" --upgraed)
[ "$rc" != 0 ] && ok "unknown option exits non-zero" || bad "unknown option exited 0"

# 9. no path through this script ever touches the real user's home
grep -q 'SWARMLET_AGENT_DIR' "$SCRIPT" && ok "the agent dir is overridable (tests never use the real one)" || bad "the agent dir is not overridable"

echo
echo "RESULT: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
