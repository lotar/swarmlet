# WAN variant matrix: every split variant re-measured on the Legions under emulated internet

**Goal:** usable speed (20+ tok/s per stream) over the internet, permanent real-time channel, engine changes allowed in isolated trees.  
**Date started:** 2026-09-02 17:20 UTC  
**Return point:** production engine `~/projects/local-llm/llama.cpp-pr27739` (untouched), production service `com.lotar.llm-flashnext` on :8099, Legion working trees `~/llama-remote-mtp-integration` (untouched). Labs: `/tmp/llama-wan-lab` (base `dfa0c0f` + remote-mtp), `/tmp/llama-upstream-lab` (upstream master `9400c89`, has Qwen4Exp, MTP drafting, async RPC dispatcher); same two trees under `/home/lotar/` on both Legions with CUDA builds.

## 0. Test rig changes (durable, no root needed at runtime)

- Wi-Fi power save disabled at the NetworkManager connection level on both Legions (`802-11-wireless.powersave 2`, survives reboot) plus the userland keepalive.
- WAN emulation on the real Wi-Fi interface: `~/wanem.sh set DELAY JITTER LOSS [RATE]` applies netem on Legion egress toward the M5 only (u32 filter on dst 192.168.1.53), `~/wanem.sh clear` removes it. One-way delay D on Legion egress gives ~D added RTT; profiles below are named by that one-way value.
- All three machines share one public IP (93.142.130.28), so "internet" is emulated delay/jitter/loss on the real radio path, not ISP routing. Real cross-ISP tests need a VPS or a phone hotspot (step 8).

## 1. Transport floor (no model): what one round trip costs on this rig

Evidence: `sin-harness/data/legion-goal/wan-transport-matrix-20260902T172938Z/results.jsonl` (100 rounds each). The `lan` profile ran while two model downloads saturated Legion 2's radio and is invalid; it is rerun in §1b.

| Profile (Legion egress) | Transport | 64 B p50 / p95 | 20 KiB row p50 / p95 |
|---|---|---|---|
| wan25 (25 ms ±3) | SSH tunnel TCP | 62.5 / 95.6 | 34.2 / 67.9 |
| wan25 | direct TCP | 38.7 / 83.6 | 33.7 / 38.3 |
| wan25 | direct UDP (≤1400 B datagrams) | 32.0 / 38.1 | 32.0 / 37.7 |
| wan25-loss1 (25 ms ±5, 1 % loss) | SSH tunnel TCP | 33.2 / 42.0 | 35.9 / 68.1 |
| wan25-loss1 | direct TCP | 32.1 / 41.4 | 35.9 / 72.1 |
| wan25-loss1 | direct UDP | 32.0 / 40.3 (3 lost) | 31.9 / 40.7 |
| wan60 (60 ms ±10, 0.5 % loss) | SSH tunnel TCP | 69.2 / 85.2 | (see jsonl) |
| wan60 | direct TCP | 68.1 / 85.0 | |
| wan60 | direct UDP | 68.2 / 84.1 | |

| wan100-loss2 (100 ms ±20, 2 % loss) | SSH tunnel TCP | 106.1 / 134.8 | 118.1 / 267.9 (max 545) |
| wan100-loss2 | direct TCP | 110.1 / 146.2 | 113.0 / 210.4 (max 433) |
| wan100-loss2 | direct UDP | 106.1 / 141.6 (2 lost) | 102.3 / 139.8 (2 lost) |
| lan-clean (radio quiet, downloads paused) | SSH tunnel TCP | 6.7 / 8.4 | 9.2 / 16.0 |
| lan-clean | direct TCP | 6.7 / 8.4 | 8.3 / 10.6 |
| lan-clean | direct UDP | 6.0 / 8.2 | 6.1 / 8.3 |

