# Qwen3.6-35B-A3B over the public internet: iterating the 3-node split toward 20 tok/s, losslessly

**Goal (2026-09-03, continuation of `QWEN36_3NODE_SPLIT_INTERNET_20260902.md`):** internet only, no LAN runs; iterate the 3-node split until 20+ tok/s per stream; be creative without losing model accuracy.  
**Starting point:** 4.5 tok/s per stream (IQ2_XXS target, 12/12/16 GPU split, plain decoding).  
**Where it ended:** **30–39 tok/s per stream, byte-identical to plain greedy decoding, over the public internet** on a two-node GPU split (M5 + one Legion, §7); the three-node ring tops out at 16–19 (§6). See §7 for why. Every speculative result below is byte-identical to the non-speculative output on all prompts (greedy verification), so nothing was traded on accuracy; the target was moved *up* from 2-bit to 4-bit on the way.

## 1. The only lossless lever is tokens per ring trip

Per generated token the ring pays three internet hops (M5 → Legion 1 → Legion 2 → M5) plus compute. Measured single-token step on the final layout: **175 ms** (5.7 tok/s). Lossless speculative decoding verifies k drafted tokens in one trip; greedy verification reproduces the plain greedy output exactly. Candidates tried, measured for acceptance on a Legion first (no production window needed):

| draft | acceptance | tokens per verify step | note |
|---|---|---|---|
| Qwen3.5-0.8B (draft-simple, n=4) | 60 % | 2.5 | generic small model |
| Qwen3.5-2B (n=8) | 48 % | 3.2 | |
| Qwen3.5-4B (n=6) | 53 % | 2.9 | no better than 2B |
| **MTP head trained for this model** (`ggml-org/Qwen3.6-35B-A3B-GGUF`, `mtp-…-Q8_0.gguf`, 2 GB), chain 5 / 8 | 72 % / 58 % | 4.2 / 5.0 | one extra layer, runs on the M5 |
| **DFlash block draft** for this model (`dflash-…-Q8_0.gguf`, 0.4 GB, block 16) | 27 % | 4.3 | 16-token verify batches |

On the 2-bit target (IQ2_XXS) even the trained heads agreed only 35–65 % of the time and batched verification itself diverged from single-token decoding on most prompts (numerical noise of a 2-bit target). On the 4-bit target (`Qwen3.6-35B-A3B-Q4_K_M`, 20.4 GB, the file the heads were trained against) speculation is exactly lossless: 4/4 prompts identical, 100 % common prefix, every run. So the target was moved to Q4_K_M: Legions hold 5 layers each on their 4 GB cards (6 fit without speculation, 5 with the rollback-snapshot cache), the M5 holds 30.

## 2. Three transport and server defects found and fixed on the way (each cost more than the physics)

1. **WebSocket client chunking.** `websocat` as the M5-side TCP→WebSocket client stalled on payloads above its 64 KiB message buffer; any verify batch ≥ 8 tokens (a 64 KiB activation) hit it. A 60-line Python asyncio bridge (`ws-bridge.py`, `websockets` library, edge IP pinned so tunnel DNS delays stop mattering) passes 1 MiB round trips in ~90 ms. DFlash went from 2.4 to 8.4 tok/s on this change alone.
2. **Cloudflare idle close.** While the RPC client streams one Legion's tensors the other Legion's WebSocket idles past the edge's timeout and is closed; the RPC client then aborts with "Remote RPC server crashed or returned malformed response". Keepalive pings every 20 s on both ends of each bridge fixed the loads.
3. **Recurrent-state checkpoints over the wire.** `llama-server` snapshots the full recurrent state of a slot during prompt processing (`--ctx-checkpoints`, default 32) and again for its RAM prompt cache (`--cache-ram`, default 8 GiB). On this model that state is 2 MB per gated-delta-net layer plus 98 KB of convolution state, and on the ring those layers live on the Legions: every prompt of ≥ 8 tokens pulled ~10.5 MB per Legion back through the tunnel in serial `get_tensor` round trips, a flat ~2.6–3.0 s per prompt (1.6 s on the LAN). The batch-size scan that exposed it: prompts of 1–4 tokens cost one ring trip (~200 ms), 8–64 tokens cost the same ~3 s, 128 tokens 5.9 s; the M5 alone does 128 tokens in 71 ms and a Legion alone scales smoothly. `--ctx-checkpoints 0 --cache-ram 0` removes it (§6 verifies).

