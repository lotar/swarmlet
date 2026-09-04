#!/usr/bin/env bash
# rig.sh — control script for the swarmlet-rig 6-node emulation cluster.
#
# Subcommands:
#   build          rsync llama.cpp source into build context, docker
#                  build both images (swarmlet-rig-node,
#                  swarmlet-rig-delay)
#   up N [--profile small|q4]
#                  start node1..nodeN + delay1..delayN (docker compose
#                  up -d). Profile defaults to "small" if omitted.
#   down           stop and remove all rig containers (node + delay,
#                  any profile)
#   status         container state, memory usage, per-node tc qdisc
#                  (netem, off by default now), delay sidecar config
#                  line, TCP port check
#   ping           docker exec node1 ping -c 3 node2 (shows applied
#                  netem delay, if any — 0 by default in the symmetric
#                  profile; use delay-rtt for the real path)
#   delay-rtt      TCP round-trip through a delayN sidecar (host ->
#                  delayN -> nodeN -> delayN -> host), the actual
#                  symmetric-delay path this rig now emulates
#   baseline       run the standard 6-node driver benchmark against
#                  whatever nodes are already up (does NOT start/stop
#                  containers — run `up N` first); starts a driver,
#                  waits for health, runs P1/P2 + a 32-token
#                  prompt-eval measurement, records per-node memory,
#                  kills the driver, writes JSON to
#                  results/<timestamp>.json. Override the driver
#                  binary and extra env with DRIVER_BIN and
#                  DRIVER_ENV, e.g.:
#                    DRIVER_ENV="GGML_RPC_PIPELINE=1 GGML_SCHED_PIPELINED_COPY=1" ./rig.sh baseline
#   colima-up      start the separate `rig` colima profile (28 GB VM)
#                  for real q4-slab runs and switch the docker context
#                  to it. NEVER run this alongside the production LLM
#                  server (port 8099) — see docs/RIG_EMULATION.md. Not
#                  run automatically by anything in this script; the
#                  orchestrator runs it inside an approved production
#                  window.
#   colima-down    switch the docker context back to whatever it was
#                  before colima-up, then stop the `rig` colima
#                  profile.
#   image-transfer copy both rig images from the Docker Desktop context
#                  into the colima-rig context (colima has its own
#                  separate image store — a plain `docker build` while
#                  on the colima context also works instead, but
#                  image-transfer avoids rebuilding on first switch).
#
# All paths are relative to this script's directory so it can be run
# from anywhere.
set -euo pipefail

RIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${RIG_DIR}"

SRC_UPSTREAM="/tmp/llama-upstream-lab"
SRC_LOCAL="${RIG_DIR}/llama-src"
NODE_IMAGE="swarmlet-rig-node"
DELAY_IMAGE="swarmlet-rig-delay"
COMPOSE_FILE="${RIG_DIR}/docker-compose.yml"
RESULTS_DIR="${RIG_DIR}/results"

COLIMA_PROFILE="rig"
COLIMA_CONTEXT="colima-${COLIMA_PROFILE}"
CONTEXT_MARKER="${RIG_DIR}/.prev-docker-context"

DRIVER_BIN="${DRIVER_BIN:-/tmp/llama-upstream-lab-build/bin/llama-server}"
DRIVER_ENV="${DRIVER_ENV:-}"
DRIVER_PORT="${DRIVER_PORT:-8098}"
DRIVER_MODEL="${DRIVER_MODEL:-/Users/lotar/projects/local-llm/models/qwen3.5-draft/Qwen3.5-2B-Q8_0.gguf}"

usage() {
    echo "usage: $0 {build|up N [--profile small|q4]|down|status|ping|delay-rtt|baseline|colima-up|colima-down|image-transfer}"
    exit 1
}

# compose() — always pass --profile so profile-gated services
# (node/delay, currently gated to ["small","q4"], i.e. all of them) are
# visible. Defaults to "small" when RIG_PROFILE isn't set by the
# caller.
compose() {
    docker compose -f "${COMPOSE_FILE}" --profile "${RIG_PROFILE:-small}" "$@"
}

