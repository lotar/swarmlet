# Feasibility: Qwen3.8-Flash-Next (104 GB) on eight 16 GB nodes over the internet

**Question:** can nodes with 16 GB RAM and a 4 GB-class GPU, joined over the public internet, run the 104 GB model together, each computing its part, and would eight of them work?  
**Date:** 2026-09-02, measured on the Legions (16 GB RAM, GTX 1650 / 1650 Ti, Wi-Fi) as stand-ins for two of the eight, with the M5 standing in for the other six.

## 1. What each node has to hold (from the GGUF byte table, exact)

| Piece | Size |
|---|---|
| One trunk layer (routed experts 1.49 GiB + attention/DeltaNet/norms 0.08 GiB) | 1.57 GiB |
| 48 layers | 75.6 GiB |
| PLE n-gram table (belongs to layer 1, CPU-side sparse reads) | 26.8 GiB |
| Embeddings + output head | 1.26 GiB |
| Total | 103.7 GiB |

8-way split, 6 layers per node: **9.4 GiB of weights per node**, plus KV/state, plus compute scratch. The node that owns layer 1 also needs the 26.8 GiB PLE table: 36 GiB, over any 16 GB node. That node must be bigger, or the PLE table becomes a ninth service (16 random 160-value row reads per token, ~1.4 KB useful, which is exactly the kind of tiny per-token remote lookup that the per-boundary cost below makes expensive).

A 16 GB node with a 4 GB GPU cannot put its 9.4 GiB slab on the GPU. Measured today: even 2 layers (3.1 GiB) plus KV plus compute scratch overflowed the 3.7 GiB card. So on a 16 GB node the slab lives in RAM and runs on the CPU (13 GiB free on a Legion, 12 cores), or on a node with ≥12 GB VRAM it runs on the GPU.

## 2. What one boundary costs, measured

Every layer boundary moves 20 KiB per token (4 hyper-connection streams × 2560 × F16) and blocks the next layer. Per hop, per token:

| Path | 20 KiB round trip p50 / p95 |
|---|---|
| quiet Wi-Fi LAN, raw TCP or UDP | 6 to 9 ms |
| real internet via Cloudflare edge, persistent HTTPS connection, Legion 1 | **141 / 195 ms** (server floor 14 ms, so ~127 ms of internet path) |
| same, new TLS connection per request | 227 / 290 ms |
| ggml RPC protocol overhead per boundary on top of transport (measured in V4) | ~100 ms |

The Cloudflare path is the honest "public internet, NAT on both ends, no port forwarding" number. A direct UDP path between two well-connected homes in the same country would be 20 to 40 ms; across Europe 40 to 80 ms; that is the range below.

## 3. What one node's compute share costs

Measured: `sin-harness/data/legion-goal/pipeline-rpc-CPU-lan-split6_6_36-20260902T201609Z/`. Each Legion held a 6-layer slab (9.4 GiB) in RAM and computed it on CPU (10 threads) as an RPC device; the M5 held the other 36 layers; quiet Wi-Fi. Loading the two slabs over the Wi-Fi took 11.5 minutes.

| | per token | per stream |
|---|---|---|
| chain with two 6-layer CPU slabs, c1 | 398.7 ms | 2.51 tok/s |
| same chain with two 1-layer GPU slabs (earlier run, same 3 boundaries) | 266 ms | 3.76 |
| difference attributable to 12 layers of CPU compute (+ 10 fewer M5 layers) | ~139 ms | |
| **one 6-layer slab on a 16 GB node's CPU** | **~69 ms per token** | |
| c4 (4 concurrent streams) | 756 ms per token per stream | 1.32 per stream, 3.6 aggregate |

Prefill on a CPU slab is far worse: 331 ms per prompt token at c1, 2.0 s per prompt token at c4. A 500-token prompt would take 3 to 17 minutes to enter the ring.

Cross-check: the M5 does all 48 layers in ~60 ms on Metal (1.25 ms per layer); the Legion CPU does 6 layers in ~69 ms (11.5 ms per layer), about 9× slower per layer, consistent with DDR4 bandwidth versus unified memory on an M5 Max. A node with a ≥12 GB GPU would bring its slab to roughly 10 to 20 ms.

