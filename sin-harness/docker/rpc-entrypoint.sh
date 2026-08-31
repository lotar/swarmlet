#!/bin/sh
# rpc-server entrypoint: optionally apply netem (internet simulation) to eth0,
# then exec the server. NETEM_DELAY_MS adds RTT; NETEM_RATE_MBIT caps bandwidth.
set -e

if [ "${NETEM_DELAY_MS:-0}" != "0" ] || [ "${NETEM_RATE_MBIT:-0}" != "0" ]; then
  DELAY_US=$((NETEM_DELAY_MS * 1000))
  # netem queue discipline on the container's only interface
  if [ "${NETEM_RATE_MBIT:-0}" != "0" ]; then
    tc qdisc add dev eth0 root handle 1: tbf \
      rate "${NETEM_RATE_MBIT}mbit" burst 2mb latency 400ms
    tc qdisc add dev eth0 parent 1: handle 2: netem delay "${DELAY_US}us"
  else
    tc qdisc add dev eth0 root netem delay "${DELAY_US}us"
  fi
  echo "[entrypoint] netem applied: delay=${NETEM_DELAY_MS}ms rate=${NETEM_RATE_MBIT:-off}Mbit"
fi

exec rpc-server --host 0.0.0.0 --port "${RPC_PORT}" ${RPC_EXTRA_ARGS:-}