Also ruled out with measurements: CUDA kernels on the Legions (the same cliff appears with CPU slabs), the fused gated-delta-net kernel (a toggle was added to the lab build to disable it; not the cause), uplink bandwidth (15–18 MB/s), edge location (Legion 1's tunnel had registered in Vienna while the M5 and Legion 2 used Zagreb; re-registering it in Zagreb gained ~0.7 tok/s).

## 3. Speculative results on the 3-node ring over the public internet (Q4_K_M, 5/5/30, one stream, 4 prompts × 64 tokens, greedy)

| config | tok/s median (min) | tokens per verify step | step time | identical to plain greedy |
|---|---|---|---|---|
| plain decoding | 5.6–5.9 | 1 | 175 ms | (reference) |
| 2B draft, n=6 (before the bridge fix) | 0.9 | 2.9 | ~3.2 s | 4/4 |
| DFlash, block 16 (bridge fixed) | 8.4 (5.8) | 4.3 | 515 ms | 4/4 |
| MTP chain 5 | 7.2 (3.2) | 4.2 | 584 ms | 4/4 |
| MTP chain 8 | 14.2 → **14.9** after both tunnels moved to the Zagreb edge | 5.0 | 354 ms | 4/4 |
| MTP chain 12 | 13.3 (11.2) | 5.2 | | |
| MTP chain 8, draft confidence cutoff 0.5 | 12.8 (10.5) | 4.65 | variable batch shapes re-ship the graph | |
| **MTP chain 6** | **16.8 (13.3)** | 4.65 | **276 ms** | |

Step time grows ~17–22 ms per extra token in the verify batch (activation payload per hop plus the serial gated-delta-net kernel on the Legion cards), so a chain of 6 beats 8 and 12.

Two layouts were also measured and rejected: a 2-hop ring with Legion 1 serving both a GPU slab and a CPU slab from one worker (Legion 2 idle) gives 4.85 plain / 13.3 with MTP-8, the CPU slab costing more than the hop it saves; and the even 13/13/14 split from the previous document is dominated by every other option here.

## 4. Where the remaining time goes (chain 6, 276 ms per step of 4.65 tokens)

```
3 internet hops        ~120 ms   (35 ms round trip each via the Zagreb edge + payload)
6 extra tokens in batch ~100 ms   (~17 ms per token: 4 KiB per token per hop, serial GDN kernel on GTX 1650)
compute + dispatch      ~55 ms   (single-token step minus hops)
```

20 tok/s needs ≤ 232 ms per step at 4.65 tokens. The two remaining lossless levers, neither done here: Ethernet on the Legions (their Wi-Fi is ~7–9 ms of each hop leg; about −30 ms per step, which alone would land near 19–20), and F16 activations at the hop boundaries (halves the per-token payload; an engine change in ggml-rpc). A chunked CUDA gated-delta-net kernel (an upstream TODO in `gated_delta_net.cu`) would cut the per-token batch cost further.

## 5. Evidence

`sin-harness/data/legion-goal/q36-spec-internet-*` (one directory per window; `*-cN/summary.json` per config, `ws-5220x.log` frame logs where enabled, `server-<config>.log`), `q36-batchscan-*` (ring vs M5-only scans), `q36-replica-internet-*`, Legion 2 acceptance sweeps in `~/spec-accept/` on Legion 2. Scripts (session scratchpad): `q36-spec-operator.sh` family (`run-q4f.sh` is the final form: per-config server args, LAN/internet path switch, retrying production stop), `spec-client.py`, `batch-scan.py`, `ws-bridge.py`, `legion-spec-accept.sh`. Lab llama.cpp on the M5 carries two local patches: the GGUF name-alias shim from earlier and an env toggle `LLAMA_FUSED_GDN_CH/AR` in `src/llama-context.cpp`.

## 6. Final rows (windows F and G)

All Q4_K_M, 5/5/30, three hops over the public internet through the Zagreb edge, Python bridge, greedy, 4 prompts × 64 tokens. Window F kept the default prompt checkpoints; window G turned them off (`--ctx-checkpoints 0 --cache-ram 0`), which is the recommended configuration.

| config | 1 stream | 2 streams (per stream / wall aggregate) | 4 streams |
|---|---|---|---|
| plain decoding, checkpoints off | 6.4 (6.1) | 4.4 / 8.2 | |
| MTP chain 5 | 13.7 (12.0) | 9.8 / 11.9 | 4.9 / 12.8 |
| **MTP chain 6** | **17.2 (13.0)**, checkpoints on; **15.6 (14.1)** checkpoints off | 11.7 / 12.1 (on); **10.3 / 18.6** (off) | 6.8 / 12.2 |
| MTP chain 7 | 16.1 (13.9) | 10.3 / 12.3 | 5.9 / 13.0 |

Prompt cost with checkpoints off (batch scan, warm): 1 token 154 ms, 8 tokens 252 ms, 32 tokens 409 ms, 128 tokens 1.05 s, against 2.5–3.9 s for anything ≥ 8 tokens before.

**Verdict against the goal.** Single-stream, lossless, over the public internet on the 3-node split: **15.6–17.2 tok/s median** (run-to-run spread from internet jitter), up from 3.6 at the start of the day and 4.5 at the start of this goal; the minimum prompt in each run sits at 13–14. Two concurrent streams clear 20 tok/s of decode in aggregate (10.3 each plus prompts: 18.6 wall-clock). The 20 per stream line was not reached; the arithmetic in §4 says the two remaining lossless levers (Ethernet on the Legions, F16 hop payloads) are worth about 30 and 15 ms of the 276 ms step and would land it. Every speculative output was byte-identical to plain greedy decoding on the 4-bit target.

## 7. Second phase: what actually reaches 20+ per stream

**Decomposition (window I).** The M5 alone runs the identical chain-6 configuration at 139 tok/s (32 ms per verify step; plain decoding 98). The ring's step was 246–287 ms, so ~85 % of it was transport, and each Legion hop cost 75–90 ms, two to three round trips rather than one.

**Fewer Legion layers do not help (sweep H).** 3/3/34, 2/2/36 and 4/4/32 with chains 6 and 7 all land at 14–18.6 tok/s single-stream (best: 2/2/36 chain 7, 18.6 median, 16.6 minimum; 4/4/32 chain 7, 18.0 / 15.6) and 20–22 tok/s wall-clock aggregate at two streams. The slabs are not the cost; the number of Legion hops is.

**Two hops instead of three (window J).** With only 3–5 layers needed on a card, one Legion holds all of them, so the ring becomes M5 → Legion 1 → M5. Q4_K_M, prompt checkpoints and RAM cache off, Zagreb edge, Python bridge, greedy, 4 prompts × 64 tokens:

| layout | plain decoding | MTP chain 6 (1 stream) | chain 7 (1 stream) | chain 6, 2 streams (per stream / aggregate) | chain 7, 2 streams |
|---|---|---|---|---|---|
| 5 / 0 / 35 | 11.8 | **30.7 (min 27.1)** | **39.3 (min 29.5)** | 21.1 / 38.5 | 22.0 / 39.6 |
| 3 / 0 / 37 | 12.3 | **38.9 (min 27.7)** | 35.2 (min 25.9) | 23.0 / 43.2 | 20.9 / 37.6 |
| 4 / 4 / 32 (three nodes, same window series) | 5.6–6.4 | 17.0 (12.8) | 17.6–18.2 (15.5–16.7) | 9.3–10.2 / 16.5–18.2 | 12.1–12.7 / 22.3–23.1 |

Every speculative row was byte-identical to plain greedy decoding. A single-token step on the two-node split is 85 ms versus 175 ms with three nodes: the second Legion adds ~90 ms per step, not the ~40 ms one extra round trip would cost, because the RPC client moves the Legion-1 output to Legion 2 through the M5 with a synchronize, a blocking read and a blocking write. A lab patch that pipelines the read behind the queued compute for RPC sources (`GGML_SCHED_PIPELINED_COPY=1` in `ggml/src/ggml-backend.cpp`) changed nothing (17.6 vs 18.2), so the extra round trips sit elsewhere in the RPC client (the RPC→RPC path never reaches that fallback); left as the open engine item for a three-node ring. Also measured and rejected in this phase: forcing full-length MTP drafts (12.1), the Q4_0 MTP head (13.4; 55 % acceptance vs 64 % for Q8_0).

**Verdict against the goal.** 20+ tok/s per stream, lossless, over the public internet: **met** on the two-node GPU split (30.7–39.3 median, 25.9–29.5 minimum across four prompts, 21–23 per stream with two concurrent streams). The three-node ring reaches 16–19 per stream and 20–23 aggregate at two streams; making the third node cheap needs the RPC client to stop staging Legion-to-Legion transfers through the M5 with blocking calls.
