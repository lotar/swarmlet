# Model profiles

One JSON file per model, shape = `ModelProfile` in `swarmlet/protocol/types.ts`, loaded and strictly
validated by `loadProfiles()` in `swarmlet/control/planner.ts`. The shape is strict: no extra keys (no
`_comment`), every size an integer in MiB, every pattern a compiling RegExp, `id` equal to the file name.
Provenance for every number lives here instead.

The planner never leaves a profile's `envelope`: a request is placed on the row with the most layers per
worker that ctx/parallel/chain and every worker's GPU offer allow, or refused with the limit that blocked
it. Layer counts were checked against the GGUF headers on 2026-09-04; the remaining sizes are inferred from measured runs.

## flash-next-ud-q4kxl (Qwen3.8 Flash-Next UD-Q4_K_XL)

| field | value | where it comes from |
|---|---|---|
| `ggufPattern` | first of the five shards | rig line of `docs/FLASHNEXT_RING_LEVERS_20260904.md` (5 shards, 104 GB); llama.cpp opens the model by its first shard |
| `mtpPattern` | `Qwen3.8-Flash-Next-MTP-Q8_0.gguf` | the Q8_0 draft head used in the target/MTP benchmark matrix; the ring windows in the levers doc §12 ran the Q4_K_M head on Metal, either file drives the same `--spec-type draft-mtp` path |
| `layers` | 48 | `--tensor-split 1,1,46` in the levers doc rig line (1 + 1 + 46) |
| `layerMiB` | 1608 (1.57 GiB) | "layer GiB 1.57" in the profile table of `docs/NODE_APPS_CONTROL_PLANE_20260904.md` §6 |
| `coordinatorHostMiB` | 32768 (32 GiB) | host-side residency at the shipped context. An earlier 2 GiB figure described the *levers experiment* windows (ctx 1536, where the 46-layer share loaded with 75.6 GiB free), not the rig that runs today: the production launcher passes `--ctx-size 262144 --parallel 4`, whose KV lives in the host's unified memory, and the PLE n-gram table stays mmap-backed (`-ot ple_ngram_embd=CPU`) so it is still not counted here. The arithmetic is load-bearing, not decoration: a 48-layer replica is 48 × 1608 + 32768 = 109952 of the M5's 110000 MiB offer, so a whole-model replica only just fits, and the split row is 106736. Re-measure before lowering it. |
| `boundaryBytes` | 81920 | two ~40 KiB F32 hyper-connection tensors cross every boundary per token (levers doc §1 "two tensors cross every boundary", §3 wire bytes, §16 `l_last-2` and its reshaped copy) |
| `workerMarginMiB` | 1536 | levers doc §7: a 4 GB card sits at ~2.2 GB with one layer (1.57 GiB weights + compute buffers); the margin keeps the (chain+1) × slots verify batch inside a 3.7 GB offer |
| envelope row 1 | 1 layer, ctx ≤ 262144, parallel ≤ 3, chain 0 | one layer per 4 GB-class worker (levers doc §7), the context the production launcher actually asks for (`--ctx-size 262144 --parallel 4`), and **no chain**: no MTP head is qualified for Flash-Next yet, so `draftHead()` refuses chain > 0 and a row advertising one would advertise something the planner never delivers (`control/test/profile-invariants.test.ts` fails if one appears). The old "chains up to 8 at parallel 3" was measured on the levers rig with a draft head that is not shipped today |
| envelope row 2 | 1 layer, ctx ≤ 262144, parallel ≤ 1, chain 0 | the same row at parallel 1, for a worker that cannot take the batched verify load the levers doc §7/§15 measured; chain 0 for the same reason as row 1. Note this row is dominated by row 1 today (same context, smaller parallel, same chain), so it is kept only as the explicit conservative choice |
| `extraArgs` | `-ot ple_ngram_embd=CPU -fa on --cache-ram 0 --ctx-checkpoints 0` | coordinator recipe in the control-plane doc §7 (measured best exact config); checkpoints and RAM cache off per `docs/QWEN36_INTERNET_SPECULATIVE_20260903.md` §2 item 3 (recurrent-state checkpoints pulled ~10 MB per Legion through the tunnel per prompt) |

