# Rig Emulation: Docker-Based Multi-Node Inference Testing

Docker containers standing in for remote 16 GB inference nodes, for testing
a distributed-inference ring (llama.cpp ggml RPC) at 6-8 node scale on one
Mac, without needing physical remote hardware for every iteration.

Source: `sin-harness/rig/` (Dockerfile, Dockerfile.delay, entrypoint.sh,
delay-proxy.py, docker-compose.yml, rig.sh, results/ — git-ignored run
outputs). Images: `swarmlet-rig-node`, `swarmlet-rig-delay`. `rig.sh`
subcommands: `build`, `up N [--profile small|q4]`, `down`, `status`,
`ping`, `delay-rtt`, `baseline` (see "6-node baseline" below),
`colima-up`, `colima-down`, `image-transfer` (see "Symmetric one-way
delay" below for the last four and the delay sidecars).

## What it emulates

- **Topology.** Each container runs `ggml-rpc-server` (CPU backend) on
  port 50052, published to the Mac host on 50061-50066 (node1-node6). A
  native `llama-server --rpc <host:port>,...` driver on the Mac connects
  to whichever subset is up and treats each container as one remote ggml
  device, the same way it would treat a real remote node over the
  network.
- **Latency, jitter, loss (round-trip symmetric, egress-only kernel
  path).** `entrypoint.sh` applies a Linux `tc qdisc netem` rule to the
  container's `eth0` on boot. `NETEM_DELAY_MS` is the **intended
  one-way delay** of the emulated leg — but a `tc qdisc ... root netem`
  on a Linux interface only shapes **egress** (container -> host)
  traffic; packets *arriving* at the container are not delayed by it.
  Docker Desktop's LinuxKit VM kernel does not have the `ifb` module
  available for the usual ingress-redirect-to-ifb symmetric-shaping
  trick — confirmed by testing it directly inside a rig container:
  `modprobe` doesn't exist in the container's userspace to load it, and
  `ip link add ifb0 type ifb` fails with "Unknown device type" even
  after adding a bare `tc qdisc ... ingress` handle. A bare ingress
  qdisc also can't take `netem` directly (`tc filter`/`ingress` only
  classify/police; `netem` there errors with "What is netem?").

  Workaround: the entrypoint applies **`2 * NETEM_DELAY_MS`** to the
  one shapeable direction (egress). A full round trip through a
  container (request in, undelayed; reply out, delayed at `2*D`) then
  costs `2*D` total, matching a real symmetric leg where each direction
  costs `D`. This is exact for a single blocking request/reply; for a
  pipelined client with several requests in flight, request-vs-reply
  ordering differs from the true symmetric case, but the per-hop
  round-trip total is still right. `NETEM_LOSS` is applied on egress
  only (the reply leg) — loss is one-directional in the rig, not the
  two-directional loss a real symmetric leg would have; this is
  documented rather than compensated for, since there's no ingress path
  to apply it to.

  Side effect: `rig.sh ping` (ICMP echo/reply, one request + one
  reply — same shape as one RPC round trip) between two containers
  shows about **`4*D`**, not `2*D`: each container's egress leg costs
  `2*D`, and the ping path crosses two containers' egress (node1's
  reply to node2's request, and node2's egress on its own reply back).

  This is the same physical mechanism used for the netem-emulated
  internet legs on the Legion boxes (see `wan-variant-matrix-results`
  in project memory) — a genuine kernel-level network shape, not a
  `sleep()` in application code — just applied 2x on the one direction
  the kernel here can actually shape.
- **Memory caps.** `mem_limit: 16g` per node in `docker-compose.yml`
  mirrors the target remote-node RAM budget, so a slab that doesn't fit
  in 16 GB in the container won't fit on the real hardware either.

## What it does not emulate

- **GPU compute.** Containers run CPU-only (`ggml-rpc-server -d CPU`) —
  there is no GPU passthrough into Docker Desktop's Linux VM on macOS.
  Per-node compute time measured in the rig is **pessimistic** relative
  to a real remote node with a GPU or Apple Silicon backend; only the
  network shape (latency/jitter/loss) and correctness (identical output
  tokens) are representative. Do not use rig ms/token numbers as a
  compute-time proxy for real hardware — use them only to isolate the
  network contribution.
