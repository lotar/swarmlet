#!/bin/bash
# Put the Legions' control channels on the public internet: pin the control tunnel hostname in each
# Legion's /etc/hosts (the LAN router's resolver drops A records for fresh trycloudflare names), then
# re-enroll them through the tunnel so their agent channel (and every relayed RPC byte) crosses the
# Cloudflare edge. The M5 keeps its LAN channel (it hosts control).
#   usage: LEGION_PW_FILE=<file with the sudo password> e2e/rig-internet.sh [legion1-ip] [legion2-ip]
set -Eeuo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
H1=${1:-192.168.1.243}; H2=${2:-192.168.1.220}
PW=${LEGION_PW_FILE:?LEGION_PW_FILE required}
U=$("$HERE/control/cloudflare-tunnel.sh" url); [ -n "$U" ] || { echo "no tunnel running (control/cloudflare-tunnel.sh start)"; exit 2; }
HOST=${U#https://}
EDGE=$(dig +short A "$HOST" @1.1.1.1 | head -1); [ -n "$EDGE" ] || { echo "cannot resolve $HOST via 1.1.1.1"; exit 3; }
TOKEN=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["adminToken"])' "$HOME/.swarmlet/control/control.json")
C=http://127.0.0.1:47900
echo "tunnel $U -> edge $EDGE"
for h in $H1 $H2; do
  echo "== $h"
  ssh -o BatchMode=yes lotar@$h "sudo -S -p '' bash -c 'grep -v swarmlet-tunnel /etc/hosts > /tmp/hosts.new; echo \"$EDGE $HOST # swarmlet-tunnel\" >> /tmp/hosts.new; cat /tmp/hosts.new > /etc/hosts' < /dev/stdin && getent hosts $HOST | head -1" < "$PW"
  CODE=$(curl -sf -H "Authorization: Bearer $TOKEN" -X POST "$C/api/join-codes" | python3 -c 'import json,sys;print(json.load(sys.stdin)["code"])')
  ssh -o BatchMode=yes lotar@$h "for i in \$(seq 1 10); do out=\$(/home/lotar/swarmlet/swarmlet-node join $U $CODE 2>&1) && break; sleep 3; done; echo \"\$out\" | tail -1; sleep 5; curl -s http://127.0.0.1:47800/api/status | python3 -c 'import json,sys;d=json.load(sys.stdin);print(\"connected\",d[\"connected\"],\"via\",d[\"controlUrl\"])'"
done
sleep 6
curl -s -H "Authorization: Bearer $TOKEN" "$C/api/nodes" | python3 -c '
import json,sys
for n in json.load(sys.stdin)["nodes"]:
    net=(n.get("caps") or {}).get("net") or {}
    print("  ", n["hostname"], "online", n["online"], "rtt", net.get("rttMs"), "ms up", net.get("upMbit"), "down", net.get("downMbit"), "Mbit")'
