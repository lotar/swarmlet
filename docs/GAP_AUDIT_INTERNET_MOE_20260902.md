# Gap audit: Swarmlet vs the end goal (MoE LLM split across many devices over the internet, fast orchestration layer)

**Date:** 2026-09-02  
**Repository:** `/Users/lotar/projects/ai-mesh` at `0abad80` (public `github.com/lotar/swarmlet` at `1df35ca`)  
**Method:** five independent read-only audits (orchestration, transport/security, MoE split arithmetic, prior art, engineering readiness), each claim re-verified in source by the lead before inclusion. Legion Wi-Fi experiments are treated as the proof of concept they were.

## 0. One-paragraph verdict

The project has proven expert ownership, exact routing, signed evidence and a bounded wire protocol on a LAN. It has not built any part of an orchestration layer, any internet transport, or any mechanism that can split this MoE below the granularity of "one whole expert bank per layer". Its own arithmetic and its own kill criteria (`docs/KIMI_K3_DISTRIBUTED_MOE.md:77,232`) already say that per-layer or per-expert traffic over a WAN cannot produce interactive throughput; today's measurements confirm the constant: one cross-endpoint boundary costs 462 ms in the current stack, and even a hidden 20 ms LAN round trip loses to local compute by 6 to 10 times. The only internet-viable topology for this model class is complete replicas with request routing, which is a different product than "split a MoE". The reachable path to the end goal is therefore not more transport work on the current design but (1) a topology decision, (2) a control plane that does not exist, and (3) fixing the engine so that experts are individually addressable and communication is asynchronous.

## 1. Measured physics that bound every design (verified)

| Constant | Value | Source |
|---|---|---|
| M5 verify step, 4 tokens / 8 tokens | 58 ms / 78 ms (≈38 ms fixed + 5 ms per token) | addendum §3 |
| Local MTP draft, 1 row | 2.4 ms compute, 3.4 ms phase | `local-mtp-loopback-20260902T151633Z` |
| Wi-Fi round trip, one 20 KB row, keepalive on | 19 to 35 ms p50 | addendum §2 |
| One cross-endpoint tensor boundary, ggml RPC | +462 ms per token | handoff §13 (529 ms two endpoints vs 49 ms one) |
| Layer-boundary payload | 10240 values = 20 KiB F16 (4 hyper-connection streams × 2560) | `qwen4exp.cpp:39,643-645`; `n_embd_out = 10240` in every load log |
| Expert weights per layer | one fused tensor `[2560,640,512]` (gate 472 MB Q4_K, down 629 MB Q5_1) | load logs; overrides match by tensor name only |
| Recurrent state | 36 of 48 layers carry per-sequence recurrent state | `qwen4exp.cpp` layer loop, `full_attention_interval = 4` |
| PLE n-gram table | 28.8 GB, 16 random row gathers per token, host-side | serve script, `flashnext-resplit-ngram.py` |

Break-even rule with the measured constants: `tok/s = 1000 / (60.3 + hops × RTT_ms)`, so a split beats the single node only when `hops × RTT_ms < 15 ms`.

| Split | Serial hops/token | Viable RTT | Internet (50 ms) |
|---|---|---|---|
| Per-layer pipeline, 48 nodes | 48 | < 0.3 ms | 0.4 tok/s |
| Per-layer pipeline, 4 nodes | 4 | < 4 ms | 3.8 tok/s |
| Expert-parallel or tensor-parallel | 96 (dispatch + reduce per layer) | < 0.16 ms | 0.2 tok/s |
| Remote draft / local verify (n=1) | 1 | ceiling +13 % at RTT 0, negative at any real RTT | 8.9 tok/s |
| Complete replicas + request routing | 0 | any | 66 tok/s per node, linear in nodes |

Capacity, not speed, is the one measured win for a partial split: a full layer-0 expert bank remote cost 36 % throughput at c1 (21.2 vs 33.3 tok/s) to move 1.57 GB off the box.

## 2. Gaps by axis (ranked within axis, evidence cited)

### A. Orchestration layer (does not exist)

