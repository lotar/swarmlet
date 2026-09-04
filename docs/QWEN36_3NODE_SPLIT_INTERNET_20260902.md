# Qwen3.6-35B-A3B on three nodes over the public internet: even split vs whole-model replicas

**Goal (2026-09-02):** find a Qwen 3.6 quant that fits the Legions, download it to the Legions and the M5, split it evenly across the three nodes, and reach 20+ tok/s per stream (ideally 50+) over the public internet.  
**Outcome:** downloaded and verified on all three nodes; even 3-way split built and measured on LAN and over the real internet; the even split (CPU slabs) tops out at **6.4 tok/s per stream on LAN and 3.6 over the internet**; the largest GPU-resident split (12 layers per Legion card, 16 on the M5) reaches **9.7 on LAN and 4.5 over the internet**. The same file served whole on each node clears the target: **M5 104 tok/s, each Legion 19 to 26 tok/s per stream through the public internet**, 38 to 62 tok/s across the two Legions and 150+ across all three. The physics of three serial internet hops per token caps any even 3-node layer split at 9.5 tok/s before compute, and this GGUF carries no MTP draft tensors, so there is no multi-token-per-hop lever.

## 1. Model

| | |
|---|---|
| File | `unsloth/Qwen3.6-35B-A3B-GGUF` → `Qwen3.6-35B-A3B-UD-IQ2_XXS.gguf`, 10,756,586,464 bytes |
| sha256 (matches Hugging Face LFS on all three nodes) | `2e8f5f705355c56311432d0a8a5d14a696dbb7e4b197d05c75ba805fc1857bef` |
| Architecture | `qwen35moe`, 40 layers, hidden 2048, 256 experts / 8 active (3B active), full attention every 4th layer, rest linear attention; no `nextn`/MTP tensors in this GGUF |
| Per-layer weight bytes (from the GGUF tensor table) | ~0.25 GiB; even split by layers 13 / 13 / 14 ≈ 3.3 / 3.3 / 3.5 GiB |
| Boundary payload per token | 2048 × F16 = 4 KiB (five times smaller than Flash-Next's 20 KiB) |
| Locations | M5 `/Users/lotar/projects/local-llm/models/qwen3.6-35b-a3b/`; Legions `/home/lotar/models/qwen36/` |

Qwen 3.6 ships as 35B-A3B (MoE) and 27B dense only; the smallest 35B quant is UD-IQ1_M (10.05 GB), IQ2_XXS was chosen as the smallest quant above the 1-bit floor. The 27B dense would be 9.4 GB at IQ2_XXS and 27B active per token, far slower on the Legions.

## 2. Transport: a real TCP path over the public internet for ggml RPC

ggml RPC needs raw TCP; Cloudflare quick tunnels carry HTTP/WebSocket only. Each Legion runs `websocat ws-l:127.0.0.1:50300 → tcp:127.0.0.1:50200` (the rpc-server) behind a quick tunnel; the M5 runs `websocat tcp-l:127.0.0.1:5220x → wss://<name>.trycloudflare.com`. Same public IP on all three machines, so every byte goes out to Cloudflare's Zagreb edge and back. Measured through the mirror endpoint (echo), persistent connection:

| Payload | Legion 1 p50 / p95 | Legion 2 p50 / p95 |
|---|---|---|
| 4 KiB round trip | 35.5 / 37.7 ms | 35.5 / 40.5 ms |
| 20 KiB round trip | 49.2 / 60.0 ms | 64.3 / 87.9 ms |
| first connection | 237 ms | 401 ms |

This is 4× cheaper per boundary than the HTTP-request path measured earlier today (141 ms p50 for 20 KiB), because the WebSocket pays TLS and HTTP framing once per connection instead of once per request.

## 3. Results (all measured today, greedy, 64 to 96 new tokens)

### 3a. Even 3-node split (Legion 1 layers 0–12, Legion 2 layers 13–25, M5 layers 26–39 + output)

Legion slabs run from RAM on CPU (10 threads) as ggml RPC devices: 13 full layers (≈3.3 GiB) plus KV and scratch do not fit the 4 GB cards (the hybrid test in 3c overflowed already with 10 expert layers + attention). M5 runs its 14 layers on Metal. Upstream llama.cpp `9400c89` server with `--rpc`, `--device RPC0,RPC1,MTL0 --tensor-split 13,13,14`, one production-stop window. Evidence: `sin-harness/data/legion-goal/q36-split13_13_14-CPU-20260902T211523Z/` (LAN + internet), `…-20260902T211409Z/` (M5 reference).

| Path between nodes | c1 per stream | c4 per stream | c4 aggregate | prompt eval (c4) | load time |
|---|---|---|---|---|---|
| Wi-Fi LAN (SSH forwards) | **6.37 tok/s** (157 ms/token) | 2.43 | 5.72 | 1.57 s per prompt token | 218 s (weights shipped over Wi-Fi) |
| public internet (WebSocket via Cloudflare) | **3.58 tok/s** (279 ms/token) | 2.51 | 4.21 | 2.24 s per prompt token | 54 s (rpc-server `-c` local cache hit) |

Internet minus LAN: 122 ms per token over 3 boundaries = 41 ms per boundary, consistent with the 35 ms WebSocket round trip plus one RPC exchange per boundary.

### 3a-bis. Largest GPU-resident split: 12 layers on each Legion card, 16 on the M5 (retest requested after 3a)

Same rig, Legion slabs on CUDA (`ggml-rpc-server -d CUDA0 -c`). 12 layers is the most that fits: Legion 1 3423 MiB / 4096, Legion 2 3161 MiB / 4096 with KV and scratch; 13 layers overflowed. Evidence: `q36-split-12_12_16_10_10_20_8_8_24-CUDA0-20260902T213544Z/` (LAN), `q36-split-12_12_16-CUDA0-20260902T215233Z/` (internet).

| Path between nodes | c1 per stream | c4 per stream | c4 aggregate | load time |
|---|---|---|---|---|
| Wi-Fi LAN (SSH forwards) | **9.72 tok/s** (103 ms/token) | 5.54 | 8.57 | 37 s (cache) |
| public internet (WebSocket via Cloudflare, keepalive pings) | **4.48 tok/s** (223 ms/token) | 3.12 | 4.93 | 70 s (cache) |

GPU slabs cut the LAN time per token from 157 to 103 ms (Legion compute 13 layers on CPU → 12 on GPU) and batch better (c4 aggregate 8.6 vs 5.7). The internet penalty is unchanged: 120 ms per token over three hops, 40 ms per hop. Two internet attempts before this one aborted ~150 s into the load with `Remote RPC server crashed or returned malformed response`: the RPC client keeps one long-lived socket per endpoint and, while it streams one Legion's tensors, the other Legion's WebSocket sits idle past Cloudflare's idle timeout and is closed. `websocat --ping-interval 20 --ping-timeout 90` on both ends of each bridge fixed it (the CPU-slab run earlier got through only because its 54 s load never left a socket idle that long).

### 3b. M5 whole model (reference, same window)

| | c1 | c4 |
|---|---|---|
| M5 Metal, all 40 layers | **104 tok/s** per stream | 48 per stream, 167 aggregate |

### 3c. Legion whole model, hybrid placement (attention + a few expert layers on the GPU, the rest of the experts on CPU)

| `--n-cpu-moe` | VRAM | c1 (L1 / L2) | c4 per stream (L1 / L2) |
|---|---|---|---|
| 40 (all experts on CPU) | 2.0 GB | 27.0 / 27.2 | 9.5 / 8.2 |
| **34** | 3.4 GB | **29.8 / 28.3** | 10.7 / 9.1 |
| 30, 26 | over 4 GB | fails to load | |

### 3d. Legion replicas through the public internet (Cloudflare quick tunnels, both Legions driven in parallel, client-observed)

Evidence: `sin-harness/data/legion-goal/q36-replica-internet-20260902T211332Z/`.

| streams per Legion | L1 per stream (server / client) | L2 per stream (server / client) | TTFT | two-Legion total |
|---|---|---|---|---|
| 1 | 29.6 / **25.6** | 22.5 / **19.0** | 0.5 / 0.8 s | 37.9 tok/s |
| 2 | 16.8 / 15.0 | 17.3 / 15.2 | 0.7 / 0.8 s | 60.0 |
| 4 | 9.2 / 8.2 | 9.4 / 7.8 | 1.4 / 2.2 s | 62.5 |

The Legion is CPU-bound on the experts (12 cores), so per-stream speed halves with each doubling of concurrency; a Legion holds the 20 tok/s line at one stream only.

## 4. Why the even split cannot reach 20 tok/s over the internet

Per generated token an even 3-node layer split makes three serial hops (M5 → L1 → L2 → M5). Measured today:

```
internet, zero compute, zero protocol:  3 × 35 ms  = 105 ms/token  →  9.5 tok/s ceiling
measured with compute + RPC:            279 ms/token               →  3.6 tok/s
20 tok/s needs ≤ 50 ms/token; 50 tok/s needs ≤ 20 ms/token
```

Even on the LAN (7 ms hops) the split reached 157 ms per token: ~120 ms of that is RPC graph dispatch plus Legion CPU compute for 13 full layers, which the M5 does in 3.5 ms. The only mechanism that lowers hops per token is multi-token drafting per ring trip (MTP), and this GGUF has no MTP head; even at the 79 % single-draft acceptance measured on Flash-Next, the internet split would move from 3.6 to ~6.5 tok/s. With the Legion GPUs holding 12 layers each the LAN split reaches 9.7 tok/s and the internet split 4.5: the network share (120 ms per token over three hops) is now larger than all compute and dispatch combined (103 ms). The measured ranking today is exactly the ranking predicted this afternoon: replicas + request routing clear 20 tok/s per stream over the public internet; layer splits do not, on this model or on the 104 GB one.

## 5. What was left standing

Model files on all three nodes (verified), rpc-server tensor caches on both Legions (`~/.cache/llama.cpp/rpc`, ~3 GB each, make a re-split load 37 to 70 s instead of 218 s), `~/bin/websocat` on both Legions, `websocat` via brew on the M5. All tunnels, bridges, RPC workers and replica servers stopped; production `:8099` restored and healthy. Operator: scratchpad `q36-split-operator.sh` (ARMS=ref,lan,internet; SPLIT; RPC_DEV), replica tuning `legion-tune.sh`, internet client `internet-mesh-bench.py`.

To serve the replicas again: on each Legion `llama-server -m ~/models/qwen36/Qwen3.6-35B-A3B-UD-IQ2_XXS.gguf -ngl 999 --n-cpu-moe 34 -c 8192 --parallel 2 --kv-unified -fa on -t 10` (2 slots keep ≥15 tok/s per stream; 1 slot keeps ≥19).
