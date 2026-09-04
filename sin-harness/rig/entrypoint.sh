#!/usr/bin/env bash
# Entrypoint for swarmlet-rig-node containers.
#
# 1. If NETEM_DELAY_MS is set and > 0, apply a netem qdisc to eth0 to
#    emulate an internet leg. Requires the container to run with
#    cap_add: [NET_ADMIN] (set in compose).
#
#    NETEM_DELAY_MS is the intended ONE-WAY delay of the emulated leg.
#    A Linux `tc qdisc ... root netem` on eth0 only shapes EGRESS
#    (container -> host) traffic; packets arriving at the container are
#    not delayed. Docker Desktop's LinuxKit VM kernel does not have the
#    ifb module available (no modprobe binary in the container, and
#    `ip link add ifb0 type ifb` fails with "Unknown device type"), so
#    the standard ingress-redirect-to-ifb trick for symmetric shaping
#    does not work here — confirmed by testing it directly. Also,
#    a bare `tc qdisc ... ingress` cannot take a `netem` discipline at
#    all (it only classifies/polices, so `netem` there errors with
#    "What is netem?").
#
#    Workaround: apply 2*NETEM_DELAY_MS to the one shapeable direction
#    (egress). A full round trip through the container (request in,
#    reply out) then costs delay only on the reply leg, but at 2*D, so
#    the round-trip total matches a real symmetric leg where each
#    direction costs D. This is exact for a single blocking
#    request/reply; for a pipelined client with multiple requests in
#    flight, request-vs-reply ordering differs from the real symmetric
#    case but the per-hop round-trip total is still right.
#
#    Side effect: `ping` (ICMP echo/reply, one request + one reply,
#    same as the RPC case) through TWO such containers back-to-back
#    (e.g. node1 -> node2) shows about 4*D, not 2*D — each container's
#    egress leg costs 2*D, and there are two containers on the path.
#
#    NETEM_LOSS is applied on egress only (the reply leg), not on the
#    unshapeable ingress/request leg — i.e. loss is one-directional,
#    not the two-directional loss a real symmetric leg would have.
#    Documented here rather than compensated for, since there's no
#    ingress path to apply it to.
#
# 2. If PEERS is set, translate it into repeated `--peer` args (plus
#    `--peer-port` from PEER_PORT) so ggml-rpc-server can push its
#    output straight to the next node in the ring instead of only
#    replying to the driver. PEERS format: space-separated
#    "IDX=host:port" entries, e.g. "0=delay1:50053 1=delay2:50053".
#    These flags are being added to ggml-rpc-server by another agent
#    concurrently with this rig work — until the image is rebuilt
#    against a server binary that has them, this entrypoint detects
#    their absence via `--help` and starts WITHOUT them, printing which
#    mode it's in. This keeps the rig runnable today and automatically
#    picks up peer support the moment `rig.sh build` picks up a newer
#    llama-src with the flag, no entrypoint change needed.
#
# 3. Exec ggml-rpc-server in the foreground so it becomes PID 1's
#    replacement (signals from `docker stop` reach it directly).
set -euo pipefail

ONE_WAY_DELAY_MS="${NETEM_DELAY_MS:-0}"
JITTER_MS="${NETEM_JITTER_MS:-0}"
LOSS_PCT="${NETEM_LOSS:-0}"
IFACE="${NETEM_IFACE:-eth0}"

if [ "${ONE_WAY_DELAY_MS}" -gt 0 ] 2>/dev/null; then
    EGRESS_DELAY_MS=$((ONE_WAY_DELAY_MS * 2))
    echo "[entrypoint] netem is egress-only on this kernel (no ifb) — applying 2x one-way delay to egress on ${IFACE} so round-trip total = 2*${ONE_WAY_DELAY_MS}ms: delay ${EGRESS_DELAY_MS}ms jitter ${JITTER_MS}ms loss ${LOSS_PCT}% (loss is egress/one-direction only)"
    tc qdisc replace dev "${IFACE}" root netem \
        delay "${EGRESS_DELAY_MS}ms" "${JITTER_MS}ms" \
        loss "${LOSS_PCT}%"
else
    echo "[entrypoint] NETEM_DELAY_MS not set or 0 — no netem applied on ${IFACE}"
fi

THREADS="${THREADS:-3}"
PEER_PORT="${PEER_PORT:-50053}"

PEER_ARGS=()
if [ -n "${PEERS:-}" ]; then
    if ggml-rpc-server --help 2>&1 | grep -q -- '--peer\b'; then
        for entry in ${PEERS}; do
            PEER_ARGS+=(--peer "${entry}")
        done
        PEER_ARGS+=(--peer-port "${PEER_PORT}")
        echo "[entrypoint] peer-forwarding mode: server supports --peer, wiring ${#PEER_ARGS[@]} peer arg(s) from PEERS=\"${PEERS}\" peer-port=${PEER_PORT}"
    else
        echo "[entrypoint] compat mode: PEERS=\"${PEERS}\" set but this ggml-rpc-server build has no --peer flag yet — starting WITHOUT peer forwarding (client-RPC-only, same as before). Rebuild the image once llama-src picks up --peer support to enable it."
    fi
fi

echo "[entrypoint] starting ggml-rpc-server on 0.0.0.0:50052 (threads=${THREADS}, cache dir=${LLAMA_CACHE:-unset})"
exec ggml-rpc-server -H 0.0.0.0 -p 50052 -d CPU -t "${THREADS}" -c "${PEER_ARGS[@]}"
