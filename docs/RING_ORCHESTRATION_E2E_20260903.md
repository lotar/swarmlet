# Orchestrated implementation: pipelined RPC client, multi-graph cache, emulation rig, multi-stream ring benchmark

**Date:** 2026-09-03. **Who did what:** two Sonnet subagents implemented from written specifications (one on the llama.cpp lab tree, one on the Docker rig); the orchestrating session wrote the end-to-end tests, ran them independently, diagnosed failures, and re-specified. Nothing below is taken from an agent's report without a re-run by the orchestrator, except where marked.

## 1. What was built

| piece | where | what it does |
|---|---|---|
| pipelined RPC client | `/tmp/llama-upstream-lab/ggml/src/ggml-rpc/ggml-rpc.cpp`, `rpc_dispatcher` | with `GGML_RPC_PIPELINE=1`, a writer thread sends queued requests back to back and a reader thread consumes replies in order; several requests are on the wire at once instead of one. Default path byte-identical to upstream. |
| graph-uid race fix + multi-graph cache | same file, `ggml_backend_rpc_graph_compute`, `rpc_server::graph_recompute`, `ggml-rpc.h` | the reuse decision and the enqueue are now atomic per device (mutex); the server keeps 8 cached graphs per device keyed by graph uid (was 1, unkeyed); RECOMPUTE carries the uid; protocol major version 6 to 7. Fixes a pre-existing crash when several llama contexts share one RPC endpoint. |
| multi-stream ring benchmark | `/tmp/llama-upstream-lab/tools/ring-bench/` (`llama-ring-bench`) | one model, N llama contexts, one thread each, greedy argmax decoding, synchronized start; reports per-stream ms/token, aggregate tok/s, text per stream, JSON. |
| emulation rig | `sin-harness/rig/` (`Dockerfile`, `docker-compose.yml`, `entrypoint.sh`, `rig.sh`), `docs/RIG_EMULATION.md` | six `ggml-rpc-server` containers (CPU, arm64, 151 MB image, statically linked) with per-node netem one-way delay applied as 2x egress (ingress shaping is unavailable in the Docker Desktop kernel), 16 GB memory caps, published ports 50061-50066, `rig.sh up N / status / ping / baseline / down`. Fits the existing 6 GB Docker VM with the small model. |
| delay-line harness | scratchpad `e2e/delay-proxy.py`, `e2e/rpc-e2e.sh` | two local CPU rpc-servers behind a true delay line (first version slept per chunk and double-charged back-to-back requests; replaced), fits round trips per token from decode time at 0/20/40 ms one-way, checks byte-identical outputs across delays. |

## 2. End-to-end tests and results

### E2E-1: round trips per remote node (delay-line harness, Qwen3.5-2B, split 6/6/12 over two local rpc-servers)

| client | slope (round trips per token, two remote nodes) | outputs identical across delays | equal to baseline outputs |
|---|---|---|---|
| default | 2.25-2.32 | yes | yes |
| pipelined | 2.18-2.28 | yes | yes |

Result: a tie, and a correction to the design brief. In this tree GRAPH_COMPUTE and GRAPH_RECOMPUTE carry no reply (verified in the client call sites and the server switch), so a cached-graph hop already costs one round trip with the default client: SET and RECOMPUTE are one-way, only GET_TENSOR waits. The pipelined client therefore changes nothing for a single stream. The agent's per-message timeline (trace behind `GGML_RPC_PIPELINE_TRACE=1`) shows both clients at ~45 ms per hop at 20 ms one-way delay. The first harness version reported 3.2 for the default client; that number was the proxy double-charging back-to-back requests and is withdrawn.

### E2E-2: streams in flight on the six-node rig (Qwen3.5-2B, 3 layers per container, 6 on the M5; netem 8/8/8/8/20/20 ms one-way; orchestrator's own run)

| streams | default aggregate tok/s (per-stream ms/token) | pipelined aggregate tok/s (per-stream ms/token) | texts identical |
|---|---|---|---|
| 1 | 3.95 (193) | 4.19 (191) | yes |
| 4 | 9.12 (313) | 11.22 (270) | yes |
| 8 | 13.45 (420) | 18.35 and 20.18 (325, 316) | yes |

Agent's matrix (`sin-harness/rig/results/ringbench-v3-*.json`, three runs each at 4 and 8 streams): default 4.16 / 7.02 / 9.81 / 12.67 at 1 / 2 / 4 / 8 streams; pipelined 3.94 / 6.40 / 9.8-10.9 / 14.0-18.8. Zero crashes in six runs at 4 and 8 streams after the fix; before it, two crashes in four attempts at 4 streams (`GGML_ASSERT(i01 < ne01)` in the CPU backend's row indexing: the server had executed one context's RECOMPUTE on another context's cached graph).