The measured best exact configuration this envelope encodes: chain 4 with batched boundary GETs,
12.6 tok/s per stream and 15.7 aggregate at `--parallel 3` over the public internet, 9.3 / 17.8 on the LAN
without a draft (levers doc §19 scoreboard rows 7 and 10). `wire` f16/q8 is lossy on this model (§18);
the planner passes it through only when the spec asks for it.

## qwen35-2b-q8 (Qwen3.5-2B Q8_0, the rig and test model)

| field | value | where it comes from |
|---|---|---|
| `ggufPattern` | `Qwen3.5-2B-Q8_0.gguf` | `docs/RIG_EMULATION.md` (Docker rig model) |
| `layers` | 24 | verified 2026-09-04 from GGUF metadata (`qwen35.block_count = 24`, `embedding_length = 2048`, file 1.87 GiB); matches the tensor-split sums used in measured runs (`6,6,12` in `docs/RIG_EMULATION.md`) |
| `layerMiB` | 80 | "layer GiB 0.07" in the control-plane doc §6 table, rounded up to a whole MiB budget |
| `coordinatorHostMiB` | 1024 | no host-side table ("none" in the §6 table); 1 GiB covers KV cache and scratch at ctx 4096 × parallel 8 |
| `boundaryBytes` | 8192 | "2 × 4 KiB" in the control-plane doc §6 table |
| `workerMarginMiB` | 512 | compute buffers on a 4 GB card at ctx 4096 × parallel 8; 3 × 80 + 512 = 752 MiB per worker |
| envelope | 3 or 2 layers per worker, ctx ≤ 4096, parallel ≤ 8, chain 0 | 4 GB workers held 2–3 layers in the measured multi-stream ring runs at ctx 2048 (8-stream ring benchmark); "any split, ctx ≤ 4096" in the §6 table; no MTP head exists for this model |

The second row exists so that many small workers still leave the coordinator at least one layer (the
planner refuses a row whose `workerLayers × workers` reaches `layers`).

## qwen36-35b-a3b-q4km (Qwen3.6-35B-A3B Q4_K_M)

| field | value | where it comes from |
|---|---|---|
| `ggufPattern` | `Qwen3.6-35B-A3B*Q4_K_M*.gguf` | the Q4_K_M files used in `docs/QWEN36_INTERNET_SPECULATIVE_20260903.md` ("All Q4_K_M, 5/5/30") |
| `layers` | 40 | verified 2026-09-04 from GGUF metadata (`qwen35moe.block_count = 40`, `embedding_length = 2048`, file 19.02 GiB, so ~487 MiB per layer); matches the tensor-split sums used in measured runs (`13,13,14`, `12,12,16`, `5/5/30`) |
| `layerMiB` | 512 | "layer GiB 0.5" in the control-plane doc §6 table (the split doc measured ~0.25 GiB of weights per layer for IQ2_XXS; Q4_K_M is about twice that) |
| `coordinatorHostMiB` | 4096 | no host-side table ("none" in the §6 table); 4 GiB covers KV cache, recurrent state and scratch at ctx 2048 × parallel 4 |
| `boundaryBytes` | 4096 | "4 KiB" in the control-plane doc §6 table |
| `workerMarginMiB` | 1024 | 4 × 512 + 1024 = 3072 MiB per worker; the split doc §3a-bis measured 12 layers at 3.2–3.4 GiB on a 4 GB card, so four layers leave ample room for KV and compute buffers |
| envelope | 4 layers per worker, ctx ≤ 2048, parallel ≤ 4, chain 0 | "4/4/32" validated row in the control-plane doc §6 table; chain stays 0 because no draft head is pinned (see the `mtpPattern` row) — a row that advertised a chain would advertise something the planner refuses (`draftHead()`), and `control/test/profile-invariants.test.ts` fails if one appears |
| `mtpPattern` | none yet | the Qwen3.6 draft head file name is not pinned in the docs; chain > 0 is refused until it is added |

## The optional `download` block (how a node gets weights it lacks)