# compose_all() — cleanup operations (down) that must see every rig
# container regardless of which profile started it. VERIFIED (not
# assumed): `docker compose down` with NO --profile flag silently
# tears down nothing when every service carries `profiles:` — it
# respects the profile filter same as `up`/`ps`, contradicting the
# usual "down matches by project label" mental model. Since every
# node/delay service here is tagged profiles: ["small", "q4"], passing
# EITHER name as --profile selects the full 12-service set, so this
# always cleans up everything regardless of which profile started it.
compose_all() {
    docker compose -f "${COMPOSE_FILE}" --profile small "$@"
}

cmd_build() {
    echo "[rig] rsyncing ${SRC_UPSTREAM} -> ${SRC_LOCAL} (excluding build*, .git, models, *.gguf)"
    mkdir -p "${SRC_LOCAL}"
    # NOTE: excludes are anchored to the source root (leading '/') so they
    # only match top-level build output dirs/scripts — an unanchored
    # 'build*' would also match common/build-info.cpp.in and
    # cmake/build-info.cmake anywhere in the tree, which are real tracked
    # source files required by the CMake configure step, not build output.
    rsync -a --delete \
        --exclude '/build*' \
        --exclude '/.git' \
        --exclude '/models' \
        --exclude '*.gguf' \
        "${SRC_UPSTREAM}/" "${SRC_LOCAL}/"

    echo "[rig] docker build --platform linux/arm64 -t ${NODE_IMAGE} ."
    time docker build --platform linux/arm64 -t "${NODE_IMAGE}" "${RIG_DIR}"

    echo "[rig] docker build --platform linux/arm64 -f Dockerfile.delay -t ${DELAY_IMAGE} ."
    time docker build --platform linux/arm64 -f "${RIG_DIR}/Dockerfile.delay" -t "${DELAY_IMAGE}" "${RIG_DIR}"

    echo "[rig] image sizes:"
    docker images "${NODE_IMAGE}" --format '{{.Repository}}:{{.Tag}}  {{.Size}}'
    docker images "${DELAY_IMAGE}" --format '{{.Repository}}:{{.Tag}}  {{.Size}}'
}

# q4_peers_for NODE_IDX (1-based) — same-container peer list as the
# compose defaults, plus the two external Legion peers at indexes 6
# and 7. Used to set PEERS_<N> before calling compose so the q4
# profile's nodes see the Legion addresses that aren't expressible as
# a single ${VAR:-default} in the YAML (Compose variable substitution
# can't branch on which profile is active).
q4_peers_for() {
    local self="$1" n peers=""
    for n in 1 2 3 4 5 6; do
        [ "${n}" = "${self}" ] && continue
        peers="${peers}$((n - 1))=delay${n}:50053 "
    done
    peers="${peers}6=host.docker.internal:52251 7=host.docker.internal:52252"
    echo "${peers}"
}

# parse_profile_flag — strips a "--profile small|q4" pair out of "$@"
# and sets the global RIG_PROFILE (default "small"). Remaining args are
# left in the global array REMAINING_ARGS. NOT run inside $(...) —
# a command substitution forks a subshell, and RIG_PROFILE set there
# would never reach the caller; callers instead call this directly
# (`parse_profile_flag "$@"`) and then read RIG_PROFILE /
# REMAINING_ARGS from their own shell.
parse_profile_flag() {
    RIG_PROFILE="small"
    REMAINING_ARGS=()
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --profile)
                shift
                RIG_PROFILE="${1:-small}"
                if [ "${RIG_PROFILE}" != "small" ] && [ "${RIG_PROFILE}" != "q4" ]; then
                    echo "[rig] --profile must be 'small' or 'q4', got '${RIG_PROFILE}'" >&2
                    exit 1
                fi
                ;;
            *)
                REMAINING_ARGS+=("$1")
                ;;
        esac
        shift
    done
}

