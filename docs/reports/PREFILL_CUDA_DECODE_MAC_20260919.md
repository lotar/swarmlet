# Prefill-on-CUDA + decode-on-Mac for Qwen3.8-27B — measured feasibility and levers

Date: 2026-09-19. Rig: this Mac (M5 Max, 128 GB, Metal) + lotar-legion (GTX 1650 Ti 4 GB, 15.9 GB RAM, CUDA 12.0)
+ lotar-legion-2 (GTX 1650 4 GB). All transport on the home Wi-Fi (LAN), admin token via
`~/.swarmlet/control/control.json`. Evidence: `~/.swarmlet/backups/pd-lab-20260919/` (harness `pd_bench.py`,
all `result.json` per run, `SUMMARY.json`, `parity-ubatch.json`, `before-production-3x.json`,
`after-production-mtp3.json`). Nothing in this campaign stayed running; production (`dep-4bcfade6e039`,
`:8100`) was never stopped and stayed healthy throughout.

## Question

Test the mesh's prefill-decode deployment with **prefill on CUDA and decode on this Mac for
Qwen3.8-27B**, then iterate options to raise overall speed, measuring before/after for prefill, decode, state
transfer and RTT.

## TL;DR

1. **The literal setup cannot run on this hardware.** The CUDA nodes cannot hold any mesh-supported 27B:
   Qwen3.8-27B-Q8_0 is 28.6 GB (Q4_K_M 19.0 GB) against 16 GB RAM + 4 GB VRAM per Legion, and no other
   CUDA host is on the LAN (the Windows node has Intel UHD only). The one 27B-class file that fits
   (Ternary Bonsai 7.2 GB) uses Prism's PQ2_0 tensor type 142, which the mesh engine does not implement
   (`GGML_TYPE_COUNT = 43`); its local server runs from Prism's own fork.
2. **The native P/D path is a qualified proof harness, not a fast path.** As shipped it uses one-token
   microbatches (`n_ubatch=1`), F32 KV and Flash-Attention off. On the 27B that makes prefill cost one full
   weight pass per token: **13.3 tok/s**, 29× below the production replica's 469–556 tok/s.
3. **A batched-prefill variant removes most of that cost**: 27B prefill **13.3 → 209.4 tok/s (15.8×)** and
   the CUDA 2B prefill **9.4 → 241.9 tok/s (25.7×)**, with identical greedy tokens across all cross-machine
   runs. The strict float gate fails (max_abs 0.0164 vs atol 1e-3), so shipping it needs re-qualification.
4. **After the prefill fix, the state-transfer leg dominates**: the control's 256 KiB JSON chunk loop moved
   the 27B capsule at 11.8–15.6 MiB/s locally, and the Wi-Fi link from a Legion back to the Mac runs at
   0.4–0.9 MB/s raw — the direction the capsule must travel. Direct binary transfer is 297× faster locally
   (26.2 s → 0.088 s) and 2.5× faster over the slow Wi-Fi leg.
5. **The only measured lever that could raise the live 27B decode did nothing**: MTP chain 3 accepted 47/47
   draft tokens and still decoded at 8.0 tok/s, inside the production replica's 8.1–10.8 tok/s range.

## 1. Fit check (why CUDA prefill cannot hold the model)

| candidate | file bytes | fits Legion (16 GB RAM + 4 GB VRAM)? | engine support |
|---|---:|---|---|
| Qwen3.8-27B Q8_0 | 28,595,763,552 | no (weights alone 27.3 GiB) | yes (`qwen35`) |
| Qwen3.8-27B Q4_K_M | 18,973,870,432 | no (17.7 GiB) | not in catalog/local store |
| Ternary Bonsai 2 27B PQ2_0 | 7,206,168,928 | yes (6.7 GiB) | **no — PQ2_0 type 142, engine max type 42** |
| Qwen3.5-2B Q8_0 | 2,012,012,800 | yes | yes (only working CUDA P/D today) |

Stage-lab worker identities: Legion 1 `--identity` = engine `fefcec45…`, CUDA build
`35b5bcf5…2b64` (the qualified binary); **Legion 2 = engine `f4a228e8…`** (`4d5c7582…`), a different source
state — a Legion-2 prefill capsule is rejected by the Mac with `state identity mismatch`, which is how that
mismatch was found. Legion 1 was also running a leaked `gnome-system-monitor` (12.4 GB RSS, 100 % swap);
freeing it restored 13 GiB available RAM. It is not needed by this campaign again.

## 2. Baseline (before)