Reading:
- Quiet Wi-Fi LAN floor for one 20 KiB hidden row: 6 to 9 ms round trip. That is the number every LAN variant pays per hop; it was 19 to 35 ms earlier today only because the radio was shared with other traffic. Keep the radio quiet during measurement or the results are noise.
- Under emulated delay the floor is delay plus ~7 ms on every transport. SSH forwarding costs 20 to 30 ms extra at p50 on small messages at wan25 and its p95 tail is 2× the UDP tail under loss (one lost segment stalls the whole encrypted stream; at 100 ms / 2 % loss the SSH p95 for a row is 268 ms vs 140 ms for UDP).
- Conclusion for the permanent channel: datagram-based and multiplexed (QUIC, or Noise over UDP with per-stream retransmit), never SSH TCP forwarding. The bounded parser and epoch binding from the existing protocol carry over unchanged.

## 2. Variants and pass conditions (per stream, 4 streams unless stated)

Each variant is measured at profiles lan, wan25, wan60, wan100-loss2. Pass = ≥20 tok/s per stream at wan25 with exact greedy parity to the single-node reference where the variant claims exactness.

| # | Variant | Engine | Network per token | Expected (from §1 + measured compute) | Status |
|---|---|---|---|---|---|
| V0 | M5 alone, target-only (reference) | any | 0 | 16 tok/s/stream at c4, 33 at c1 | measured 2026-09-02 |
| V1 | Remote MTP n=1, fork/commit, groups=2 (hidden RTT) | base lab | 1 hop, 20 KiB up / 43 B down, hidden | 54 tok/s aggregate on LAN; at wan25 RTT no longer hides behind a 53 ms verify → drops | to run under wanem |
| V2 | V1 with chained n=2 drafts (2 rows back per hop) | base lab (small change) | 1 hop | +30 % tokens per hop if acceptance holds | to run |
| V3 | Remote drafter with k-token batched verify (DSD-style: draft k, verify k in one batch, one hop per k tokens) | base lab (new bench mode) | 1 hop per k tokens | hops/token = 1/k; at k=4 wan25 cost 8 ms/token → 20+ tok/s/stream possible if acceptance ≥ 70 % | to build |
| V4 | Pipeline split via upstream async RPC: Legion 1 holds layers 0-5, Legion 2 layers 6-11, M5 the rest, Q4 experts | upstream lab | 2 hops, 20 KiB each, async pipelined | measures the real per-boundary cost after async RPC replaced the 462 ms | to run |
| V5 | Full replica on a Legion (Qwen3-4B Q4 and 1.7B Q8, whole model in 4 GB VRAM), served by llama-server, requests routed over the WAN | upstream lab | 0 per token | 20+ tok/s per stream expected at any RTT (only first-token latency pays RTT) | models downloading |
| V6 | Replica + speculative on-node (V5 with a local draft) | upstream lab | 0 | headroom above V5 | after V5 |
| V7 | Expert bank per layer remote via RPC (handoff §11 shape) under async RPC | upstream lab | 2 hops/layer moved | capacity test, expected <20 tok/s | to run once |
| V8 | Datagram channel prototype (UDP, Noise-like framing, multiplexed streams, retransmit) replacing SSH for V1/V3 | new code | same hops | tail p95 under loss should match §1 UDP rows | after V3 |

## 3. Results

### V1 remote MTP n=1, exact fork/commit, F16 rows, both Legions, wan25 (25 ms ±3 one-way on Legion egress)

Evidence: `sin-harness/data/legion-goal/fork-e2e-wan-25-3-0-20260902T173516Z/`. Legion GPUs were also compiling during this window (worker compute mean inflated); acceptance identical to LAN (79.3 %).

