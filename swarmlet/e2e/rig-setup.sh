#!/bin/bash
# Put the node agent on the real rig: compile the Linux binary, ship it with the Linux engine dist
# to both Legions, install it as a user service, and enroll each with a fresh join code from the
# control plane running on this Mac. Idempotent; re-running re-ships and re-enrolls.
#   usage: CONTROL_URL=http://192.168.1.x:47900 ADMIN_TOKEN=... e2e/rig-setup.sh [legion1-ip] [legion2-ip]
set -Eeuo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
H1=${1:-192.168.1.243}; H2=${2:-192.168.1.220}
CONTROL_URL=${CONTROL_URL:?CONTROL_URL required (reachable from the Legions, e.g. http://192.168.1.10:47900)}
ADMIN_TOKEN=${ADMIN_TOKEN:?ADMIN_TOKEN required (see ~/.swarmlet/control/control.json)}
log(){ echo "[rig $(date -u +%H:%M:%S)] $*"; }

log "compiling linux agent"
( cd "$HERE" && bun run node-agent/build.ts linux )
test -x "$HERE/dist/agent/linux/swarmlet-node"
test -x "$HERE/engine/dist/linux/ggml-rpc-server" || { echo "missing engine/dist/linux (build it on a Legion with engine/build.sh linux and rsync back)"; exit 2; }

for h in $H1 $H2; do
  log "$h: shipping agent + engine"
  ssh -o BatchMode=yes lotar@$h 'mkdir -p /home/lotar/swarmlet/engine'
  rsync -a "$HERE/dist/agent/linux/swarmlet-node" lotar@$h:/home/lotar/swarmlet/swarmlet-node
  rsync -a "$HERE/engine/dist/linux/" lotar@$h:/home/lotar/swarmlet/engine/
  code=$(curl -sf -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$CONTROL_URL/api/join-codes" | python3 -c 'import json,sys;print(json.load(sys.stdin)["code"])')
  log "$h: installing service + joining with code $code"
  ssh -o BatchMode=yes lotar@$h "set -e
    export SWARMLET_ENGINE=/home/lotar/swarmlet/engine
    /home/lotar/swarmlet/swarmlet-node install
    sleep 3
    /home/lotar/swarmlet/swarmlet-node join '$CONTROL_URL' '$code'
    systemctl --user is-active swarmlet-node.service
    /home/lotar/swarmlet/swarmlet-node status | head -20"
done
log "done; set each node's offer in http://<legion>:47800 (ssh -L 47800:127.0.0.1:47800 lotar@<legion>) or with: swarmlet-node offer set enabled=true roles.worker=true gpu.cuda:0=3600 ramMiB=8192 cpuCores=10"