Production replica `qwen3.8-27b` (Q8_0, MTL0, ctx 131072, parallel 4, chain 0, F16 KV, FA on, cache off),
360-token prompt, 64 output, temperature 0, 3 reps:

| metric | rep 1 | rep 2 | rep 3 |
|---|---:|---:|---:|
| prefill tok/s | 555.5 | 532.2 | 469.0 |
| TTFT (ms) | 648 | 677 | 768 |
| decode tok/s | 8.05 | 10.21 | 10.78 |

Native P/D baseline over the same HTTP protocol the control uses (`eval`/`export`/`state_read`/
`state_write`/`import`), 256-token prompt, ctx 1024, 8 greedy tokens:

| run | prefill tok/s | state | transfer | decode tok/s | total |
|---|---:|---:|---:|---:|---:|
| 27B Mac→Mac | 13.3 | 181.6 MiB | 27.1 s | 14.5 | 49.7 s |
| 2B CUDA(L1)→Mac | 9.4 | 25.3 MiB | 72.4 s | 47.4 | 100.2 s |
| 2B Mac→Mac | 106.0 | 23.8 MiB | 4.0 s | 36.4 | 6.4 s |

Reading: native decode is already at production parity (14.5 vs 8–11 tok/s single-stream; 47.4 for the 2B),
but native prefill is 29× (27B) / 11× (2B) slower because of `n_ubatch=1`, and the remote capsule transfer
runs at 0.36 MiB/s (Legion→Mac) versus 15.6 MiB/s for the same protocol locally.

## 3. Levers, measured

Variant source: `~/.swarmlet/backups/pd-lab-20260919/stages-v2/` (built on the Mac and on Legion 1 as
`~/stage-lab-v2`). Three changes, all in `worker.cpp` (+ `build.sh -j 2 → -j 4`):

```diff
-  ... b.logits[i]=1; }
+  ... b.logits[i]=(i+1==n)?1:0; }                       // LM head only for the last position
-  cp.n_ubatch=1; ... cp.n_threads=2; cp.n_threads_batch=2;
+  cp.n_ubatch=MAX_BATCH;                                 // batch the prompt, one graph per 64 tokens
+  {int mt=2;if(const char*me=std::getenv("MESH_THREADS")){...}cp.n_threads=mt;cp.n_threads_batch=mt;}
```

| lever | run | before | after | delta |
|---|---|---:|---:|---:|
| batched prefill (`ubatch=64`) + logits-last | 27B Mac→Mac | 13.3 tok/s | **209.4 tok/s** | **15.8×** |
| batched prefill + direct transfer | 27B Mac→Mac | 49.7 s total | **5.85 s total** | **8.5×** |
| batched prefill (CUDA) | 2B Legion-1→Mac | 9.4 tok/s | **241.9 tok/s** | **25.7×** |
| direct binary capsule transfer (local) | 27B Mac→Mac | 26.2 s | **0.088 s** | 297× (2,072 MiB/s) |
| direct binary capsule transfer (Wi-Fi) | 2B Legion-1→Mac | 70.2 s | 27.5 s | 2.5× (0.92 MiB/s, link-bound) |
| `MESH_THREADS` 2→8, CPU-resident layers | 2B Legion-1 `gpu=0` | 151.6 tok/s | 155.2 tok/s | +2 % |
| MTP chain 3 on the 27B replica | :8101, 100 % acceptance (47/47) | 8.05–10.78 tok/s | 7.98 tok/s (after 2 warmup reps of 1.1) | none |

Correctness: every P/D run above produced the identical greedy sequence
`[383, 279, 11012, 15822, 13721, 1345, 279, 14367]`, including the CUDA→Metal capsule transfer with the
batched-prefill variant. Numeric gate: same-backend ubatch 1 vs 64 prefill logits differ by
`max_abs 0.0164`, `mean 0.0022`, `p99 0.0072` — **fails the qualified `atol=1e-3`**, so the speedup cannot
ship without a re-qualification decision (tolerance is a project decision, not changed here).

## 4. Transport and RTT (LAN Wi-Fi)

| path | value |
|---|---|
| TCP connect Mac→Legion 1 / Legion 2 | med 7.96 / 8.62 ms (p90 8.23 / 9.85) |
| native worker HTTP RTT over SSH tunnel (L1) | med 14.3–16.8 ms (min 11.3, p90 21.1) |
| Mac→Legion copy | 8.4 MB/s (single stream) |
| Legion→Mac raw (the capsule direction) | **0.4–2.7 MB/s** (L1 0.86, L2 1.1–2.7), asymmetric |
| capsule effective rate, control-style JSON chunks | 0.36 MiB/s (L1→Mac) |
| control-measured node RTT / live replica `rttMs` | ~25–30 ms (WAN) / 40.4 ms |

