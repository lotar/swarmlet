# Kimi K3 on sovereign 16-GB expert nodes

Status: architecture researched by 10 independent lanes; bounded true-expert
proof implemented and green. Frontier checkpoint was NOT downloaded or loaded.

## Decision

True expert ownership is viable only inside a low-latency regional inference
cell. A Europe-wide service should route whole requests among complete cells;
it must not route each transformer layer's expert activations across Europe.

```text
Global API / request router
        |
        +---- complete regional cell (sub-ms fabric) -----------------+
        |                                                              |
        |  backbone group                     expert fabric             |
        |  attention/KDA/MLA/KV/router         16-GB workers             |
        |  shared experts/down+up projection   disjoint (layer,expert)   |
        |             | top-16 packed latent batches |                  |
        |             +--------------------------->  |                  |
        |             | <------- weighted partials  |                  |
        +--------------------------------------------------------------+
        |
        +---- other complete cells across Europe (whole requests only)
```

## Official Kimi K3 facts

Primary sources: [technical report](https://arxiv.org/html/2607.24653v1),
[checkpoint](https://huggingface.co/moonshotai/Kimi-K3), and released
`config.json`.

| Property | Value |
|---|---:|
| Total / active parameters | 2.78T / 104.2B |
| Layers | 93 (1 dense + 92 MoE) |
| Routed experts per MoE layer | 896 |
| Selected experts per token/layer | 16 |
| Shared experts per layer | 2 |
| Hidden / routed latent width | 7168 / 3584 |
| Expert intermediate width | 3072 |
| Published repository size | ~1.42 TiB |
| Routed expert weights | native MXFP4; activations MXFP8 |

One layer-specific routed expert has three matrices and 33,030,144 parameters.
At native MXFP4 plus scales it occupies approximately 16.73 MiB. There are
`92 × 896 = 82,432` independent layer-expert instances.

## 16-GB capacity

Reserve 4 GiB/card for runtime, communication, workspaces and fragmentation;
use at most 12 GiB for resident expert weights.

| Capacity item | Estimate |
|---|---:|
| Expert instances per 16-GiB card | ~734 |
| Expert-only cards, one copy | ~113 |
| Backbone/attention/KV cards | ~14–18 |
| First usable nonredundant cell | ~130–150 cards |
| Full 2× expert availability | ~250–270 cards |

One fixed expert ID across all 92 layers is about 1.50 GiB, so a card can hold
roughly seven full-depth expert IDs under the 12-GiB budget. Placement is still
by `(layer, expert_id)`; same-numbered experts in different layers are distinct.

## Network lower bound

K3 routes a 3584-element latent to top-16 experts and receives the same-sized
partials over 92 serial MoE layers.

| Activation format | Ideal traffic/token |
|---|---:|
| FP8/INT8 | ~10.06 MiB |
| BF16 | ~20.13 MiB |

There is approximately one dispatch/reduce RTT per MoE layer: **92 RTT/token**.
At 20-ms RTT the network-only ceiling is ~0.54 tok/s even at 100 GbE. For
10 tok/s, all network work must fit below roughly 1 ms per layer. Therefore:

- expert cell: sub-ms fabric, persistent packed all-to-all, preferably
  25/100GbE RDMA-class networking;
- Europe: whole-request routing, signed artifacts/certificates only;
- never expose llama.cpp RPC directly: its own README calls it fragile and
  insecure, and it lacks expert-ID dispatch semantics.

## Current llama.cpp gap

K3 support exists in pinned llama.cpp, but each layer's 896 experts are fused
into monolithic 3-D gate/up/down tensors (`src/models/kimi-k3.cpp`). Existing
`--override-tensor` placement therefore moves a complete layer expert bank, not
one `(layer, expert_id)`.

Production requires either:

1. repack checkpoint expert banks into independently addressable tensors; or
2. add slice-backed expert ownership, top-k batched dispatch and deterministic
   reduction to ggml; or
3. use a runtime with native expert parallelism (vLLM/SGLang/DeepEP-class)
   and replace datacenter-only assumptions with authenticated heterogeneous
   membership and placement.

## Bounded true-expert proof

Implementation: `sin-harness/proofs/tiny-moe/` and
`test/tiny-moe-distributed.test.ts`.

- four explicit experts; hidden=8, intermediate=4, top-2;
- disjoint ownership: n1 `{0,3}`, n2 `{1}`, n3 `{2}`;
- each node is a separate Bun process and loads only its own fixture;
- coordinator owns router only, batches by owner and reduces in expert-ID order;
- application delays 6/8/11 ms; no Docker/model/GPU/download/build;
- monolithic reference exists only inside the test process.

### Proof results

| Assertion | Result |
|---|---:|
| Ownership disjoint and complete | pass |
| Foreign expert request rejected | pass |
| Exact top-2 routes match reference | pass |
| Output parity tolerance | ≤1e-12 |
| Transcript SHA-256 parity | exact |
| Owner loss | fail closed, no partial output |
| Exact owner restart | parity restored |
| Tests | 6/6 pass, 552 assertions |

| Tiny benchmark | Median | Throughput |
|---|---:|---:|
| Batch 1 | 9.24 ms | 108 tok/s |
| Batch 8 | 12.21 ms | 655 tok/s |
| Batch 32 | 13.23 ms | 2,419 tok/s |
| Batch 64 | 12.78 ms | 5,007 tok/s |
| 92 serial layers, batch 1 | 824.8 ms/token | **1.212 tok/s** |

The 92-layer result validates the WAN barrier model: batching raises aggregate
throughput, but serial decode latency remains dominated by layer barriers.

### Safety result

- proof-process incremental RSS: **127.5 MiB**;
- swap growth: **0 MiB**;
- no Docker workloads or models started;
- Docker Desktop background VM fluctuated +922 MiB independently, below the
  explicit 1-GiB test abort cap;
- all child processes terminated after the run.

## Real-weight Qwen3.8 Flash Next proxy

The next stage uses the already-resident `Qwen3.8 Flash Next UD-Q4_K_XL`
checkpoint rather than Kimi weights. Header metadata gives 48 layers, 512
experts/layer, top-10, hidden width 2560 and expert FFN width 640. GGUF stores
the expert dimension first in its raw data view, so one expert can be sliced
without reading the complete fused bank.

The service evaluates the real layer-0 router, extracts only its selected
top-10 actual expert slices, distributes them 4/3/3, executes real SiLU-gated
FFNs, performs deterministic routed reduction, then adds the actual local Qwen
shared expert and sigmoid gate. It compares the complete FFN branch against a
streamed monolithic reference.

| Qwen real-weight service result | Measurement |
|---|---:|
| Expert IDs selected by real router | 10 of 512 |
| Dequantized routed expert weights resident | 187.5 MiB |
| Complete FFN distributed/reference max error | 0 |
| MLX + FP16 binary LAN, batch 1 | 30.4 ms |
| MLX + FP16 binary EU 12/16/22ms, batch 1 | 51.5 ms |
| EU binary batch 16 | 58.2 ms / 274.7 tok/s aggregate |
| Projected 48-layer EU floor | 2.47 s/token (0.40 tok/s) |
| Peak sampled aggregate RSS delta / swap | 814.6 MiB / 0 MiB |
| Content-bound epoch | Ed25519 signed; enforced service→workers |
| FP16 binary vs NumPy reference max error | 1.21e-4 |
| Primary loss | exact cold replica succeeds in 334.8 ms |
| Primary+replica loss | fails closed |

This proves a reusable complete Qwen FFN service boundary, not full-model
logits: attention/SSM, residual, KV and sampling remain in the skeleton runtime.

## Staged implementation plan

1. **Done — protocol semantics:** disjoint expert ownership, true top-k routing,
   batched dispatch/reduce, parity, WAN barriers and fail-closed churn.
2. **Done — real MoE service:** Qwen layer-0 actual router + top-10 Q4
   expert slices + shared expert/gate on MLX, signed epochs, FP16 binary frames,
   exact replica/fail-closed dual loss, under an 815-MiB sampled peak.
3. **Compiled — llama graph hook; live validation pending:** an opt-in
   `ggml_map_custom1` patch replaces Qwen4Exp layer-0 `build_moe_ffn` with
   `/v1/ffn-bin`. A separate llama-server at commit `dfa0c0f` compiles cleanly.
   Restart the active 104-GB model only in a maintenance window, then compare
   full layer/logits against the unmodified server.
4. **Regional LAN cell:** persistent binary connections,
   one packed dispatch/return per owner/layer, continuous batching, p50/p99
   barrier telemetry, exact replicas and signed placement epochs.
5. **16-GB hardware validation:** test native/fused MXFP4 kernels, 12-GiB weight
   budget, 4-GiB runtime reserve, compressed MLA cache and exact target GPU SKU.
6. **K3 metadata-only planner:** parse checkpoint indexes (not weights), emit a
   signed `(layer,expert)->primary+replica` manifest and validate bin packing.
7. **Frontier cell:** scale only after p99 layer network <1 ms, exact parity,
   hot-expert balancing, replica failover and cost criteria pass.
8. **European federation:** deploy complete regional cells; route requests by
   locality/capacity. Consider contiguous coarse pipeline stages or speculative
   block verification only if complete replication is unaffordable.

## Disk-streaming experiment

A real Qwen GGUF expert store now uses `pread` + `F_NOCACHE`, a hard bounded
cache, continuous RSS/free/swap guards and pinned-hotset policy. Actual Qwen
48-layer selected routes fit under 16 GB: worst tested changed-route pass peaked
at 8.12 GiB RSS with an 8-GiB cache and zero safety breach.

Naive 512-MiB LRU had zero second-token hits; pinned 8-GiB stable routes hit
436/528 entries and reduced expert preparation from 6.47 to 1.00 seconds.
Changed routes hit only 55/528 and took 5.49 seconds. Disk pread was ~0.1 s;
F32 dequantization/cache churn dominated.

For Kimi, sequential top-16 MXFP4 activations are ~267 MiB/layer and fit easily,
but the 92-layer selected working set is ~25.8 GB compressed. A 16-GB node must
pin hot experts and stream misses layer-by-layer. Naive cold projection from the
measured compressed-to-ready rate is ~0.01 tok/s. Production requires compressed
GPU cache, fused MXFP4 kernels and asynchronous prefetch; disk streaming solves
capacity, not interactive latency.

See `sin-harness/proofs/qwen-disk-experts/`.

## Kill criteria

Stop or redesign if any holds:

- interactive design requires per-layer WAN traffic;
- p99 dispatch/reduce barrier >2 ms for 5 tok/s, or >1 ms for 10 tok/s;
- runtime cannot address individual experts without materializing full banks;
- expert+runtime exceeds 16 GiB with at least 20% headroom;
- expanded MLA KV is used instead of compressed latent cache;
- distributed logits fail declared quantization tolerance;
- owner loss emits partial/approximate output without explicit policy;
- consumer GPU lacks viable MXFP4/MXFP8 kernels;
- the ~130–150-card nonredundant cell is economically worse than a conventional
  tightly coupled deployment or hosted K3 API.