cmd_up() {
    local n
    parse_profile_flag "$@"
    n="${REMAINING_ARGS[0]:-}"
    export RIG_PROFILE
    if [ -z "${n}" ] || ! [[ "${n}" =~ ^[1-6]$ ]]; then
        echo "usage: $0 up N [--profile small|q4]   (N is 1-6)"
        exit 1
    fi

    if [ "${RIG_PROFILE}" = "q4" ]; then
        echo "[rig] profile=q4: wiring Legion peers (6=host.docker.internal:52251, 7=host.docker.internal:52252) into PEERS_1..6"
        for i in 1 2 3 4 5 6; do
            export "PEERS_${i}=$(q4_peers_for "${i}")"
        done
        echo "[rig] q4 profile needs the 'rig' colima context (28 GB VM) for real 35B Q4_K_M slabs — this script does NOT switch context for you; run colima-up first if you haven't. Current docker context: $(docker context show 2>/dev/null || echo unknown)"
    fi

    local services=""
    local i
    for i in $(seq 1 "${n}"); do
        services="${services} node${i} delay${i}"
    done
    echo "[rig] profile=${RIG_PROFILE}, starting:${services}"
    # shellcheck disable=SC2086
    compose up -d ${services}
}

cmd_down() {
    echo "[rig] stopping and removing all rig containers (node + delay, any profile)"
    compose_all down
}

cmd_status() {
    parse_profile_flag "$@"
    export RIG_PROFILE

    echo "=== container state ==="
    compose ps

    echo ""
    echo "=== memory (docker stats --no-stream) ==="
    local running
    running="$(compose ps --services --filter status=running 2>/dev/null || true)"
    if [ -z "${running}" ]; then
        echo "(no rig containers running)"
    else
        # shellcheck disable=SC2086
        docker stats --no-stream ${running}
    fi

    echo ""
    echo "=== tc qdisc per node (netem — off by default in the symmetric profile) ==="
    for svc in ${running}; do
        case "${svc}" in
            node*)
                echo "--- ${svc} ---"
                docker exec "${svc}" tc qdisc show dev eth0 2>&1 || echo "(exec failed)"
                ;;
        esac
    done

    echo ""
    echo "=== delay sidecar config ==="
    for svc in ${running}; do
        case "${svc}" in
            delay*)
                echo "--- ${svc} ---"
                docker logs "${svc}" 2>&1 | grep '^delay-line' || echo "(no delay-line startup line found in logs)"
                ;;
        esac
    done

    echo ""
    echo "=== TCP port check (delayN publishes the host port now) ==="
    for svc in ${running}; do
        case "${svc}" in
            delay*)
                local port
                port="$(compose port "${svc}" 50052 2>/dev/null | cut -d: -f2 || true)"
                if [ -z "${port}" ]; then
                    echo "${svc}: no published port found"
                    continue
                fi
                if nc -z -w2 127.0.0.1 "${port}" 2>/dev/null; then
                    echo "${svc}: 127.0.0.1:${port} accepts connections"
                else
                    echo "${svc}: 127.0.0.1:${port} NOT accepting connections"
                fi
                ;;
        esac
    done
}

cmd_ping() {
    echo "[rig] docker exec node1 ping -c 3 node2 (direct container-to-container, NOT through delay sidecars — netem is off by default in the symmetric profile, see delay-rtt for the real shaped path)"
    docker exec node1 ping -c 3 node2
}

cmd_delay_rtt() {
    parse_profile_flag "$@"
    export RIG_PROFILE
    local port
    port="$(compose port delay1 50052 2>/dev/null | cut -d: -f2 || true)"
    if [ -z "${port}" ]; then
        echo "[rig] delay1 not up or no published port found — run '$0 up N' first"
        exit 1
    fi
    echo "[rig] TCP round trip through delay1 (host -> delay1:${port} -> node1:50052), 3 tries:"
    for _ in 1 2 3; do
        python3 -c "
import socket, time
t0 = time.monotonic()
try:
    s = socket.create_connection(('127.0.0.1', ${port}), timeout=5)
    s.close()
    t1 = time.monotonic()
    print(f'connect+close round trip: {(t1-t0)*1000:.1f} ms')
except Exception as e:
    print(f'failed: {e}')
"
    done
}