The deployment's control loop also runs in the cloud: every native `eval` is one HTTP round trip through the
control's tunnel (~25–30 ms WAN), which is paid per 64-token prefill batch and per decode token. That is
cheap for prefill after batching and immaterial for decode next to the 69 ms/token model step, but it caps
anything interactive that stays on the current hosted control.

## 5. What would make the literal setup work

- A CUDA host with >= 24 GiB device memory for a Q4_K_M 27B endpoint (>= 40 GiB for Q8_0 + MTP + KV) and a
  GPU faster than the M5 Max's Metal for this model — otherwise CUDA prefill stays slower than Mac prefill
  even after the batching fix (the GTX 1650 Ti is 25× slower per weight pass than the M5 Max).
- Control integration for a non-2B native pair (all in `swarmlet/`): relax `profile==="qwen35-2b-q8"`,
  `EMBEDDING===2048`, `stage_total==="24"` (`stage-execution.ts`), ctx pinned to 1024 (`planner.ts`), the
  GPU-size reservation `ceil(sourceBytes)+workspace` that refuses any 27B on a 3.7 GiB device
  (`planner.ts` native fit), and add a qualification record + install `mesh-stage-worker` into each node's
  release engine dir (neither Legion advertises the `stages` engine capability today).
- Optionally, protocol work already justified by these numbers: binary/streamed capsule transfer instead of
  256 KiB JSON integer arrays, and a local control or agent-side execution of the P/D loop.

## 6. Reusable artifacts (post disk-cleanup, 2026-09-20)

The host disk cleanup of 2026-09-20 removed the heavy per-run directories and the summary JSONs below
`~/.swarmlet/backups/pd-lab-20260919/` (`SUMMARY.json`, `parity-ubatch.json`, `2b-metal-vs-cuda.json`,
`2b-hybrid-rpc.json`, `before-production-3x.json`, `after-production-mtp3.json`, and every per-run
`result.json` with its 373 MiB capsule copies). The numbers quoted in this report are the record now;
the raw runs are gone. What survives:

- `~/.swarmlet/backups/pd-lab-20260919/pd_bench.py` and `pd_lan.py` — the harnesses (phased local/remote
  P/D, direct transfer, RTT probe; and the Legion-prefill → M1-decode LAN run).
- Same dir: `lanes/` (the five exploration reports), `stages-v2/` (variant sources, engine `24172ff2…`),
  and the worker/bench `*.log` files.
- Legion 1: `~/stage-lab-v2/` — variant CUDA build (engine `24172ff2…`, binary `f04bbc2b…`) and its run dirs.
- Stale node releases (`macos-*`, `node-chat-*`, `node-processing-*`, `2026091902-ee66355a`) were pruned;
  only the active `2026091903-a54af5a6` remains.
- Legion 2 unchanged apart from an abandoned run dir under `~/.swarmlet/stage-lab/f4a228e8/runs/`.

## 7. Ternary Bonsai 2 27B — CUDA-only vs hybrid vs Mac-only (ctx 1024)

The mesh engine cannot load PQ2_0 (type 142; `GGML_TYPE_COUNT=43`), so Bonsai runs from Prism's own
runtime (`PrismML-Eng/llama.cpp` tag `prism-b10683-d8f26ee`). The official **Linux CUDA 12.4 x64** tarball
was fetched to both Legions (`~/prism/runtime`, CUDA0 visible, GTX 1650/1650 Ti); the 7,206,168,928-byte
model was copied to `~/swarmlet/models/` on both Legions and its SHA256
`3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1` verified on each. Prompt 360 tokens,
output 32, temperature 0, cache off, engine-reported timings:

| config | prefill tok/s | decode tok/s | TTFT | wall | notes |
|---|---:|---:|---:|---:|---|
| Mac only (`64,0,0`, M5 Max Metal) | 128.7–141.3 | 24.2–24.3 | 2.6–2.8 s | 3.9–4.1 s | ctx 1024 |
| Hybrid (`16,24,24`, Mac + 2 Legions **over Wi-Fi RPC**) | 3.2–4.4 | 0.62–0.98 | 83–114 s | 135–147 s | 48/64 layers remote, per-token RPC |
| CUDA-only, Legion 1 direct (`-ngl 30`: 30 CUDA + 34 CPU) | 20.2–20.5 | 0.88–0.92 | 17.6–17.8 s | 52–54 s | ctx 1024, no Wi-Fi in the loop |
| CUDA-only, Legion 2 direct (`-ngl 30`) | 17.9 | 1.20 | 20.1 s | 47.1 s | ctx 1024 |
| Legion 1 direct, `-ngl 0` (pure CPU, reference) | 16.7 | 0.46 | 21.5 s | 91.0 s | ctx 1024 |
| Hybrid (`40,12,12`, Wi-Fi RPC, ctx 32768) | 14.7 | 2.26 | 24.6 s | 28.1 s | earlier run, different ctx |

Fit boundaries measured on the 4 GB cards: at ctx 32768 a 26-layer-per-Legion RPC split fails on KV
allocation, and `-ngl 32/33/36` fail (context/weight allocation) — the practical ceiling is 30 layers on
the GTX 1650-class card plus CPU for the rest. A strict `0,32,32` RPC split does not fit at ctx 32768.

Mesh integration (registered as external deployments and exercised through the control router, same
protocol; the engine timings are unchanged, the added wall time is the authenticated route):

| mesh deployment | node | prefill tok/s | decode tok/s | wall (vs direct) |
|---|---|---:|---:|---:|
| `bonsai-mac` | M5 Max, `127.0.0.1:8122` | 109.1 | 25.6 | 4.69 s (3.88 s) |
| `bonsai-legion` | Legion 1, `:8123` | 20.35 | 0.91 | 53.0 s (52.4 s) |
| `bonsai-legion2` | Legion 2, `:8124` | 17.88 | 1.19 | 47.1 s (47.1 s) |

Conclusion: the Mac alone is ~7× faster at prefill and ~20-25× at decode than the best CUDA node; the
Wi-Fi-RPC hybrid is the worst configuration at a given context because every layer boundary and every
token pays a round trip, while a direct server on the CUDA node only pays its own GPU+CPU. CUDA hosts
could only win prefill for this model when they offer more VRAM than the model plus a faster
prefill path than the M5's Metal.

Reproduce: `~/prism/runtime/llama-server -m ~/swarmlet/models/Ternary-Bonsai-2-27B-PQ2_0.gguf -ngl 30
-c 1024 --parallel 1 -fa on --alias bonsai-2-27b --host 127.0.0.1 --port 8123 --metrics` on each Legion;
`ssh -L PORT:127.0.0.1:PORT` to measure; the registration bodies are
`{kind:"external", external:{nodeId,url:"http://127.0.0.1:PORT",healthPath:"/health",modelName:"bonsai-2-27b"}}`.

## 8. Phase-aware placement in swarmlet (commit `4fb0d62`)

Measured phase speeds now decide native prefill-decode placement instead of an operator pinning both
nodes:

- `node-agent` scrapes `llamacpp:prompt_tokens_total` next to `tokens_predicted_total` and reports
  `prefillTokPerSec` (with the same baseline/reset discipline as `tokPerSec`); `NodeMetrics` carries it.
- `control/phase-plan.ts` prices one reference request (`PHASE_REFERENCE` 512 prompt + 64 output, state at
  the profile's `boundaryBytes` per token, pair transfer rate 0.9 MiB/s — the measured Legion→Mac slow
  direction) and returns the ordered pair with the lowest total, or refuses when a single node wins both
  phases (saying to create a replica) or when the needed measurement is missing.
- `control/planner.ts` runs the chooser only when a `prefill-decode` spec names neither node; explicit
  pins keep the old owner-pinned behaviour. Reasons record every candidate's measured speeds and the
  winning cost breakdown.
- Tests: `control/test/phase-plan.test.ts` (choice, role restrictions, transfer-dominated local optimum,
  ties, missing data, unreachable pairs), `control/test/planner.test.ts` (auto split, local refusal,
  no-measurement refusal), `node-agent/test/metrics.test.ts` (prompt-counter rate, reset baseline).
  `bunx tsc --noEmit` clean; focused suites pass. The full `bun run test` shows 489+ pass with two
  pre-existing `e2e/mesh.test.ts` failures that reproduce on a clean tree (rig-state dependent, not this
  change).

With the measured rates above, the decision for Bonsai at ctx 1024 is *local on the Mac* (prefill 140 vs
20 t/s; decode 24.6 vs 1.2 t/s) — the split is only chosen when the transfer is repaid, which is exactly
what this rig refutes today.