- **Auth/security on the RPC protocol itself.** `ggml-rpc-server` prints
  its own warning about this on every boot; the rig doesn't change that.

## Memory budget per node

A 5-layer Q4_K_M slab of Qwen3.6-35B-A3B is approximately 3.5 GB. Six
nodes at that slab size need roughly 24 GB of container memory
concurrently. Docker Desktop's VM on this Mac is deliberately capped at
6 GB, so a full 6-node run with **real production-size slabs** does
**not fit** in the default Docker Desktop VM. See "Running a full
6-node window" below for the workaround.

A 6-node run with the small `Qwen3.5-2B-Q8_0` draft model **does** fit
in the default 6 GB VM — confirmed by actually running it (see "6-node
baseline" below): ~200-255 MB resident per node while a client is
connected, ~15-19 MB once it disconnects, well under the 6 GB VM total
across all 6 containers. Use the small model whenever the goal is to
exercise the 6-node network topology and RPC protocol, not to validate
a real production memory footprint.

## Running the smoke test (1-2 nodes, default Docker Desktop VM)

```bash
cd sin-harness/rig
./rig.sh build          # rsync source + docker build
./rig.sh up 2            # start node1, node2
./rig.sh status           # container state, memory, tc qdisc, port check
./rig.sh ping              # docker exec node1 ping -c 3 node2
# ... point a native llama-server --rpc 127.0.0.1:50061,127.0.0.1:50062 at it ...
./rig.sh down
```

To override netem delay for a run:

```bash
NETEM_DELAY_MS=20 docker compose up -d node1 node2
```

## Running a full 6-node window (separate VM, NOT the default Docker Desktop VM)

This has **not yet been run** — it's the documented next step once a
full 6-node test is actually needed. It requires a Docker VM sized for
the real memory budget above (~24 GB+), which is larger than Docker
Desktop's default 6 GB VM. Do not resize Docker Desktop's VM to get
there; use a separate colima profile instead so the change is scoped
and reversible:

```bash
brew install colima
colima start --profile rig --cpu 12 --memory 28 --disk 60 --arch aarch64
docker context use colima-rig
cd sin-harness/rig
./rig.sh build
./rig.sh up 6
```

**This must only run while the production LLM server (port 8099) is
stopped, and never alongside it.** A 6-node window at real slab sizes
will compete for the same physical RAM the production server needs;
running both at once risks swapping or OOM on either side. Switch back
with `docker context use desktop-linux` and `colima stop --profile rig`
when done.

## Smoke test results (2026-09-03)

Build: 6 GB Docker Desktop VM, `arm64`, image `swarmlet-rig-node`, 151 MB,
statically-linked binary (only system libs: libgomp, libstdc++, libm,
libgcc_s, libc — no libggml-*.so to manage). Cold docker build ~17s once
apt package layers are warm; full `rsync` + `docker build` well under a
minute on this run (the 5-15 minute planning estimate assumed a colder
apt cache than what this Mac had).

Two containers (node1, node2), Mac-side driver
(`/tmp/llama-upstream-lab-build/bin/llama-server`) with
`--rpc 127.0.0.1:50061,127.0.0.1:50062 --device RPC0,RPC1,MTL0
--tensor-split 6,6,12`, model `Qwen3.5-2B-Q8_0.gguf`.

| netem delay | P1 ms/token | P2 ms/token | P1 content | P2 content |
|---|---|---|---|---|
| 8 ms | 40.61 | 39.43 | identical to reference | identical to reference |
| 20 ms | 66.95 | 68.70 | identical to reference | identical to reference |

Reference: two local (non-containerized) `rpc-server` instances, same
prompts/settings, at
`.../scratchpad/e2e/out-baseline-065157/D0.json`.

Delta from the 12 ms netem bump: **+26.3 ms/token (P1)**, **+29.3
ms/token (P2)** at the time of this first run. **This measurement
predates the egress-only netem fix below** — with only one direction
shaped, the round trip was only paying the delay once per hop instead
of twice, so this delta undercounts the true network cost by roughly
half. See "netem fix" below for the corrected numbers.

`docker exec node1 ping -c 3 node2` at 8 ms netem, **before the fix**
(both directions through the veth pair, but only node2's reply leg
actually delayed):

```
64 bytes from node2.rig_default (172.25.0.3): icmp_seq=1 ttl=64 time=33.0 ms
64 bytes from node2.rig_default (172.25.0.3): icmp_seq=2 ttl=64 time=12.6 ms
64 bytes from node2.rig_default (172.25.0.3): icmp_seq=3 ttl=64 time=12.9 ms
rtt min/avg/max/mdev = 12.585/19.489/32.986/9.544 ms
```

Container memory at idle: ~1.5 MB. After model load (2B Q8, tensor-split
6,6,12): node1 ~441 MB, node2 ~373 MB — both far under the 16 GB
`mem_limit`, consistent with "~1 GB shipped to each container" for a
model this size.

One build issue found and fixed along the way: the original rsync
exclude list used an unanchored `build*` pattern, which matched
`common/build-info.cpp.in` and `cmake/build-info.cmake` — real tracked
source files needed by the CMake configure step, not build output — and
silently deleted them from the copied tree, breaking the first build
attempt. `rig.sh` now anchors excludes to the source root
(`/build*`, `/.git`, `/models`) so only top-level build-output
directories are skipped. A second issue (runtime image missing
`libgomp.so.1`, the OpenMP runtime `ggml-rpc-server` links against) was
fixed by adding `libgomp1` to the runtime stage's apt install.

## netem fix: egress-only delay, verified (2026-09-03)

After the smoke test above, a review caught that the measured latency
delta was about half what a symmetric one-way delay should produce —
the tell was `+12 ms` of `NETEM_DELAY_MS` producing only `+26-29 ms`
per token, i.e. roughly one delay per round trip per node, not two.
Root cause and fix are as described in "Latency, jitter, loss" above:
`tc qdisc ... root netem` shapes egress only, `ifb`-based ingress
shaping isn't available in this kernel (tested directly, see above),
so the entrypoint now applies `2*NETEM_DELAY_MS` to egress so a full
round trip costs `2*D` — matching a real symmetric leg.

Verified after the fix, two containers (node1, node2) at
`NETEM_DELAY_MS=8` (so egress = 16 ms):

```
qdisc netem 8008: root refcnt 7 limit 1000 delay 16ms  2ms loss 0.1%   # node1
qdisc netem 8009: root refcnt 7 limit 1000 delay 16ms  2ms loss 0.1%   # node2

$ docker exec node1 ping -c 4 node2
64 bytes from node2.rig_default: icmp_seq=1 ttl=64 time=67.5 ms
64 bytes from node2.rig_default: icmp_seq=2 ttl=64 time=35.8 ms
64 bytes from node2.rig_default: icmp_seq=3 ttl=64 time=40.0 ms
64 bytes from node2.rig_default: icmp_seq=4 ttl=64 time=36.5 ms
rtt min/avg/max/mdev = 35.757/44.958/67.500/13.114 ms
```

Steady-state ~36-40 ms is close to the predicted `4*D = 32 ms` (two
containers on the ping path, each paying `2*D` on its own egress leg),
with the gap attributable to jitter applied twice. Matches the expected
shape from the fix.

## 6-node baseline (2026-09-03)

`rig.sh up 6` (default profile: node1-4 at `NETEM_DELAY_MS=8` -> 16 ms
egress, node5-6 at `NETEM_DELAY_MS=20` -> 40 ms egress, confirmed via
`rig.sh status`), then `rig.sh baseline` with the default driver
(`/tmp/llama-upstream-lab-build/bin/llama-server`), same model
(`Qwen3.5-2B-Q8_0.gguf`) and flags as the smoke test, extended to 6 RPC
devices: `--rpc 127.0.0.1:50061,...,50066 --device
RPC0,RPC1,RPC2,RPC3,RPC4,RPC5,MTL0 --tensor-split 3,3,3,3,3,3,6`.

| prompt | ms/token | content vs. reference |
|---|---|---|
| P1 (binary search) | 223.78 | **not identical** — diverges at one token: "sorted **list**" (2-node reference) vs "sorted **array**" (6-node split), rest of both completions match |
| P2 (speculative decoding) | 216.99 | identical |

32-token prompt-eval-only (raw token-id prompt, `[id(" the")] * 32`,
`n_predict=1`, run once warm from P1/P2): **3286.5 ms total, 102.7
ms/token** for prompt eval across all 6 hops.

Content divergence on P1 is expected, not a bug: at `temperature=0,
top_k=1` decoding is greedy, but floating-point accumulation order
differs when the same weights are summed across 6 tensor-split shards
instead of 2 — close enough on one token's logits to flip the argmax.
The reference D0.json baseline was produced with a 2-node split; this
is not the same computation graph, just numerically very close.

Per-node container memory, captured live during the driver's warm run
(from `rig.sh baseline`'s own `docker stats` snapshot, i.e. **while
tensors are loaded and a client is connected**): node1 255 MB, node2
204 MB, node3 197 MB, node4 201 MB, node5 199 MB, node6 204 MB — all
comfortably under the 16 GB `mem_limit`, and in the same order of
magnitude as the ~300 MB/node estimate for a 24-layer/6-node split of
this model. **Once the driver disconnects, per-node RSS drops to
~15-19 MB** — `ggml-rpc-server` does not keep the tensor slab resident
without an active client, only caching it to disk via `-c`/`LLAMA_CACHE`
(confirmed via `rig.sh status` run a few minutes after the baseline,
post-driver-disconnect, still pre-`down`).

All 6 containers, the driver, and the results directory's intermediate
files were cleaned up afterward: `rig.sh down` plus the driver's own
`kill` (the `baseline` subcommand traps and kills the driver
unconditionally, even on error). Port 8099 (production) was confirmed
listening and untouched throughout both this run and the smoke test.

### `rig.sh baseline`

New subcommand: assumes nodes are already up (`rig.sh up N` first, does
not itself start/stop containers), starts a driver, waits for
`/health`, runs the two standard prompts plus the 32-token prompt-eval
probe, snapshots `docker stats` for the running nodes, kills the
driver, and writes one JSON file to `sin-harness/rig/results/<UTC
timestamp>.json` (git-ignored — these are run outputs, not source).

Override the driver binary or inject extra env for A/B runs:

```bash
DRIVER_BIN=/path/to/other/llama-server \
DRIVER_ENV="GGML_RPC_PIPELINE=1 GGML_SCHED_PIPELINED_COPY=1" \
  ./rig.sh baseline
```

`--rpc` / `--device` / `--tensor-split` are built from whatever nodes
are currently running (not hardcoded to 6), so the same subcommand also
works for a 2-node run.

## Symmetric one-way delay: `delayN` sidecars (2026-09-03)

Everything above shapes only the **egress** leg (see "netem fix"
above) — a full request/reply round trip pays the intended delay
twice on the reply, never once on the request. That's the right shape
for measuring a client calling a remote node, but the next thing this
rig needs to measure is **push forwarding between nodes** — a node
sending its own output straight to the next node in a ring, via a
`--peer` flag now landing in `ggml-rpc-server` — and that traffic's
gain is in the *request* (node -> node) direction. Egress-only netem
can't represent that: it would only charge the direction nothing is
being measured on.

Kernel ingress shaping isn't available in this environment (see the
`ifb`/ingress notes above, confirmed by testing directly) so the fix
is a **userspace delay-line proxy** in front of each node, shaping
both directions independently and identically instead of doubling one
direction. It is not a `sleep()` sprinkled into RPC code — it holds
the TCP bytes at the proxy layer, so it works for any protocol running
over the shaped ports without touching `ggml-rpc-server` itself.