A node owner who wants to help serve a model should not have to know where its GGUF lives. The
catalog already tells a node what it *cannot* serve (`local_reasons`: "does not have this model
downloaded"); `download` adds the missing half — where the bytes are — so the node UI can offer a
confirmed, verified fetch instead of a dead end.

| field | rule | why |
|---|---|---|
| `files[].name` | must match the profile's `ggufPattern` (kind `gguf`) or `mtpPattern` (kind `mtp`) | The load-bearing invariant: it guarantees a fetched file is the file the planner will later match on that node. Without it a node could fetch 28 GB the planner then ignores because the name does not match. `loadProfiles` refuses a profile whose download names do not line up. |
| `files[].kind` | `gguf` or `mtp`, exactly one `gguf` | `mmproj` and other sidecars are not part of a text split and are not fetched by this path. |
| `files[].url` | `https://`, with explicit loopback `http://127.0.0.1`/`localhost` allowed | Remote origins must be encrypted; loopback is permitted so a node can pull from a mirror on its own machine. |
| `files[].sha256` | 64 lowercase hex characters | This is the entire trust boundary. The URL may redirect to a third-party CDN, so nothing about the transport is trusted: bytes land in a `.part` file and are hashed before being renamed into the models directory. A mismatch deletes the download and fails the fetch. |
| `files[].bytes` | integer > 0 | Checked before the hash (a short read fails fast) and used to refuse a fetch that cannot fit on disk before any bandwidth is spent. |

A profile without a `download` block still works; its node owners just have no in-UI way to fetch the
weights.

## qwen38-27b-q8 (Qwen3.8-27B Q8_0, dense VL, hybrid gated-deltanet/attention)

| field | value | where it comes from |
|---|---|---|
| `ggufPattern` / `mtpPattern` | `Qwen3.8-27B-Q8_0.gguf` / `mtp-Qwen3.8-27B-Q8_0.gguf` | the two files this rig actually serves, fetched and hash-verified on 2026-09-12 |
| `layers` | 64 | read from the GGUF header (`qwen35.block_count = 64`, `embedding_length = 5120`, 851 tensors) |
| `layerMiB` | 389 | computed from the tensor table of that file: 64 blocks sum to 25.88 GB, 385.6 MiB average with a 388.5 MiB maximum (the maximum is used, so per-worker budgets are not optimistic) |
| `coordinatorHostMiB` | 6144 | host-side output layer + token embeddings (2577 MiB measured from the tensor table) plus q8_0 KV. Only 16 of 64 layers carry KV (`full_attention_interval = 4`, 4 kv heads, head_dim 256) at ~32 KiB/token, so 128K is ~4 GiB. |
| `boundaryBytes` | 20480 | the residual stream crossing one boundary: 5120 hidden × 4 bytes (f32). Per-layer SSM state stays on the node holding that layer, so it does not cross per token. **Unmeasured** — this is an estimate from the architecture, not a measured wire number like the flash-next profile's. |
| `workerMarginMiB` | 1536 | same compute-buffer allowance the flash-next profile uses; not measured for this model at this ctx. |
| envelope | 42 layers per worker, ctx ≤ 32768, parallel 1, chain 0 | 42 × 389 + 1536 = 17874 MiB, sized to the largest non-coordinator GPU in this fleet (an M5 Pro offering 18186 MiB). The second row (5 layers, 3481 MiB) exists for small CUDA workers. **This envelope is not the product of a ring measurement** the way the entries above are; treat it as a planning budget until a measured sweep replaces it. `chain 0` because MTP across an RPC boundary is untested for this architecture. |
| `extraArgs` | `-fa on --cache-ram 0 --ctx-checkpoints 0` | checkpoints are disabled deliberately: this is a recurrent hybrid, and pulling recurrent state across a boundary per prompt is the failure mode `docs/QWEN36_INTERNET_SPECULATIVE_20260903.md` §2 item 3 measured. |
| `download` | both files, HF `ggml-org/Qwen3.8-27B-GGUF`, sha256 `f5c702d8…e4c8` (28,595,763,552 B) and `cbf60a0c…cc9a` (3,164,006,688 B) | verified by re-downloading through the published URL and comparing to the HuggingFace LFS metadata on 2026-09-12 |