Reading: aggregate throughput scales with streams in flight on both clients, because streams block on different endpoints most of the time; the pipelined client adds 23 % at 4 streams and 37-50 % at 8 (head-of-line blocking on shared sockets grows with stream count). Per-stream latency is the ring trip and does not improve with either client, as expected.

### E2E-3: real ring over the public internet (M5 + both Legions, Qwen3.6-35B-A3B Q4_K_M, 4/4/32, plain greedy decoding, 48 tokens per stream)

Two production windows, interleaved pairs in the second (pipelined first, then default, at 8, 4, 8, 2 streams). Every run's per-stream text is identical across all runs at the same stream count (default and pipelined, both windows). Aggregate tok/s, per-stream median ms per token in parentheses.

| streams | default client | pipelined client |
|---|---|---|
| 1 | 5.45 (157) | 4.71 (176), single-stream jitter |
| 2 | 7.26 (222), 7.66 (204) | 5.76 (345), 7.49 (229) |
| 4 | 7.34 (459), 7.50 (453) | 9.04 (394), 8.33 (439) |
| 8 | 9.04 (738), 10.39 (664) | 15.12 (478), 16.25 (441) |

Reading: with the default client the real ring saturates at about 7.5 tok/s from two streams on; every stream shares the same two tunnel sockets, and a blocking GET on one stream holds the others' requests. The pipelined client keeps scaling: 8 streams give 15-16 tok/s aggregate, 1.6x the default at the same stream count and 3x the single-stream number, at 440-480 ms per stream. Single- and two-stream numbers are a tie within jitter, as on the rig. Evidence: `sin-harness/data/legion-goal/q36-ringbench-real-20260903T085604Z` (window 1), `q36-ringbench-real-20260903T090213Z` (aborted window, one run: pipelined 8 streams 12.56), `q36-ringbench-real-20260903T090425Z` (window 2, eight runs).

Combined with the previous document's speculative results (lossless MTP chain 7: 39 tok/s single stream on the two-node split), the picture for the internet ring is now: per-stream speed comes from tokens per trip (speculation) and from hop count; aggregate throughput comes from streams in flight, which needs the pipelined dispatcher and the graph cache fix to be correct and to scale.

## 3. Corrections to earlier attributions

- Each remote node costs one round trip per token already; "two to three round trips per hop" from the earlier analysis was wrong. A Legion hop with a 4-layer slab of the small model measured 19-23 ms per token on the LAN (8 ms round trip plus a few ms of compute) and ~65 ms per token through the Cloudflare tunnel in the earlier three-node frame logs (35 ms round trip plus tunnel software and Legion time). CUDA graph re-capture on the Legion is not a factor (graphs on 18.8, off 21.9, on 23.0 ms per token, within noise).
- The scheduler-side "pipelined copy" toggle (`GGML_SCHED_PIPELINED_COPY`) changes nothing on its own; it is only meaningful together with the writer/reader dispatcher and only under multi-stream load.
- The measurable value of the client work is (1) correctness for several contexts on one endpoint (race fix, graph cache) and (2) aggregate throughput with streams in flight. Single-stream speed over the internet remains what speculation and hop count make it (39 tok/s on the two-node split, 18 on the three-node ring, from the previous document).

## 4. Process notes worth keeping

- The lesser model found the two most important facts on its own and reported them against the brief's premise: compute commands have no reply, and the crash was a real race. Both were verified here before use.
- Two harness defects were the orchestrator's: the per-chunk delay proxy and the egress-only netem (found by the rig agent from its own numbers). Both fixed and documented.
- Windows on production were held to two for the real-ring runs (a third was aborted by an operator scripting error after one run); everything else ran beside production with the 2 GB model.

## 5. Files and evidence

Lab tree diff (uncommitted, `git -C /tmp/llama-upstream-lab diff --stat`): `ggml/include/ggml-rpc.h` (+10), `ggml/src/ggml-rpc/ggml-rpc.cpp` (+306), `ggml/src/ggml-backend.cpp` (+16, earlier), `tools/CMakeLists.txt` (+1), `tools/ring-bench/` (new); earlier patches in `src/llama-context.cpp`, `src/llama-model-loader.cpp`. Both Legions rebuilt with the protocol-7 server (`~/llama-upstream-lab/build/bin/ggml-rpc-server`). Results: `sin-harness/rig/results/` (JSON per run), scratchpad `e2e/out-*` (harness), `e2e/rb-*.json` (orchestrator's rig run), `sin-harness/data/legion-goal/q36-ringbench-real-*` (real ring).