1. No planner. Site: "the planner scores memory, compute, bandwidth, latency, and failure risk." Code: `self.placement={NODE_IDS[i]:self.selected[i::3]}` (`qwen-flash-experts/cell.py:64`) and a seven-entry hand-typed dict (`physical_matrix.py:40`). README's "not proven" list agrees.
2. No control plane: no registry, heartbeat, join, leave, capability advertisement beyond a static `/manifest` (`worker.py:64`). Grep for heartbeat/gossip/discovery/membership/liveness hits only comments.
3. Placement cannot change without a full restart: the epoch is a hash of the placement itself (`tiny-moe/placement.ts:17`); any membership change invalidates every manifest and in-flight request; `cell.py:113` throws `EXPERT_NOT_RESIDENT` for anything off the fixed set.
4. Routing is dynamic, placement is static and total: the real 512-way router runs (`cell.py:111`) but only the ten experts pinned at construction are servable. Layer 0 of 48 only (`qwen-flash-experts/README.md:130`).
5. No expert-popularity or per-expert cost signal; placement balances counts 4/3/3, which `docs/PHYSICAL_SPLIT_MATRIX.md:83` names as why the split loses.
6. Failover is one hardcoded pair (`replicas={'n2':'n4'}`, `cell.py:64`); two of three owners fail closed.
7. No request-level scheduling: no queue, admission control, cross-request batching, persistent connections (`server.py:42` synchronous handler; fresh `urllib` request per dispatch, `cell.py:32`).
8. The partition planner (`no-ram-goal/partition_planner.py:21`) is real DP but hardcodes 48 layers / 8 stages / uniform cap and nothing consumes its output; the scheduler sim uses one scalar `link_ms`.

### B. Transport, security, NAT (LAN-only by construction)

1. No encryption or peer authentication on any data-plane socket; the MTP handshake compares public config strings (`llama-mtp-worker-server.cpp:274-278`); zero tls/auth hits in 2065 lines of `ggml-rpc.cpp`. Confidentiality and host identity come entirely from SSH tunnels (`TWO_NODE_PROTOCOL.md:13`).
2. Strict lockstep, one message in flight: msg-id gaps are protocol errors (`llama-mtp-worker-server.cpp:312`), the client serializes under a mutex, RPC blocks per command. RTT cannot be pipelined away.
3. No WAN link has ever been measured. The "EU 12/16/22 ms" profile is `time.sleep()` in a loopback worker (`cell.py:16`, `worker.py:77`); `docs/RESULTS_GRID.md:15` still labels that row "measured".
4. No NAT traversal, discovery, rendezvous, or membership; static host:port only (`remote-mtp-protocol.h:468`, `ggml-rpc.cpp:284`).
5. Single-connection servers: `accept_one` once with `listen(fd,1)` (`llama-mtp-worker-server.cpp:269`, `remote-mtp-protocol.h:548`); RPC serves one client to completion.
6. Fatal on timeout, no reconnect or backoff (`remote-mtp-protocol.h:435-446`, `:375-377`). At 1 % loss an 82 KB request (~57 segments) has ~44 % chance of at least one loss per message; each becomes an RTO stall or a killed session.
7. ggml RPC is remotely exploitable by design on an open socket: attacker-controlled writes to FNV-1a-named cache files (`ggml-rpc.cpp:1153-1160`) and `GGML_ASSERT` on deserialized tensors (`:1100`).
8. Payload asymmetry unexploited: 20 KB up, 43 bytes down per draft; at 20 Mbit/s uplink the serialization alone is 8 ms per row.

### C. MoE split mechanics (engine cannot express the goal)

1. Expert-parallelism is blocked, not slow: experts are one fused tensor per layer and `tensor_buft_overrides` match by name (`llama-model-loader.cpp:1185-1200`). Slicing needs a new loader path, a sharded `ggml_mul_mat_id`, and a gather/reduce.
2. No asynchronous transport: every RPC async hook is NULL (`ggml-rpc.cpp:752-756`), cross-socket copies are refused (`:529-530`), scheduler splits run serially (`ggml-backend.cpp:1604`). This is the mechanism behind the 462 ms.
3. No collective operations anywhere; tensor-parallel is a slowdown by construction.
4. Hyper-connection width (10240) is absent from every plan and byte estimate in the repo; all layer-cut estimates are 4× low.
5. Recurrent state in 36 layers pins a sequence to one owner across tokens; migration and failover cost is undiscussed.
6. The PLE table (28.8 GB, random gathers, host hashing) anchors the model to a single node.
7. The fixed 38 ms per step is unquantified but the code names the trigger: with `kv_unified` the sparse-attention gather is disabled (`gather = n_tps == 1 && flash_attn`, `qwen4exp.cpp:943`) and a masked read "costs exactly as much as dense attention" (`:1080-1085`); production logs the warning. Probably the largest local win, never measured.
8. Every measurement is at c1 or c4; the regime where replicas pay (high concurrency) has one data point (c8 76.9 tok/s).

### D. Engineering readiness (evidence chain is one laptop)

1. The core protocol lived only in `/tmp` worktrees (rescued today to `sin-harness/proofs/remote-mtp-src/`, untracked).
2. Signed evidence and Ed25519 keys are gitignored (`sin-harness/data/`, 34 evidence windows, 209 certificates, keys `drwx------`); third parties cannot verify anything, and losing the laptop breaks the signer fingerprint chain.
3. The release tarball (236 files) ships five patches and zero remote-MTP sources; the headline physical claim is not reproducible from the release.
4. The one committed signed manifest records `gitDirty: true`.
5. The site omits the measured loss (mesh 54.2 vs local 66.4 tok/s at c4); README is honest, the site is not.
6. The authoritative handoff (1824 lines) is wrong on four points corrected only by an uncommitted 117-line addendum.
7. CI: one 29-second hermetic run; no patch, model, or hardware path is exercised; every performance claim is outside CI.
8. The repo went public today (08:56 UTC) under a license counsel has not reviewed.