cmd_baseline() {
    parse_profile_flag "$@"
    export RIG_PROFILE

    local running running_n rpc_args device_args split_args port_list port i node_count
    running="$(compose ps --services --filter status=running 2>/dev/null | grep '^node' | sort -V || true)"
    if [ -z "${running}" ]; then
        echo "[rig] no rig node containers running — run '$0 up N' first"
        exit 1
    fi
    running_n="$(echo "${running}" | wc -l | tr -d ' ')"
    echo "[rig] baseline against ${running_n} running node(s): $(echo "${running}" | tr '\n' ' ')"

    # Build --rpc / --device / --tensor-split for exactly the nodes that
    # are up, from their delay sidecar's published host port (traffic
    # now flows host -> delayN -> nodeN, not directly to nodeN — not
    # hardcoded to 6, so this also works for a 2-node smoke run).
    rpc_args=""
    device_args=""
    split_args=""
    port_list=""
    i=0
    for svc in ${running}; do
        node_count="${svc#node}"
        port="$(compose port "delay${node_count}" 50052 2>/dev/null | cut -d: -f2 || true)"
        if [ -z "${port}" ]; then
            echo "[rig] delay${node_count}: no published port found, aborting"
            exit 1
        fi
        port_list="${port_list} ${port}"
        [ -n "${rpc_args}" ] && rpc_args="${rpc_args},"
        rpc_args="${rpc_args}127.0.0.1:${port}"
        [ -n "${device_args}" ] && device_args="${device_args},"
        device_args="${device_args}RPC${i}"
        [ -n "${split_args}" ] && split_args="${split_args},"
        split_args="${split_args}3"
        i=$((i + 1))
    done
    device_args="${device_args},MTL0"
    split_args="${split_args},6"

    mkdir -p "${RESULTS_DIR}"
    local ts log_file driver_pid
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    log_file="${RESULTS_DIR}/${ts}.driver.log"

    echo "[rig] starting driver: ${DRIVER_BIN} (port ${DRIVER_PORT}, env: ${DRIVER_ENV:-none})"
    echo "[rig]   --rpc ${rpc_args} --device ${device_args} --tensor-split ${split_args}"
    # shellcheck disable=SC2086
    env ${DRIVER_ENV} "${DRIVER_BIN}" \
        -m "${DRIVER_MODEL}" \
        --host 127.0.0.1 --port "${DRIVER_PORT}" \
        --rpc "${rpc_args}" \
        --device "${device_args}" \
        --tensor-split "${split_args}" \
        -ngl 999 -c 2048 --parallel 1 --cache-ram 0 --ctx-checkpoints 0 -fa on --temp 0 -t 4 \
        > "${log_file}" 2>&1 &
    driver_pid=$!
    echo "[rig] driver pid ${driver_pid}, log ${log_file}"

    # Ensure the driver is always killed, even on error/interrupt.
    trap 'kill "${driver_pid}" 2>/dev/null || true' EXIT

    echo "[rig] waiting for http://127.0.0.1:${DRIVER_PORT}/health"
    local waited=0
    until curl -sf "http://127.0.0.1:${DRIVER_PORT}/health" 2>/dev/null | grep -q '"status":"ok"'; do
        if ! kill -0 "${driver_pid}" 2>/dev/null; then
            echo "[rig] driver process died before becoming healthy, see ${log_file}"
            exit 1
        fi
        sleep 5
        waited=$((waited + 5))
        if [ "${waited}" -ge 300 ]; then
            echo "[rig] driver did not become healthy within 300s, see ${log_file}"
            exit 1
        fi
    done
    echo "[rig] driver healthy after ~${waited}s"

    # Write every raw response to its own file rather than interpolating
    # JSON into Python source via bash variables — generated content can
    # contain quotes/backslashes that would break a naive embed.
    local p1_file p2_file tok_file tok32_file mem_file result_file tok_id
    p1_file="${RESULTS_DIR}/${ts}.p1.json"
    p2_file="${RESULTS_DIR}/${ts}.p2.json"
    tok_file="${RESULTS_DIR}/${ts}.tok.json"
    tok32_file="${RESULTS_DIR}/${ts}.tok32.json"
    mem_file="${RESULTS_DIR}/${ts}.mem.json"
    result_file="${RESULTS_DIR}/${ts}.json"

    curl -sS -X POST "http://127.0.0.1:${DRIVER_PORT}/completion" \
        -H "Content-Type: application/json" \
        -d '{"prompt": "Write a Python binary search function and one test.", "n_predict": 48, "temperature": 0, "top_k": 1, "cache_prompt": false, "ignore_eos": true}' \
        -o "${p1_file}"
    curl -sS -X POST "http://127.0.0.1:${DRIVER_PORT}/completion" \
        -H "Content-Type: application/json" \
        -d '{"prompt": "Explain speculative decoding in four sentences.", "n_predict": 48, "temperature": 0, "top_k": 1, "cache_prompt": false, "ignore_eos": true}' \
        -o "${p2_file}"

    # 32-token prompt-eval-only measurement: tokenize " the", replicate its
    # id 32x, send as a raw token-id prompt with n_predict=1 so timings.prompt_ms
    # is (near enough) pure prompt-eval cost, run once the driver is already
    # warm from P1/P2 above.
    curl -sS -X POST "http://127.0.0.1:${DRIVER_PORT}/tokenize" \
        -H "Content-Type: application/json" \
        -d '{"content": " the"}' -o "${tok_file}"
    tok_id="$(python3 -c "import json; print(json.load(open('${tok_file}'))['tokens'][0])")"
    python3 -c "
import json
prompt = [${tok_id}] * 32
print(json.dumps({'prompt': prompt, 'n_predict': 1, 'temperature': 0, 'top_k': 1, 'cache_prompt': False, 'ignore_eos': True}))
" > "${tok32_file}.req"
    curl -sS -X POST "http://127.0.0.1:${DRIVER_PORT}/completion" \
        -H "Content-Type: application/json" \
        -d @"${tok32_file}.req" -o "${tok32_file}"

    # shellcheck disable=SC2086
    docker stats --no-stream --format '{{json .}}' ${running} \
        | python3 -c 'import json,sys; print(json.dumps([json.loads(l) for l in sys.stdin if l.strip()]))' \
        > "${mem_file}"

    python3 -c "
import json
p1 = json.load(open('${p1_file}'))
p2 = json.load(open('${p2_file}'))
tok32 = json.load(open('${tok32_file}'))
mem = json.load(open('${mem_file}'))
out = {
    'timestamp_utc': '${ts}',
    'driver_bin': '${DRIVER_BIN}',
    'driver_env': '${DRIVER_ENV}',
    'profile': '${RIG_PROFILE}',
    'nodes': '${running_n}',
    'rpc': '${rpc_args}',
    'device': '${device_args}',
    'tensor_split': '${split_args}',
    'p1': {
        'content': p1.get('content'),
        'predicted_per_token_ms': p1.get('timings', {}).get('predicted_per_token_ms'),
        'prompt_ms': p1.get('timings', {}).get('prompt_ms'),
    },
    'p2': {
        'content': p2.get('content'),
        'predicted_per_token_ms': p2.get('timings', {}).get('predicted_per_token_ms'),
        'prompt_ms': p2.get('timings', {}).get('prompt_ms'),
    },
    'prompt_eval_32tok': {
        'prompt_ms': tok32.get('timings', {}).get('prompt_ms'),
        'prompt_per_token_ms': tok32.get('timings', {}).get('prompt_per_token_ms'),
    },
    'container_memory': mem,
}
with open('${result_file}', 'w') as f:
    json.dump(out, f, indent=2)
print(json.dumps(out, indent=2))
"
    rm -f "${p1_file}" "${p2_file}" "${tok_file}" "${tok32_file}" "${tok32_file}.req" "${mem_file}"
    echo "[rig] wrote ${result_file}"

    kill "${driver_pid}" 2>/dev/null || true
    trap - EXIT
    echo "[rig] driver stopped"
}

