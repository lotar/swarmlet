#!/usr/bin/env bash
# Swarmlet node installer — enroll this Mac/Linux box as a node in the mesh.
#
#   curl -fsSL https://app.swarmlet.ai/install.sh | bash -s -- <JOIN-CODE>
#   or:  bash install.sh <JOIN-CODE>#
# Get a join code from the control UI (Nodes > new join code) or:
#   curl -sX POST https://app.swarmlet.ai/api/join-codes -H "Authorization: Bearer <admin token>"
#
# JOIN CODES EXPIRE IN 10 MINUTES (the control hard-codes the TTL; the API takes no
# override). Fetch the code when you are ready to run this, not before.
#
# Env overrides:
#   SWARMLET_CONTROL_URL   default https://app.swarmlet.ai
#   SWARMLET_BUNDLE_URL    default <control>/agent/latest.tar.gz (a hardlink to the current
#                          darwin-arm64 build; override for another platform/version, e.g.
#                          <control>/agent/swarmlet-agent-darwin-arm64.tar.gz)
#   SWARMLET_AGENT_DIR     default $HOME/swarmlet-agent
#   SWARMLET_REJOIN=1      re-enroll even if this box already has a node identity
#   SWARMLET_SKIP_VERIFY=1 skip the sha256 check on the bundle (not recommended)
set -euo pipefail

CONTROL_URL="${SWARMLET_CONTROL_URL:-https://app.swarmlet.ai}"
AGENT_DIR="${SWARMLET_AGENT_DIR:-$HOME/swarmlet-agent}"
CODE="${1:-${SWARMLET_JOIN_CODE:-}}"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ---- platform ---------------------------------------------------------------
os="$(uname -s)"; arch="$(uname -m)"
case "$os" in
  Darwin) os_id=darwin ;;
  Linux)  os_id=linux ;;
  *) die "unsupported OS '$os' — this installer handles darwin and linux; on Windows use the
   signed installer from the control UI." ;;
esac
case "$arch" in
  arm64|aarch64) arch_id=arm64 ;;
  x86_64|amd64)  arch_id=x64 ;;
  *) die "unsupported architecture '$arch'" ;;
esac
# The node agent needs Apple Silicon for Metal inference. An Intel Mac can enroll and
# relay, but cannot hold GPU layers; warn rather than refuse.
if [ "$os_id" = darwin ] && [ "$arch_id" = x64 ]; then
  echo "warning: Intel Mac — this node can enroll and relay but has no Metal GPU offer." >&2
fi

# CANONICAL BUNDLE URL: /agent/latest.tar.gz is the stable "latest build" path (a hardlink to
# the platform build inside the web container). CAVEAT: an unqualified `latest` cannot express
# platform, and only the darwin-arm64 bundle is published today - running this on Linux or on
# an Intel Mac would download a macOS Apple Silicon binary. Those platforms must override
# SWARMLET_BUNDLE_URL with their own artifact once one is published.
BUNDLE_URL="${SWARMLET_BUNDLE_URL:-$CONTROL_URL/agent/latest.tar.gz}"
BUNDLE="$(basename "$BUNDLE_URL")"
if [ -z "${SWARMLET_BUNDLE_URL:-}" ] && { [ "$os_id" != darwin ] || [ "$arch_id" != arm64 ]; }; then
  die "no bundle is published for $os_id/$arch_id: $BUNDLE_URL serves the macOS Apple Silicon
   build only. Publish a bundle for this platform and pass it explicitly:
     SWARMLET_BUNDLE_URL=<url> bash install.sh <JOIN-CODE>"
fi

# ---- join code --------------------------------------------------------------
# Only needed for a first enrollment; an already-enrolled box can re-run to upgrade.
_have_identity=0
[ -r "${SWARMLET_HOME:-$HOME/.swarmlet}/node.json" ] && grep -q '"enrolledNodeId"[[:space:]]*:[[:space:]]*"' "$HOME/.swarmlet/node.json" && _have_identity=1
if [ -z "$CODE" ] && [ "$_have_identity" = 0 ]; then
  die "no join code given. Usage: bash install.sh <JOIN-CODE>
   Mint one (valid 10 minutes) with:
     curl -sX POST $CONTROL_URL/api/join-codes -H \"Authorization: Bearer <admin token>\""
fi

say "control:   $CONTROL_URL"
say "node:      $os_id/$arch_id"
say "install to: $AGENT_DIR"

command -v curl >/dev/null || die "curl is required"

# ---- fetch + verify ---------------------------------------------------------
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
say "downloading $BUNDLE"
curl -fL --retry 3 --retry-delay 2 -C - -o "$tmp/$BUNDLE" "$BUNDLE_URL" \
  || die "download failed: $BUNDLE_URL"