### E. Prior art

See §4 (filled from the prior-art audit).

## 3. What the goal can realistically become

Three defensible product shapes remain after the arithmetic; the current code serves none of them yet.

1. **Replica mesh with smart request routing.** Nodes that can hold the whole model (or a smaller MoE) serve complete requests; the orchestration layer does placement of *requests*, not tensors: capability registry, latency-aware routing, KV-affinity for multi-turn, health and churn. Zero per-token network hops, linear scaling, works over the internet today. Needs everything in §2A and §2B, nothing in §2C.
2. **Capacity split for models too large for any node, at batch-amortized throughput.** Pipeline by whole layer groups across few nodes (4, not 48) with asynchronous transport and micro-batching across many concurrent requests so that the 20 KiB per token per hop is amortized. Interactive latency is sacrificed; throughput per dollar is the metric. Needs §2C items 2 and 3 (async RPC, then collectives) before any orchestration work pays.
3. **Expert-parallel over WAN.** Not viable for this architecture at any batch size the project can generate: 96 serial hops per token, experts un-sliceable without engine surgery, and the repo's own kill criterion. Should be closed formally, the way the Legion drafting path was closed today.

## 4. Prior-art lessons

| System | Split | Bytes/token/hop | RTT tolerance | Achieved | Churn | NAT |
|---|---|---|---|---|---|---|
| Petals (BLOOM-176B) | pipeline, whole layer blocks | ~24 KiB fp16, quantized blockwise | 1.66 to 1.23 steps/s from <5 ms to 100 ms RTT | 0.83 steps/s over 14 geo-distributed servers; ~6 tok/s Llama-2-70B | client caches activations and reroutes; 2.17 steps/s at 1 % failure | libp2p circuit relay |
| exo | pipeline ring, LAN | <4 KB (3B model) | LAN only | 39.7 single-request on 3 nodes vs 49.3 on one; 108.8 multi-request | none | UDP broadcast, LAN only |
| llama.cpp RPC | tensor/graph offload | full tensors + per-graph metadata storm | synchronous, RTT-multiplied | 180 tok/s PCIe drops to 80 to 130 | none | none; README says never on an open network |
| Parallax (Gradient) | pipeline, two-phase scheduler | activations per stage | real volunteer WAN | 5.3× lower inter-token latency and 3.1× throughput vs Petals on Qwen2.5-72B; serves DeepSeek V3.2 and Qwen3-A3B MoE | dynamic join/leave | Lattica (QUIC + libp2p), ~70 % hole punch, ~30 % relay |
| SpecEdge | speculation, token ids only | bytes | 36.5 ms ITL at 15 ms RTT, 44.5 ms at 65 ms (+22 %) | 2.22× server throughput; beats layer-split 2.73× at 15 ms and 3.35× at 50 ms RTT | n/a | n/a |
| DSD (decentralized speculative decoding) | pipeline + k-token batched verify | activations once per k tokens | wins when 3·t_compute < t_link < 10·t_compute | 2.56 to 3.60× speedup, ~37 % less communication at 8 nodes | n/a | InfiniBand |
| DeepEP / vLLM wide-EP | expert-parallel all-to-all | ~7 KB per token per layer dispatch + combine | microseconds: 121 µs per round on 400 Gbit/s InfiniBand | 22.3k tok/s per node on 96 H100 | n/a | NVLink/IB only |

What the field concluded about MoE over WAN, with numbers:

- All-to-all is the bottleneck even inside a datacenter; expert-parallel latency grows linearly with device count and all-to-all can exceed half of inference latency (DeepSpeed-MoE, https://ar5iv.labs.arxiv.org/html/2201.05596).
- The datacenter dispatch budget is 121 µs per layer (DeepEP, https://github.com/deepseek-ai/DeepEP). A 20 ms Wi-Fi round trip is ~165× that; 50 ms WAN is ~400×. Three orders of magnitude, not a tuning gap.
- Expert routing is Zipfian; static placement guarantees hot-node stalls (two experts absorbing 64 % of a layer's tokens; the EP load balancer alone worth 1.49× prefill and 2.54× decode, https://www.lmsys.org/blog/2025-05-05-large-scale-ep/). With 512 experts and 10 active, this project has no popularity signal at all (§2A.5).
- Edge systems that work move *weights* (prefetched expert offloading, amortized over many tokens), not per-token activations.
- This project's own physical split matrix agrees: a single Legion beat the best two-node split at batch 4 and 16.

Lessons not yet absorbed, ranked (each with a source):

1. Batched-verification speculation is the only proven WAN RTT amortizer: verify k tokens per sync round, not k rounds (https://arxiv.org/html/2511.11733). The project's win condition per that paper: 3·t_compute < t_link < 10·t_compute; with t_compute ≈ 40 ms and WAN 50 to 150 ms it sits at the lower edge, which is exactly where its n=1 result landed.
2. Layer-splitting over WAN is a measured dead end (SpecEdge vs layer-split 2.73× at 15 ms, 3.35× at 50 ms, https://arxiv.org/html/2505.17052).
3. Draft depth must adapt to measured RTT (SpecEdge: 7 passes at 15 ms, 4 at 50 ms). This project has fixed n and no RTT-adaptive policy.
4. Optimize latency, never bandwidth (Petals: 100 Mbit/s to 1 Gbit/s nearly free, 5 to 100 ms RTT costs 26 %, https://ar5iv.labs.arxiv.org/html/2312.08361).
5. Transport must be asynchronous and pipelined; llama.cpp RPC is neither and loses 28 to 55 % on decode from its request-wait-response loop (https://github.com/ggml-org/llama.cpp/issues/22850).
6. Never expose llama.cpp RPC on a network (its own README, https://github.com/ggml-org/llama.cpp/blob/master/tools/rpc/README.md). §2B.7 shows why.
7. Budget for ~30 % of peers needing relay with worst-case RTT (4.4M hole-punch attempts across 85k networks, ~70 % success, TCP and QUIC indistinguishable, https://arxiv.org/abs/2604.12484).
8. Client-side activation caching plus reroute is what makes churn survivable (Petals held 2.17 steps/s at 1 % failure where restart-based designs collapse). This project restarts everything on any membership change (§2A.3).

## 5. Ordered next steps

1. **Decide the topology, in writing, before any more code.** The arithmetic leaves two shapes: replica mesh with request routing (interactive, internet-viable now) or few-node layer pipeline with batched speculation (capacity for models too large for one node, throughput not latency). Close expert-parallel over WAN formally, as the repo's own kill criterion already requires.
2. **Build the control plane the site already claims.** Node registry with capability advertisement (VRAM, RAM, measured bandwidth and RTT to peers, model residency), heartbeats, join/leave, epoch transition with drain (two-phase, not hash-and-restart), request-level scheduler with queueing and admission control. None of this exists; all of it is topology-independent.
3. **Replace the transport.** Per-node identity (Ed25519 already present for artifacts; bind it to the channel), encrypted authenticated frames (Noise or QUIC/TLS), multiplexed streams with unbounded in-flight messages, reconnect with backoff, NAT traversal with relay fallback. Adopt Lattica or libp2p rather than extending the SSH-tunnel model. Keep the bounded parser and epoch binding, which are good.
4. **Fix the engine before any split work.** Asynchronous RPC (the NULL hooks in `ggml-rpc.cpp:752-756`) and cross-socket copies remove the measured 462 ms per boundary; without them every pipeline number is meaningless. Expert slicing needs a loader path and a sharded `mul_mat_id`; do it only if topology 2 is chosen.
5. **Measure the fixed 38 ms.** Same 4-token verify at ctx 512 vs 8192, then with `kv_unified` off so the sparse-attention gather re-enables. If the fixed term collapses, production is leaving 30 to 40 % on the table today by running dense attention, which is a bigger win than any mesh result so far.
6. **Measure a real WAN.** Replace the loopback `time.sleep` profile with one Legion on a remote network (any VPS or a phone hotspot), and relabel `RESULTS_GRID.md:15` from measured to simulated until then.
7. **Make the evidence chain survive the laptop.** Commit `sin-harness/proofs/remote-mtp-src/` (rescued today), commit the addendum and this audit, publish evidence directories and public keys (keys stay private but fingerprints and signed manifests go public), fix the `gitDirty: true` manifest by regenerating from a clean commit, and add a CI job that at least applies the patches and builds the remote-MTP targets.
8. **Align the public story.** The site claims a scoring planner and re-placement on node loss; neither exists. Either ship them or move the claims to the roadmap. Add the measured c4 loss to the proof page. Get counsel on the license before the next push.
9. **Local wins that do not need the mesh, in order:** Docker VM reservation 28 GB to ~12 GB (production 46 to ~60 tok/s); local MTP n=1 on llama-server (predicted ~71 tok/s, +18 %); `kv_unified` experiment from step 5.
10. **Keep the Legions as what they proved to be:** a LAN proof-of-concept rig for protocol correctness, failover semantics, and capacity splits, not a performance platform. The keepalive fix (5× mesh request latency) should still be made durable on both.