### Topology

```
                     host:5006N
                         |
                     [ delayN ]  <- symmetric one-way DELAY_MS_N on BOTH ports
                     /         \
              :50052 (client)   :50053 (peer)
                    |                 |
                 [ nodeN ]  <-------- (nodeN's own peer-forwarding, once wired)
                    |
        node -> node pushes go OUT to other nodes' delayM:50053,
        never directly to nodeM — so a push pays the same one-way
        delay a client call does.
```

`delay-proxy.py` (`sin-harness/rig/delay-proxy.py`, image
`swarmlet-rig-delay`, `Dockerfile.delay`) is a small stdlib-only
asyncio TCP delay line: every byte chunk is delivered at
`arrival_time + DELAY_MS`, in order, without blocking later reads (a
chunk queued behind another chunk is delayed once, not stacked).
Extended in this pass from a single `LPORT TPORT DELAY_MS` pair to
`--delay-ms MS --target-host HOST LPORT:TPORT [LPORT:TPORT ...]` so
one proxy process fronts **both** a node's client port (50052) and its
peer port (50053) with the same one-way delay.

Each `delayN` sidecar:

- Publishes the node's host port itself now (`host:5006N ->
  delayN:50052 -> nodeN:50052`) — `nodeN` no longer publishes a host
  port at all.
- Also fronts the peer port (`delayN:50053 -> nodeN:50053`), not
  published to the host — reachable only from other nodes' peer
  pushes, via `delayM`.
- Applies `DELAY_MS_N` (default profile: 8/8/8/8/20/20, same shape as
  the old `NETEM_DELAY_MS` default) **symmetrically** — a full round
  trip through one `delayN` costs `2 * DELAY_MS_N`, matching a real
  symmetric leg directly, no doubling trick needed (unlike node
  netem's egress-only compensation).

Node netem (`NETEM_DELAY_MS`, the old egress-only mechanism) is still
wired in `entrypoint.sh` and still available for A/B comparison
against the old measurement approach, but now **defaults to 0 (off)**
— `rig.sh status` prints `qdisc noqueue` per node when off, confirmed
by an actual run (see below).

### Peer wiring: `PEERS` / `PEER_PORT`, and the compat shim

`entrypoint.sh` reads two new env vars:

- `PEERS` — space-separated `IDX=host:port` entries, e.g.
  `"0=delay1:50053 1=delay2:50053"`. `IDX` is the peer's position in
  the **client's `--rpc` device list** (0-based) — for the 6-node
  container ring, node N's own index is `N-1`, and its `PEERS` value
  lists every *other* node at its index, reached through that node's
  `delayM:50053` (never `nodeM` directly, so a push pays the same
  symmetric delay a client call does).
- `PEER_PORT` (default `50053`) — the port `ggml-rpc-server` listens
  on for inbound peer pushes.

These become repeated `--peer IDX=host:port ... --peer-port 50053`
arguments on the server command line. **`--peer`/`--peer-port` were
being added to `ggml-rpc-server` by another agent concurrently with
this work** — `entrypoint.sh` detects their presence at container
start via `ggml-rpc-server --help 2>&1 | grep -q -- '--peer\b'` and
prints which mode it's in:

```
[entrypoint] peer-forwarding mode: server supports --peer, wiring 12 peer arg(s) from PEERS="..." peer-port=50053
```
or, against an older binary:
```
[entrypoint] compat mode: PEERS="..." set but this ggml-rpc-server build has no --peer flag yet — starting WITHOUT peer forwarding ...
```

No entrypoint change was needed once the flag actually landed — a
`rig.sh build` that rsyncs a newer `llama-src` picks it up
automatically. Verified live during this pass: an initial `rig.sh
build` failed on an in-flight compile error in the concurrent
`--peer` work (`ggml-rpc.cpp:3117`, a leftover designated-initializer
line for a non-designatable-after member, fixed moments later by that
agent to a plain assignment); a retry succeeded, and the resulting
`swarmlet-rig-node` image's `ggml-rpc-server --help` lists `--peer
IDX=HOST:PORT` and `--peer-port PORT`, so all six nodes booted in
peer-forwarding mode (`docker logs node1` shows `Peer listener on
0.0.0.0:50053`) for the measurement below.

### Two profiles: `small` and `q4`

Compose's `profiles:` key gates **service inclusion** (`up`/`ps`/`down`
must all pass `--profile`, or nothing shows up — confirmed directly:
`docker compose down` with no `--profile` flag silently tore down
nothing, contrary to the "down matches by project label regardless of
profile" assumption; fixed by always passing `--profile` from
`rig.sh`), not per-value env branching, and every node/delay container
must exist identically in both profiles so published ports and cache
volumes never change (`rig.sh baseline` must keep working unmodified —
confirmed, see below). So both profile names gate the *same* 12
services (`profiles: ["small", "q4"]` on every one), and `rig.sh up N
--profile q4` additionally exports `PEERS_1..6` env vars (Legion
addresses appended) before invoking compose, since Compose variable
substitution can't itself branch on which profile is active:

- **`small`** (default) — 2B `Qwen3.5-2B-Q8_0` draft model, 3 layers
  per node, 6 containerized nodes, fits the default 6 GB Docker
  Desktop VM. This is what was actually built and measured in this
  pass (see below).
- **`q4`** — `Qwen3.6-35B-A3B` Q4_K_M, 5 layers per node, the same 6
  containerized nodes **plus two external Legion peers** wired into
  every node's `PEERS` at indexes 6 and 7:
  `6=host.docker.internal:52251` and
  `7=host.docker.internal:52252` (bridged by the orchestrator on the
  Mac; not containers themselves, just addresses). Needs the `rig`
  colima profile (28 GB VM) — **not yet run**, since that requires
  `colima-up`, which per this task's instructions is only run by the
  orchestrator inside an approved production-stopped window, never by
  this agent. `docker compose config` was used to verify the q4 wiring
  resolves correctly (Legion addresses present at indexes 6/7 for
  every node) without starting any containers.

The node container does **not** need the model file itself — the
driver ships tensors over RPC and `ggml-rpc-server` caches them under
`/cache` (per-node named volumes, unchanged by this pass) — a re-run
of the same split against the same nodes is a cache hit.

### colima recipe (rig profile, 28 GB VM) — MEMORY RULE

**The `rig` colima profile must never run alongside the production LLM
server (port 8099).** Both would compete for the same physical RAM
and risk swapping or OOM on either side. `rig.sh colima-up` prints
this rule but does not enforce it (no visibility into whether a
production window is open) — only the orchestrator may call it, and
only inside an approved production-stopped window; neither
`colima-up` nor `colima-down` is called automatically by any other
`rig.sh` subcommand. **Not run in this pass** — written and
syntax-checked (`bash -n`), not executed, per that same instruction.

```bash
# start the rig VM and switch context to it (orchestrator only, inside
# an approved production-stopped window)
./rig.sh colima-up
#   -> colima start --profile rig --cpu 12 --memory 28 --disk 60 --vm-type vz --mount-type virtiofs
#   -> docker context use colima-rig
#   (saves the prior context to .prev-docker-context, git-ignored, for colima-down to restore)