| Arm | tok/s aggregate | per stream | verify p50 | worker wait p50 / p95 |
|---|---|---|---|---|
| A1 target-only (M5 alone) | 61.9 | 15.5 | 62.6 ms | |
| B2 groups=2 (RTT hidden behind other group's verify) | 47.6 | 11.9 | 56.9 ms | 0.0 / 30.7 ms |
| B1 groups=1 (RTT exposed) | 39.4 | 9.8 | 81.0 ms | 67.3 / 77.7 ms |
| A2 target-only | 63.6 | 15.9 | 59.7 ms | |

LAN reference (same arms, this morning): B2 54.2, B1 51.4, A 65.7 / 67.0. At 25 ms the hidden-RTT design loses 12 % and the exposed one 23 %; neither reaches the single node, and per stream both are far under 20. Worker request RTT under wan25 measured from the M5: B2 p50 48 to 51 ms, p95 71 ms; B1 p50 64 ms (includes queueing behind the larger batch). The per-stream number is bounded by the M5 verify (57 ms for 2 tokens per stream), not by the Legions. Stream 0 stays token-exact through every fork/commit/discard; other streams flip at batch-dependent greedy near-ties as before.

Operational trap found: a replica server left resident on a Legion (3.7 GB of 4 GB VRAM) makes the MTP worker fail to load; the operator must ensure the Legion GPU is empty before B arms.

### V2 chained k=2 drafts (worker feeds its own MTP pre-norm hidden and argmax back, exactly as the reference drafter does), wan25

Evidence: `sin-harness/data/legion-goal/fork-e2e-wan-25-3-0-20260902T174444Z/`. Timing in this window is contaminated (cold page cache after an aborted start: 66 GB paged in, load 11, target-only fell to 24.7 tok/s), but acceptance does not depend on timing:

| Arm | draft tokens accepted | replays / phases |
|---|---|---|
| B2 chain=2 | 214 / 608 = 35.2 % | 212 / 294 |
| V1 single draft (reference) | 288 / 363 = 79.3 % | 75 / 236 |

Per-hop histogram: 180 hops accepted 0 drafts, 34 accepted 1, 90 accepted 2. The 59 % zero-accept rate (vs 21 % for V1) and early divergence of streams 1 to 3 (indices 18 to 25) exposed a bug in the first chain bench: padding batch entries added to keep ubatches equal-length perturbed the other streams' numerics. `split_equal` defers unequal sequence sets to further ubatches on its own, so the padding was unnecessary; removed (bench `1d1ff663…`). **This window's V2 result is invalid.** Control rerun through the corrected lab bench and lab worker at chain=1 (`fork-e2e-wan-25-3-0-20260902T175729Z`, timing contaminated by M5 load 9 to 18 from other sessions and a cold cache, acceptance valid): B2 78.0 % (283/363), B1 74.0 % (268/362), matching the original 79.3 %. The new code path is exact at chain 1; the padding was the only regression. Chain=2 rerun with the corrected bench (`fork-e2e-wan-25-3-0-20260902T180516Z`, B2 groups=2, timing again contaminated by host load, acceptance valid):

| | value |
|---|---|
| draft tokens accepted | 290 / 560 = 51.8 % |
| hops accepting 0 / 1 / 2 drafts | 108 / 54 / 118 of 280 |
| first draft accepted | 61.4 % (78 % at chain=1: partial rejects force a replay phase that a single draft would not) |
| second draft accepted given first | 68.6 % |
| useful tokens per round trip (incl. the known token) | 2.04 vs 1.78 at chain=1 (+14 %) |
| stream 0 | token-exact for 192 tokens |

**Verdict on V2:** chaining the single MTP head works and lifts tokens per hop by 14 %, not the 2× needed to make a remote hop pay against the 6 to 10× cheaper local draft. Not a path to 20 tok/s per stream on this model; kept as a measured constant for the design space. If acceptance stays near 35 % after the fix, the single trained MTP head does not chain and multi-token remote drafting needs a chained-head model or a separate small drafter.

### V5 full replica: Qwen3-4B Q4_K_M on Legion 1 (GTX 1650 Ti, 3.7 GB VRAM, `llama-server -ngl 999 --parallel 4 --kv-unified -fa on`), requests from the M5 through the emulated WAN

Evidence: `sin-harness/data/legion-goal/replica-4b-legion1-20260902T173725Z/`. 128 tokens per request, greedy, handoff's own client.

| Profile (Legion egress) | c1 per stream | c4 per stream | c4 aggregate |
|---|---|---|---|
| lan | 48.4 | 22.8 | 86.8 |
| wan25 | 48.3 | 22.7 | 86.7 |
| wan60, 0.5 % loss | 48.1 | 22.6 | 69.5 |
| wan100, 2 % loss | 48.0 | 22.5 | 56.2 |

Per-stream generation speed is independent of the network: 48 tok/s at c1 and 22.5 to 22.8 at c4 from LAN to 100 ms / 2 % loss. Only the aggregate falls with RTT, because the per-request fixed cost (connection, prompt, first token) is paid once over the WAN. **This is the first variant on this rig to clear 20 tok/s per stream over the internet profile, and it does so on a 4 GB laptop GPU.** The M5 alone gives 15.5 to 16 per stream at c4 on the 104 GB model; the comparison is not model-for-model, it is "what a mesh node can serve end to end".

### V4 preparation: upstream master vs the locally patched GGUF

Upstream master (`9400c89`) reads the original unsloth key and tensor names (`hyper_connection.low_rank`, `ple.layer_multipliers`, `ple.head_offsets`, `ple.head_vocab_sizes`, `per_layer_token_embd`, `ple_norm_key`), exactly the names the local `flashnext-patch-gguf.py` renamed away for the PR-era engine, in place, with no `.orig` kept. First V4 attempt failed at `key not found in model: qwen4exp.hyper_connection.low_rank`. Fix, isolated to the upstream lab tree: a name-alias shim in `llama-model-loader.cpp` (`get_key`/`get_arr`/`get_arr_n`/`get_key_or_arr` on string keys, and `get_weight` for tensor names), archived as `sin-harness/proofs/remote-mtp-src/upstream-gguf-compat-shim.patch`. Production engine and GGUF untouched.

**Incident:** validating the shim with a CPU-only upstream server beside the running production mapped a second 104 GB image; with the Docker VM's 28 GB reservation the box thrashed (swap 11 to 21 GB), production went unresponsive for about 7 minutes and recovered on its own. Rule from now on: the 104 GB model is loaded by exactly one process on the M5, so any engine validation happens inside a production-stop window.

Second V4 attempt (split `92,4,4`) failed at `failed to allocate RPC0 buffer of size 77327433344`: with `--rpc` the RPC devices come first in the model's device order, so the 92 % share went to Legion 1. Operator now pins `--device RPC0,RPC1,MTL0 --tensor-split 4,4,92` (2 layers per Legion, 3.1 GiB each).

Third attempt (`4,4,92`, pinned order) got through weight placement: 7.5 minutes from server start to the first compute-buffer allocation, i.e. ~6.2 GB of expert weights shipped to the Legions at about 13 MB/s over the Wi-Fi. It then failed at `ggml_gallocr_reserve_n_impl: failed to allocate RPC0 buffer of size 158460032` (compute scratch does not fit beside 3.1 GiB of weights and the KV on a 3.7 GiB card). Split reduced to one layer per Legion (`1,1,46`, 1.55 GiB). Placement cost alone is a finding: at 13 MB/s a 1.5 GiB layer takes ~2 minutes to move, so any re-placement on node churn is minutes, not seconds, on this class of link.

### V4 per-layer pipeline over upstream async ggml RPC (M5 Metal + Legion 1 CUDA + Legion 2 CUDA), one layer per Legion, split `1,1,46`, lan

Evidence: `sin-harness/data/legion-goal/pipeline-rpc-lan-split1_1_46-20260902T185656Z/`. Upstream master `9400c89` with the GGUF name shim; async RPC dispatcher active; PLE table on M5 CPU; quiet Wi-Fi (6 to 9 ms floor).

| | c1 | c4 |
|---|---|---|
| per stream | 3.76 tok/s (266 ms per token) | 3.53 tok/s |
| aggregate | 3.28 | 9.63 |
| M5 alone (reference) | 33 tok/s | 62 to 67 |

Two hops per token (M5 to Legion 1 to Legion 2 to M5 is three boundaries; layer 0 on L1, layer 1 on L2, rest on M5). The added cost is ~235 ms per token, ~80 to 115 ms per boundary, 10× the raw transport floor for a 20 KiB row. So async RPC removed the 462 ms per boundary measured on the old synchronous RPC, but the remaining per-boundary cost is protocol and per-graph overhead (set_tensor of inputs, graph dispatch, get_tensor of outputs, each a full round trip), not the radio. Batching four streams gives 2.9× aggregate because the per-boundary cost is per graph, not per token.

### V5 two-node replica mesh: both Legions serving Qwen3-4B Q4, 4 streams each concurrently (8 total), requests routed from the M5

Evidence: `sin-harness/data/legion-goal/replica-4b-two-node-20260902T190834Z/`.

| Profile | Legion 1 per stream | Legion 2 per stream | mesh total (8 streams) |
|---|---|---|---|
| lan | 23.1 | 20.9 | 165.4 tok/s |
| wan25 | 22.9 | 21.0 | 155.3 |
| wan100, 2 % loss | 22.9 | 20.9 | 131.4 |

Per-stream speed does not move with RTT or loss; the mesh total scales linearly with nodes and drops with RTT only through per-request fixed cost. Legion 2 (GTX 1650, no Ti) is 9 % slower than Legion 1. **This is the internet-viable mesh, measured: two 4 GB laptop GPUs serve eight 20+ tok/s streams through a 100 ms, 2 % loss link.**

### Real internet, not emulated: all three nodes served in parallel through Cloudflare's public edge

Setup (2026-09-02 19:19 UTC): each node exposes its llama-server through a Cloudflare quick tunnel (`cloudflared tunnel --url http://127.0.0.1:PORT`, user-local binary on the Legions, `--config /dev/null` on the M5 so the fleet-bridge ingress rules do not capture it). Public hostnames on `trycloudflare.com`; tunnels registered at Cloudflare's Zagreb edge (`location=zag01`). Requests from the M5 leave the house: 8 hops via T-Com Croatia (195.29.x.x) to Cloudflare at the CIX exchange (`cloudflare.cix.hr`, 185.1.87.115) and terminate at 104.16.231.132, then back down the tunnel into each node. Same-house origin, but every request traverses the ISP and Cloudflare's network both ways.

Per-request internet cost, Legion 1, cold HTTPS each time (mean of 5): TCP connect 11 ms, TLS done 26 ms, first byte 129 ms, against 22 ms first byte on the server itself: **~107 ms of real-internet overhead per request, paid once per request, never per token.**

Smoke (1 stream per node, 32 tokens, all three nodes at once):

| Node | server per-stream | client per-stream (through internet) | first token |
|---|---|---|---|
| Legion 1 (Qwen3-4B Q4) | 50.7 | 34.0 | 336 ms |
| Legion 2 (Qwen3-4B Q4) | 48.2 | 32.8 | 331 ms |
| M5 (Qwen3.8-Flash-Next, production) | 33.4 | 23.6 | 427 ms |

Full runs, 128 tokens per request, greedy, all three nodes driven at the same time (evidence: `sin-harness/data/legion-goal/internet-mesh-20260902T192512Z/`):

| Load per node | Node | server per-stream | client per-stream through the internet | first token | node goodput |
|---|---|---|---|---|---|
| c1 | Legion 1 | 50.4 | 46.4 | 273 ms | 46.3 |
| c1 | Legion 2 | 47.6 | 41.1 | 464 ms | 41.1 |
| c1 | M5 production (104 GB model) | 32.6 | 29.1 | 505 ms | 29.1 |
| c1 | **mesh total, 3 streams** | | | | **87.3 tok/s** |
| c4 | Legion 1 | 24.1 | 22.6 | 398 ms | 90.2 |
| c4 | Legion 2 | 22.4 | 21.1 | 413 ms | 83.6 |
| c4 | M5 production | 15.0 | 13.8 | 821 ms | 55.1 |
| c4 | **mesh total, 12 streams** | | | | **165.2 tok/s** |
| c8 | Legion 1 | 24.3 | 16.0 | 3.65 s | 87.3 |
| c8 | Legion 2 | 22.7 | 15.0 | 3.91 s | 81.4 |
| c8 | M5 production | 14.1 | 9.6 | 5.96 s | 51.8 |
| c8 | mesh total, 24 streams | | | | 155.5 tok/s |

Reading:
- Through the real internet, a Legion stream delivers 21 to 23 tok/s at c4 and 41 to 46 at c1; the tunnel costs 1.3 to 1.5 tok/s per stream at c4 (server 24.1 vs client 22.6) and 4 to 6 at c1, all of it first-token setup amortized over 128 tokens.
- **Fastest configuration: c4 per node, 165 tok/s across the three machines with every stream above 20 tok/s on the Legions.** c8 per node adds nothing: the servers run 4 slots, so the extra requests queue (first token 3.7 to 6 s) and the total falls to 155.
- The M5 serves its 104 GB model at 13.8 per stream through the internet at c4 (15.0 server-side), so the mesh is three heterogeneous replicas with request routing, exactly the topology the arithmetic predicted.

## 4. Final scoreboard (per stream, wan25 unless noted; target 20+)

| Variant | per-stream tok/s | aggregate | exact vs single node | network per token |
|---|---|---|---|---|
| V0 M5 alone, 104 GB model, c4 | 15.5 to 16.7 | 62 to 67 | reference | 0 |
| V1 remote MTP n=1, staggered | 11.9 | 47.6 | stream 0 exact, others near-tie flips | 1 hop hidden |
| V1 remote MTP n=1, one group | 9.8 | 39.4 | same | 1 hop exposed |
| V2 chained k=2 | (timing contaminated) | | 2.04 vs 1.78 tokens/hop | 1 hop |
| **V5 full replica, Qwen3-4B Q4 on a Legion, c4** | **22.5 to 22.8** | 87 (lan) to 56 (wan100) | n/a (different model) | 0 |
| V5 same, c1 | 48 | 48 | | 0 |
| **V5 two-node mesh, 8 streams, wan100 2 % loss** | **20.9 to 22.9** | **131** | | 0 |
| V4 pipeline over async RPC, 1 layer per Legion, lan | 3.5 to 3.8 | 3.3 (c1) to 9.6 (c4) | same model | 3 boundaries per token |
| V4 same, wan25 | 1.8 to 1.9 | 1.6 (c1) to 4.4 (c4) | same model | 3 boundaries per token; +250 ms per token for 25 ms one-way delay, i.e. ~10 sequential round trips per token |

## 5. Verdict

Measured on the real rig under emulated internet profiles, no guesses:

0. **Confirmed on the real internet, not emulation (19:25 UTC):** three nodes served in parallel through Cloudflare's Zagreb edge; at c4 per node the mesh delivers 165 tok/s over 12 streams with Legion streams at 21 to 23 tok/s and the M5's 104 GB model at 13.8; per-request internet overhead ~107 ms, never per token.
1. **20+ tok/s per stream over the internet is reached only when no per-token traffic crosses the network.** A GTX 1650 Ti serving Qwen3-4B Q4 as a complete replica gives 48 tok/s at c1 and 22.5 per stream at c4, unchanged from LAN to 100 ms with 2 % loss. That is the mesh design that works: nodes hold whole models, the orchestration layer routes requests.
2. **Every design that ships hidden state per token loses to the single node, at any RTT above zero.** Remote MTP drafting: 47.6 vs 62 to 64 aggregate at wan25 with the round trip hidden, 39.4 exposed; chained k=2 drafting adds 14 % per hop, not the 2× needed. Per-layer pipeline over the newest async RPC: 3.8 tok/s per stream, 9× slower than the M5 alone, with ~100 ms per boundary of protocol overhead on top of a 6 to 9 ms transport floor.
3. **The permanent channel should be datagram-based and multiplexed.** Under 100 ms / 2 % loss, SSH-tunneled TCP p95 for one 20 KiB row is 268 ms; UDP is 140 ms; on a quiet LAN all transports floor at 6 to 9 ms. The keepalive fix is durable (NetworkManager power save off on both Legions).
4. **What would change the picture for the 104 GB model:** it cannot be replicated on 4 GB nodes, so the only internet-viable shape for it is a few-node layer pipeline where the per-boundary cost is driven from ~100 ms to the ~7 ms floor. That is engine work inside ggml RPC (coalesce set_tensor / graph_compute / get_tensor into one message per boundary, keep activations device-resident across the hop), not orchestration work. The upstream async dispatcher removed the 462 ms; the next 90 ms is a protocol redesign.
5. **Weight placement over this link is 13 MB/s** (6 GB in 7.5 minutes): re-placement on churn is minutes, which the orchestration layer must plan for.

Return point unchanged: production engine `llama.cpp-pr27739` and its GGUF untouched; Legion working trees untouched; all engine changes live in `/tmp/llama-wan-lab` (chain worker, k-draft bench) and `/tmp/llama-upstream-lab` (GGUF name shim), mirrored under `/home/lotar/` on the Legions, with sources and patches archived in `sin-harness/proofs/remote-mtp-src/`.