if [ "${SWARMLET_SKIP_VERIFY:-0}" != "1" ]; then
  if curl -fsL --max-time 60 -o "$tmp/$BUNDLE.sha256" "$BUNDLE_URL.sha256" 2>/dev/null; then
    want="$(awk '{print $1}' "$tmp/$BUNDLE.sha256")"
    if command -v shasum >/dev/null; then got="$(shasum -a 256 "$tmp/$BUNDLE" | awk '{print $1}')"
    else got="$(sha256sum "$tmp/$BUNDLE" | awk '{print $1}')"; fi
    [ "$want" = "$got" ] || die "sha256 mismatch on $BUNDLE
   want $want
   got  $got
   Refusing to install. Retry, or set SWARMLET_SKIP_VERIFY=1 to override."
    say "sha256 verified: $got"
  else
    echo "warning: no .sha256 published for $BUNDLE; skipping integrity check" >&2
  fi
fi

# ---- unpack -----------------------------------------------------------------
mkdir -p "$AGENT_DIR"
say "unpacking to $AGENT_DIR"
tar xzf "$tmp/$BUNDLE" -C "$AGENT_DIR" --strip-components=1
[ -x "$AGENT_DIR/swarmlet-node" ] || chmod +x "$AGENT_DIR/swarmlet-node"
[ -d "$AGENT_DIR/engine" ] && chmod +x "$AGENT_DIR"/engine/* 2>/dev/null || true
# A tarball fetched over the network on macOS gets quarantined and killed on first run.
if [ "$os_id" = darwin ] && command -v xattr >/dev/null; then
  xattr -c "$AGENT_DIR/swarmlet-node" 2>/dev/null || true
  xattr -cr "$AGENT_DIR/engine" 2>/dev/null || true
fi
cd "$AGENT_DIR"

# ---- enroll -----------------------------------------------------------------
# Re-running this script on an already-enrolled box must NOT re-join: join rewrites the
# node config and identity, which would orphan the node in the control's registry.
# The agent resolves its state from SWARMLET_HOME (the service unit sets it), not from HOME alone —
# so this check must look where the agent actually writes, or an isolated run reports failure
# for a box that enrolled perfectly.
CONFIG="${SWARMLET_HOME:-$HOME/.swarmlet}/node.json"
if [ -r "$CONFIG" ] && grep -q '"enrolledNodeId"[[:space:]]*:[[:space:]]*"' "$CONFIG" && [ "${SWARMLET_REJOIN:-0}" != "1" ]; then
  say "already enrolled as $(sed -n 's/.*"enrolledNodeId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONFIG" | head -1)"
  say "skipping join; upgrading files only"
else
  say "enrolling with the control"
  # `join` leaves its runtime alive after a successful enrollment (data listener, UI, timers), so it
  # can outlive the enrollment itself and block every later step - which is how the service install
  # came to be skipped. Run it in the background and poll the identity file, which is what actually
  # decides whether this box is enrolled. Not `timeout`: macOS ships no such command, a trap a dry run
  # caught after the first fix replaced one silent failure with another.
  ./swarmlet-node join "$CONTROL_URL" "$CODE" &
  join_pid=$!
  for _ in $(seq 1 60); do
    if [ -r "$CONFIG" ] && grep -q '"enrolledNodeId"[[:space:]]*:[[:space:]]*"' "$CONFIG"; then break; fi
    kill -0 "$join_pid" 2>/dev/null || break
    sleep 5
  done
  kill "$join_pid" 2>/dev/null || true
  wait "$join_pid" 2>/dev/null || true
  if ! [ -r "$CONFIG" ] || ! grep -q '"enrolledNodeId"[[:space:]]*:[[:space:]]*"' "$CONFIG"; then
    die "enrollment failed. The usual cause is an expired join code (10-minute TTL) —
  mint a fresh one and re-run. Nothing was installed as a service."
  fi
  say "enrolled as $(sed -n 's/.*"enrolledNodeId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONFIG" | head -1)"
fi

# ---- service ----------------------------------------------------------------
say "installing the launchd/systemd service"
./swarmlet-node install || die "service install failed (enrollment is intact; re-run this script)"

cat <<EOF

$(say "done")
Next steps:
  1. Open the node UI:  http://127.0.0.1:47800
     Resources -> enable the roles this box should take (worker / coordinator / replica)
     and set the offer. A 32 GB machine should offer roughly 20 GB of GPU memory.
  2. To hold layers for a model, its GGUF must exist in this node's models directory
     (default ~/.swarmlet/models). The control routes by model name, not by path.
  3. Confirm here, from the control machine:
       curl -s <control>/api/nodes -H "Authorization: Bearer <admin token>"

Agent dir: $AGENT_DIR   (re-run this script to upgrade; the service keeps running)
Logs:      look for the swarmlet-node service in your user logs
EOF
