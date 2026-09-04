# Push forwarding, the standing per-token program, and the 8-node 35B ring (colima window)

**Date:** 2026-09-03. Continuation of `RING_ORCHESTRATION_E2E_20260903.md`. Same method: two Sonnet subagents implemented from written specifications (protocol in the llama.cpp lab tree; symmetric-delay rig, peer wiring, colima scripts), the orchestrator owned every end-to-end test and re-ran the decisive ones itself.

## 1. What was built

| piece | where | what it does |
|---|---|---|
| push forwarding (protocol 8) | `ggml/src/ggml-rpc/ggml-rpc.cpp`, `ggml/include/ggml-rpc.h`, `tools/rpc/rpc-server.cpp` (+931 lines) | three commands: `FORWARD_TENSOR` (client tells node A "after your compute, push this tensor to peer B"), `PUSH_TENSOR` (A to B over a persistent peer connection, HELLO-handshaked), `WAIT_INBOUND` (client tells B "block your next compute until push seq N has landed", 120 s timeout). Server: `--peer IDX=host:port` table, `--peer-port`, a peer listener thread, a process-global inbox. Client: the RPC backend's `cpy_tensor_async` hook, active with `GGML_RPC_FORWARD=1`, replaces GET-then-SET between two remote nodes with FORWARD+WAIT. Off by default; protocol major 7 to 8 so mismatched builds refuse each other. |
| standing per-token program (the client-driven form of the head-node loop) | same, via the pipelined dispatcher | with forwarding plus the pipelined dispatcher the client writes the whole ring's commands for a token in one go (SET+RECOMPUTE+FORWARD to node 0, WAIT+RECOMPUTE+FORWARD to node 1, ..., WAIT+RECOMPUTE to the last) and waits exactly once, for the last node's output. Per token the ring runs at one-way speed between nodes; the M5 keeps the sampler, the MTP draft head and the output head. The variant that moves sampling to a remote head node is out of reach inside ggml-rpc: it needs llama contexts on the nodes (positions, masks, recurrent-state inputs are built by `llama_context` per batch), i.e. a stage-server runtime, not a protocol extension. |
| symmetric-delay rig | `sin-harness/rig/` (`delay-proxy.py`, `Dockerfile.delay`, compose profiles `small` and `q4`, `rig.sh` with `--profile`, `colima-up/down`, `image-transfer`) | one delay-line sidecar per node fronting its client port and its peer port, so client-to-node, node-to-client and node-to-node legs all pay the configured one-way delay (kernel ingress shaping is unavailable in the Docker Desktop kernel). Peer tables wired through the sidecars. |
| colima window | `rig.sh colima-up` (28 GB, 12 CPU, vz), scratchpad `e2e/ring8-window.sh` | six containers with 5 layers each of Qwen3.6-35B-A3B Q4_K_M, both Legions with 5 layers each on their GPUs, output head on the M5; production stopped for the window and restored by the trap. |

## 2. Results

### 2a. Forwarding on three local nodes (delay-line harness, orchestrator's run)

| client | round trips per token (3 remote nodes) | outputs |
|---|---|---|
| default / pipelined | 3.18, 3.22 | identical across delays |
| forwarding + pipelined | 2.17 | identical to the non-forwarding outputs |

Legs per token go from 2n (n = remote nodes) to n+2: 6 to 5 one-way legs here, measured as 3.2 to 2.2 round-trip equivalents.

### 2b. Six emulated nodes, small model, symmetric 8/8/8/8/20/20 ms legs (orchestrator's run, beside production)

| streams | default (ms/token, aggregate) | pipelined | forwarding + pipelined | texts identical |
|---|---|---|---|---|
| 1 | 195, 4.6 | 200, 4.5 | 130-133, 6.5-6.6 | yes |
| 4 | 312, 10.4 | 282, 12.2 | 220, 14.7 | yes |
| 8 | (not run) | 1225, 5.3 | 1273-1751, 3.9-5.9 | yes |

Single-stream time per token drops 32 % (12 legs to 8). The eight-stream rows collapsed for both clients and degraded across repeats; the box was at load average 10 with production serving, and the userspace delay sidecars are the likely bottleneck at that concurrency. Treated as a rig limit, not a client result; zero crashes.

### 2c. Eight-node ring with the 35B Q4_K_M model (colima window, six containers plus both Legions over the real tunnels, output head on the M5)

Loading shipped 20 GB of slabs in 400 s. Node containers held 1-5 GB each (16 GB caps). Plain greedy, 48 tokens per stream:

| streams | default (ms/token per stream, aggregate) | forwarding + pipelined | texts identical |
|---|---|---|---|
| 1 | 340, 2.2 | 158, 6.3 per token (aggregate 1.7 includes the first load) | yes |
| 4 | 662, 4.7 | 459, 4.4 | yes |
| 8 | 868, 6.8 | 641, 8.2 | yes |

Lossless MTP chain 7 on the same ring with forwarding: 7.6 tok/s per stream single stream (minimum 5.8), 6.3 per stream and 11.5 aggregate at two streams, 4.65 tokens per verify step, 58 % acceptance. The verify step is dominated by the containers' CPU compute on 8-position batches of the 35B slabs (three cores each); with GPU-class nodes at ~10 ms per batch the same ring computes to roughly 20 tok/s per stream. The eight-node latency is in the same range as the three-node real ring because the container legs are cheap and the two Legion hops dominate.

### 2d. Real three-node ring over the public internet (Q4_K_M, 4/4/32, Legion 1 pushes to Legion 2 through its own bridge to Legion 2's peer tunnel)

| streams | pipelined (ms/token, aggregate) | forwarding + pipelined | texts identical |
|---|---|---|---|
| 1 | 163, 5.4 | 139-142, 6.2 | yes |
| 4 | 400, 8.9 | 339, 7.0 | yes |
| 8 | 470, 15.1 | 492, 13.3 | yes |

Per-stream latency improves 13-15 % single stream (six legs to five) and 15 % at four streams; aggregate at eight streams is slightly lower with forwarding because the source server executes the push inside its command loop (read tensor, write to the peer socket, then continue), which serializes pushes of different streams. Moving the push to a sender thread is the obvious follow-up.

## 3. Correctness

Every forwarding run above produced text byte-identical to the non-forwarding run at the same stream count (harness, rig, 8-node ring, real ring), no container or Legion server crashed, and the multi-stream inbox interleaving held at eight streams.

## 4. What the numbers say

- Forwarding is worth n-2 one-way legs per token on an n-node ring: 0 on two nodes, one on three (measured 13-15 %), four on six (measured 32 %), and 2.1x per-token on the eight-node ring where the default client also pays the M5 relay for every container hop.
- Per-stream speed on a ring is still tokens per trip times trip rate; speculation stays the multiplier (4.65 tokens per step) and node compute sets the step on CPU nodes.
- Aggregate throughput scales with streams in flight on both clients until a stage saturates; the sidecar rig saturates at eight streams beside production, the real ring does not.

## 5. Evidence and state

Windows: `sin-harness/data/legion-goal/ring8-20260903T101617Z` (colima 8-node), `q36-ringfwd-real-20260903T103650Z` (real ring), scratchpad `e2e/out-my_fwd_*` (harness), `e2e/rbf-*.json` (rig matrix). Lab tree diff: 7 files, +1008/-43 (uncommitted, env-gated; defaults unchanged except the protocol number). Both Legions run the protocol-8 server. Rig images `swarmlet-rig-node` (151 MB) and `swarmlet-rig-delay` (214 MB); colima profile `rig` exists stopped; Docker Desktop context restored. Production restored after each window; the fork session running evals was told before and after every window.