# copy already-built images across (colima has its own separate image
# store) rather than rebuilding from scratch on the new context
./rig.sh image-transfer
#   -> docker --context desktop-linux save swarmlet-rig-node swarmlet-rig-delay | docker --context colima-rig load

# run the real q4-slab window
./rig.sh up 6 --profile q4
./rig.sh baseline --profile q4
./rig.sh down

# switch back before production resumes
./rig.sh colima-down
#   -> docker context use <whatever was active before colima-up>
#   -> colima stop --profile rig
```

### What was actually run and measured in this pass

Docker Desktop context (`desktop-linux`), **`small` profile only** —
colima was never started, per instructions. Both images built cleanly
after the concurrent `--peer` compile error above resolved:

| image | size |
|---|---|
| `swarmlet-rig-node` | 151 MB |
| `swarmlet-rig-delay` | 214 MB |

`rig.sh up 6 --profile small`: all 12 containers (6 node + 6 delay)
started; `rig.sh status` confirmed node netem off (`qdisc noqueue`),
delay sidecars logging their configured one-way delay per port
(`delay-line 0.0.0.0:50052 -> node1:50052 +8 ms one-way`, etc.), and
all 6 `delayN` host ports (50061-50066) accepting connections. Every
node booted in **peer-forwarding mode** (`--peer`/`--peer-port` both
present in this build).

`rig.sh baseline --profile small` run twice against the same 6 nodes
(cache-hit, no rebuild/restart of the node containers between runs —
only the `delayN` sidecars were recreated with new `DELAY_MS_N`
values, since delay is baked into the container's command line, not
read at runtime), same driver/model/prompts as the original 6-node
baseline above, `--rpc 127.0.0.1:50061,...,50066` (now reaching each
node through its `delayN`, not directly):

| delay (one-way, all 6 nodes) | P1 ms/token | P2 ms/token | content vs. previous run |
|---|---|---|---|
| 8 ms | 254.78 | 207.79 | (this run is the reference) |
| 20 ms | 454.78 | 315.95 | **byte-identical** for both P1 and P2 |

Delta from the 12 ms bump: **+200.0 ms/token (P1)**, **+108.2 ms/token
(P2)**. Content identity confirms the delay-line proxy is a pure
timing shim — it does not corrupt, reorder, or drop RPC bytes.

**These deltas do not match a naive `6 nodes * 2 directions * 12 ms =
144 ms` prediction, and P1 and P2 disagree with each other by nearly
2x** — this was checked, not hand-waved past. Root cause: this
baseline's driver uses `llama-server --rpc ...` (client connects to
all 6 RPC devices directly for a tensor-split compute graph), not the
new `--peer` forwarding ring — so the naive model (one client-facing
round trip per node per token, all 6 in a fixed serial chain) doesn't
describe what's actually happening on the wire. Evidence for what is
happening instead, gathered directly rather than assumed:

- The driver's own log reports **"graphs reused = 47" (P1) vs. "93"
  (P2)** — llama.cpp caches/reuses the compute-graph shape across
  decode steps, and the two prompts produce different graphs (`graphs
  reused` differs), so the RPC call pattern per token is not identical
  between P1 and P2 in the first place.
- `docker logs node1` shows repeated **"Accepted client connection" /
  "Client connection closed"** pairs (23 total across the whole
  session's smoke checks + both baseline runs) — RPC device
  connections are short-lived per compute-graph submission, not one
  persistent stream reused for every token, so each submission's
  connection setup and its constituent ops each independently pay the
  one-way delay through `delayN`, and how many of those there are per
  token is graph-shape-dependent, not a fixed constant.
- This Mac has 18 logical cores; the `small`-profile compose file
  alone requests 3 CPU-shares x 6 nodes + 1 CPU-share x 6 delay
  proxies = 24, before the driver and Docker Desktop's own VM
  overhead — plausible added variance between the two runs from CPU
  scheduling contention on top of the pure network-delay signal.

**What this run does confirm solidly:** per-token latency measurably
and monotonically increases when one-way delay goes from 8 ms to 20
ms across all 6 nodes, in the direction and rough order of magnitude
the design predicts, and output content is unaffected — the rig
correctly emulates a slower symmetric network without changing what
gets computed. **What it does not confirm:** the exact `144 ms`
per-hop-chain arithmetic, because the compute pattern in play
(tensor-split RPC fan-out, cached/reused graphs, per-op connection
churn) isn't the simple serial per-hop chain that formula assumes.
Measuring the `--peer` forwarding ring itself (once a driver/tool
exists that actually uses `--peer` pushes instead of `--rpc` fan-out)
is the natural next step to get a cleaner per-hop number.

`rig.sh down` cleanup was verified end-to-end after the `down`
profile-flag fix above (a 2-node `up`/`down` cycle, confirmed via
`docker ps -a` before and after) — no orphan containers, cache volumes
correctly preserved (not `down -v`), port 8099 confirmed listening on
its original PID throughout.

### `rig.sh delay-rtt`

New subcommand: a lightweight TCP connect/close round-trip through
`delay1`, for a fast sanity check that a delay sidecar is up and
reachable. **This measures only TCP handshake time, not the shaped
data-delay path** — the delay-proxy only holds data *chunks*, not the
initial SYN/ACK, so a bare connect+close doesn't exercise
`DELAY_MS_N` at all (confirmed: it reports ~1 ms regardless of the
configured delay). Use `rig.sh baseline`'s ms/token numbers for the
real shaped-path measurement, as above — `delay-rtt` is only a
"is it up" check.