# --- colima scripts -------------------------------------------------
#
# MEMORY RULE: a `rig` colima profile VM (28 GB) sized for real q4-slab
# node memory must NEVER run alongside the production LLM server (port
# 8099) — both would compete for the same physical RAM and risk
# swapping or OOM on either side. This script does not enforce that
# (it has no visibility into whether a production window is open) —
# the orchestrator is responsible for only calling colima-up inside an
# approved production-stopped window, and calling colima-down before
# production resumes. Neither colima-up nor colima-down is called by
# any other rig.sh subcommand.

cmd_colima_up() {
    echo "[rig] MEMORY RULE: the 'rig' colima profile (28 GB VM) must never run alongside the production LLM server (port 8099). Confirm production is stopped before calling this — this script does not check for you."
    local prev
    prev="$(docker context show 2>/dev/null || echo default)"
    echo "${prev}" > "${CONTEXT_MARKER}"
    echo "[rig] saved current docker context '${prev}' to ${CONTEXT_MARKER} for colima-down to restore"

    echo "[rig] colima start --profile ${COLIMA_PROFILE} --cpu 12 --memory 28 --disk 60 --vm-type vz --mount-type virtiofs"
    colima start --profile "${COLIMA_PROFILE}" --cpu 12 --memory 28 --disk 60 --vm-type vz --mount-type virtiofs

    echo "[rig] docker context use ${COLIMA_CONTEXT}"
    docker context use "${COLIMA_CONTEXT}"
}

