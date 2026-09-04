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
| `coordinatorHostMiB` | 2048 (2 GiB) | KV cache and scratch at ctx 1536 × parallel 3. The 28.8 GiB PLE n-gram table stays mmap-backed on CPU (`-ot ple_ngram_embd=CPU`) and is served from the page cache, so it is deliberately NOT part of the fit gate: the measured windows loaded the 46-layer share with 75.6 GiB free (levers doc), i.e. weights + ~2 GiB, and the operators gated on 68-70 GiB |
| `boundaryBytes` | 81920 | two ~40 KiB F32 hyper-connection tensors cross every boundary per token (levers doc §1 "two tensors cross every boundary", §3 wire bytes, §16 `l_last-2` and its reshaped copy) |
| `workerMarginMiB` | 1536 | levers doc §7: a 4 GB card sits at ~2.2 GB with one layer (1.57 GiB weights + compute buffers); the margin keeps the (chain+1) × slots verify batch inside a 3.7 GB offer |
| envelope row 1 | 1 layer, ctx ≤ 1536, parallel ≤ 3, chain ≤ 8 | levers doc §7: chain 10 at `--parallel 3` failed to allocate the RPC0 compute buffer on the GTX 1650; "chains up to 8 at parallel 3"; ctx 1024–1536 in every window (rig line); control-plane doc §6 table |
| envelope row 2 | 1 layer, ctx ≤ 1536, parallel ≤ 1, chain ≤ 12 | levers doc §7 "chains 10–12 only at parallel 1", measured in §15 |
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
| envelope | 4 layers per worker, ctx ≤ 2048, parallel ≤ 4, chain ≤ 7 | "4/4/32" validated row in the control-plane doc §6 table; chain up to 7 from the Qwen3.6 MTP windows in the speculative doc |
| `mtpPattern` | none yet | the Qwen3.6 draft head file name is not pinned in the docs; chain > 0 is refused until it is added |