## 4. The arithmetic for eight nodes

Per generated token, the token must pass through all 8 nodes in order (a ring: node 8 sends the last hidden state back to node 1 for the next token), so:

```
time per token = 8 × (compute for 6 layers on the node) + 8 × (boundary cost)
```

With the measured boundary costs and the CPU slab time C (from §3):

| Network between nodes | boundary cost | 8 boundaries | tok/s if C were 0 |
|---|---|---|---|
| public internet via edge, persistent connection | 141 ms | 1.13 s | 0.9 |
| direct UDP, same country (estimate from the wan25 profile + 7 ms floor) | ~35 ms | 0.28 s | 3.6 |
| direct, same city fibre (~10 ms) | ~17 ms | 0.14 s | 7.4 |
| quiet LAN | 7 ms | 0.06 s | 18 |

Batching many concurrent requests raises aggregate throughput (each boundary carries a batch), but per-stream latency stays at the row above. With 32 concurrent streams and the LAN row, aggregate could approach 8 × node compute throughput; over the public internet it stays under 1 tok/s per stream regardless.

### Network-only bound, before any compute

Eight boundaries per token is the floor no engine can remove for a per-layer split (the trunk is a strict chain; hyper-connections carry 10240 values across every boundary). Measured today over the real public internet with a persistent connection: 141 ms per boundary p50. Eight of them: 1.13 s per token, **0.9 tok/s per stream at zero compute**. Even a well-engineered direct UDP mesh across one country (~35 ms per boundary) caps at 3.6 tok/s per stream before any node does any work; it takes a same-city fibre mesh (~17 ms) to reach 7 tok/s, and a LAN to reach 18.

### With compute included (C = 69 ms per node per token, measured)

```
time per token = 8 × 69 ms + 8 × boundary
```

| Network between the eight 16 GB nodes | time per token | per stream | note |
|---|---|---|---|
| public internet via edge, persistent connection (141 ms) | 1.68 s | 0.6 tok/s | measured boundary |
| direct UDP, same country (~35 ms) | 0.83 s | 1.2 | estimate |
| same-city fibre (~17 ms) | 0.69 s | 1.5 | estimate |
| quiet LAN (7 ms) | 0.61 s | 1.6 | measured boundary; compute-bound |
| same, nodes with ≥12 GB GPUs (C ≈ 15 ms) on a LAN | 0.18 s | 5.7 | |

Batching: c4 on the CPU slab gave 3.6 aggregate over 4 streams (per stream fell to 1.3), so 16 GB CPU nodes barely batch; aggregate scales sublinearly and prefill collapses.

## 5. Verdict

**Yes, the 104 GB model can run on eight 16 GB nodes over the internet, each computing its one-eighth share; it works in the sense that tokens come out. It does not work as a service: 0.6 tok/s per stream over the real internet, 1.6 on a LAN, with prompt ingestion measured in minutes.** Two independent limits, each alone sufficient:

1. Eight serial boundaries per token (irreducible for a layer split of this architecture): 1.13 s over the public internet measured today, 0.06 s even on a LAN.
2. A 16 GB node computes its 6-layer share on CPU at ~69 ms per token (measured), 9× slower per layer than the M5, and its 4 GB GPU cannot hold the slab (measured: 2 layers already overflow).

Plus the PLE table (26.8 GiB) that no 16 GB node can hold, and 11.5 minutes to place 12 GiB of weights over Wi-Fi (re-placement on churn is minutes).

What 16 GB nodes *can* do over the internet, measured today: serve a model they hold whole (Qwen3-4B: 21 to 23 tok/s per stream at 4 streams, 46 at 1, through Cloudflare's edge, flat from LAN to 100 ms / 2 % loss). The network shape that works is replicas plus request routing; per-layer distribution of a model this size needs nodes that can each hold at least a quarter of it on a fast GPU, on a single-digit-millisecond fabric.