cmd_colima_down() {
    local prev="default"
    if [ -f "${CONTEXT_MARKER}" ]; then
        prev="$(cat "${CONTEXT_MARKER}")"
    else
        echo "[rig] no ${CONTEXT_MARKER} found (colima-up wasn't run by this script, or the marker was removed) — restoring to 'default'"
    fi
    echo "[rig] docker context use ${prev}"
    docker context use "${prev}"
    rm -f "${CONTEXT_MARKER}"

    echo "[rig] colima stop --profile ${COLIMA_PROFILE}"
    colima stop --profile "${COLIMA_PROFILE}"
}

cmd_image_transfer() {
    local desktop_ctx all_ctx
    all_ctx="$(docker context ls --format '{{.Name}}' 2>/dev/null || true)"
    # Prefer desktop-linux (Docker Desktop's real context name, and
    # what this Mac is actually on) over default — checked in that
    # priority order rather than however `docker context ls` happens
    # to list them, since list order isn't guaranteed stable/alphabetical.
    if echo "${all_ctx}" | grep -qx 'desktop-linux'; then
        desktop_ctx="desktop-linux"
    elif echo "${all_ctx}" | grep -qx 'default'; then
        desktop_ctx="default"
    else
        desktop_ctx=""
    fi
    if [ -z "${desktop_ctx}" ]; then
        echo "[rig] could not find a desktop-linux or default docker context to source images from" >&2
        exit 1
    fi
    echo "[rig] docker --context ${desktop_ctx} save ${NODE_IMAGE} ${DELAY_IMAGE} | docker --context ${COLIMA_CONTEXT} load"
    docker --context "${desktop_ctx}" save "${NODE_IMAGE}" "${DELAY_IMAGE}" \
        | docker --context "${COLIMA_CONTEXT}" load
}

case "${1:-}" in
    build)           cmd_build ;;
    up)               shift; cmd_up "$@" ;;
    down)             cmd_down ;;
    status)           shift; cmd_status "$@" ;;
    ping)             cmd_ping ;;
    delay-rtt)        shift; cmd_delay_rtt "$@" ;;
    baseline)         shift; cmd_baseline "$@" ;;
    colima-up)        cmd_colima_up ;;
    colima-down)      cmd_colima_down ;;
    image-transfer)   cmd_image_transfer ;;
    *)                usage ;;
esac
