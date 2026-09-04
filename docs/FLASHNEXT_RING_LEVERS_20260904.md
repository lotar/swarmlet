# Qwen3.8 Flash-Next on a 3-node internet ring: per-token budget, six levers, remeasure

**Date:** 2026-09-04. **Goal:** run with `--parallel 3` (three nodes), apply levers 1–6, remeasure everything, and account for every millisecond. No unexplained gaps.
**Rig:** M5 (RPC client, 46 layers on Metal, PLE n-gram table mmap-backed on CPU) + Legion 1 (GTX 1650 Ti, 1 layer) + Legion 2 (GTX 1650, 1 layer), `--tensor-split 1,1,46`, `-c` 1024–1536, lab llama.cpp (`/tmp/llama-upstream-lab`, upstream 9400c89 + local RPC patches: pipelined dispatcher, graph-uid cache, protocol-8 push forwarding). Internet path = ggml RPC over Cloudflare quick tunnels registered at the Zagreb edge (`zag01`), Python `ws-bridge` on the M5, websocat on the Legions; LAN path = SSH port forwards over the home Wi-Fi with a direct Wi-Fi peer push. Model `Qwen3.8-Flash-Next-UD-Q4_K_XL` (5 shards, 104 GB). Every arm: greedy, 64 new tokens, 4–6 prompts, warm-up pass first.

## 0. Method for a gap-free budget

`GGML_RPC_PIPELINE_TRACE=1` timestamps every RPC message on the client (writer/reader threads). Per generated token the client issues, per remote node, a fixed set of commands; the endpoint that returns the boundary activations to the M5 is where all ring latency is observed as blocking waits. Script `scratchpad/rpc-trace-budget.py` splits each token cycle into: GET#1 wait (whole ring), GET#2 wait (second boundary tensor), host gap (last GET done → next cycle's first write = M5 layers + head + sampling + client prep), remainder (writes + scheduler). The four medians must sum to the cycle median within a few ms; if they do not, the report says so.

## 1. Baseline decomposition (window `fnring-trace-qsa-20260904T062510Z`, `--parallel 1`, internet, forwarding on)

Per token, medians over ~195 warm cycles:

| term | kvu (`--kv-unified`, control) | nokvu (QSA sparse gather enabled) | what it is |
|---|---|---|---|
| GET#1 wait | 125.7 ms | 122.9 ms | client waits for the ring: SET→L1, L1 compute, L1→L2 push over the peer tunnel, L2 compute, reply |
| GET#2 wait | 51.9 ms | 53.6 ms | a **second** boundary tensor fetched from L2 with its own serialized round trip |
| host gap | 28.3 ms | 31.5 ms | M5: 46 layers + output head + sampling + client prep |
| remainder | 0.4 ms | 0.6 ms | SET/FORWARD/WAIT writes + scheduler |
| **sum of medians** | **206.4 ms** | **208.6 ms** | |
| **cycle median (measured)** | **209.2 ms** | **213.5 ms** | residual 3–5 ms = jitter between per-term medians and the cycle median |
| server `eval time` per token | 221–228 ms | 205–232 ms | llama-server's own timing, includes per-token bookkeeping outside the RPC cycle |
| client tok/s (spec-client) | 4.31 | 4.41 | |

Commands per token: RPC0 (L1): SET×3, FORWARD×2, RECOMPUTE×1, zero blocking. RPC1 (L2): SET×1, WAIT×2, RECOMPUTE×1, GET×2, blocking 181 ms. So **two tensors cross every boundary** and the scheduler fetches them one after the other.

What this settles:
- **Lever 1 (the "unexplained 65 ms") is explained:** it is GET#2, a second boundary tensor fetched with a serialized round trip (~52 ms), plus the M5 host gap being ~28 ms not the 30 assumed, plus ~5 ms jitter. Nothing is unaccounted. PLE cold page faults are not a factor (warm-up pass changed decode by 0; it did cut prefill from 2900 to 54 ms per prompt token, so the earlier prefill disaster was first-shape graph shipping).
- **Lever 2 (`--kv-unified` off → QSA on) at single-token decode: no effect** (4.41 vs 4.31 tok/s, inside jitter). Its hypothesised benefit is on multi-token verify batches (the 38 ms fixed cost seen at batch 4–8); retested below with MTP batches.

## 2. Windows still to fill

(Sections 3–8 are appended as each window and agent deliverable lands: LAN-vs-internet per-leg split at `--parallel 3` c1/c3; MTP head port (lever 3) and chain/p-min sweep (lever 6); F16/Q8 wire (lever 5); pipelined boundary GETs (lever 1 fix); fabric bracket (lever 4); final remeasure matrix and verdict.)

## 3. LAN vs internet, `--parallel 3` (window `fnring-lan3-*`, LAN = SSH forwards over home Wi-Fi + direct Wi-Fi peer push; same split, same binaries)

| arm | c1 per stream | c3 per stream | c3 aggregate | server eval ms/token |
|---|---|---|---|---|
| LAN nokvu | 5.64 tok/s | 5.60 | **14.56** | 162–193 |
| internet nokvu (window 1, `--parallel 1`) | 4.41 | – | – | 205–232 |

**Three streams ride one ring trip almost for free** (c3 per-stream 5.60 vs c1 5.64): the step is fixed latency, not per-token work, so `--parallel 3` triples aggregate. That holds for every later configuration (MTP included) and is the cheapest multiplier in the whole study.

LAN trace budget (medians over 688 cycles, c1 and c3 passes mixed; a cycle is one ring trip = 1 or 3 tokens):

| term | LAN | internet (§1) | Δ = pure Cloudflare transport |
|---|---|---|---|
| GET#1 wait | 96.5 ms | 122.9 | 26 |
| GET#2 wait | 39.8 ms | 53.6 | 14 |
| host gap | 33.1 ms | 31.5 | – |
| remainder | 0.6 ms | 0.6 | – |
| sum / cycle | 170.0 / 176.3 | 208.6 / 213.5 | ~40 |

So **the internet path costs only ~40 ms of the ~210 ms step. ~130 ms is spent inside the ring even on a 7 ms LAN.** Wire bytes per ring step, measured with `nettop` on the SSH forwards over 30 s (~181 steps): L2 path ≈ 94 KB (both directions summed: two ~40 KiB GET payloads + one small SET + framing), L1 path ≈ 30 KB (three small SETs). Boundary tensors are ~40 KiB each (F32 `[2560,4,1]`), not megabytes — bandwidth is not the cost. A 40 KiB GET taking 40 ms on a 7 ms LAN (expected ~12) is the signature of a TCP small-write stall (Nagle vs delayed ACK) on one of the hops; §4 tests that directly.

## 4. Lever 3: MTP head port into the lab tree (agent `mtp-port`, delivered 06:38Z)

The lab `qwen4exp.cpp` had no nextn/MTP code (upstream never merged PR27739's qwen4exp MTP), so the head-only MTP GGUF (block_count 49, only `blk.48.*`, `nextn_predict_layers=1`) failed at `blk.0.hc_attn_norm`. Port, semantics from the production tree `dfa0c0f`, into `/tmp/llama-upstream-lab`: `src/llama-model.cpp` (qwen4exp joins `mtp_on_hybrid_qwen`: MTP context gets a plain KV cache filtered to `il >= n_layer()`), `src/models/models.h` (protected no-build ctor, `graph_mtp` declaration), `src/models/qwen4exp.cpp` (+201: `mtp_only` detection skips the trunk; nextn block created at index 48 with `load_mtp`-gated flags, indexer tensors skipped so the draft attention runs dense; main graph exports `t_h_nextn` streams; `graph_mtp` = hnorm/enorm → eh_proj → HC-mixed dense attention + MoE → head mixer + output). 3 files, +211/−6; the RPC patches untouched.

Verified by the agent: clean build; no-alloc load of the MTP file creates all 29 needed tensors (4 indexer tensors ignored) and reserves the MTP graph (162 nodes); no-alloc load of the 104 GB target's metadata builds the main graph (7950 nodes); a real 4-token MTP decode on CPU and on Metal gives identical argmaxes (381/220/82/471) and finite `t_h_nextn`. Not verified until the next window: the target's unmasked `t_h_nextn` export and `--spec-type draft-mtp` acceptance on the ring.

Binary provenance: the rebuild landed at 06:38:27Z. Window `fnring-lan3` servers (06:34, 06:37) ran the pre-port binary; window `fnring-inet3` (06:42 on) runs the ported one, inert without a draft (`n_layer_nextn=0`, `embeddings_nextn` off). The rebuild's last ~40 s overlapped the LAN kvu arm's warm-up pass, not its measured passes.

## 5. Lever 4 scouting: the fabric floor vs the tunnel stack

ICMP round trips, 8 pings each: M5 → Cloudflare Zagreb edge 9.8 ms avg (8.7–11.1); M5 → 1.1.1.1 9.1; M5 → Legion 1 over Wi-Fi 8.1 (5.3–12.7); Legion 1 → edge 12.9 (7.7–25.1). **The network to the edge is ~10 ms round trip; the ~35 ms per RPC hop measured through the tunnel is therefore ~25 ms of stack (cloudflared QUIC/HTTP2 + TLS + WebSocket framing + the Python bridge + websocat), not wire.** All three nodes sit behind one public IP (93.142.130.130, Croatian Telecom), so a direct WireGuard/QUIC path between them is a NAT hairpin, i.e. the LAN, not the internet; no external relay is available (no VPS; `the-shop` host does not answer; Tailscale client binary exists on the M5 but no daemon and it would need admin rights, and it would also detect the shared LAN and go direct). Lever 4 in this rig therefore means: measure each layer of the tunnel stack over the same edge and remove what can be removed (§6), with the ~10 ms ICMP floor as the theoretical bound.

## 6. Internet, `--parallel 3` (window `fnring-inet3-20260904T064154Z`; ported binary, draft off)

| arm | c1 per stream | c3 per stream | c3 aggregate | c3 / c1 aggregate |
|---|---|---|---|---|
| internet nokvu | 4.84 tok/s | 4.06 | **10.29** | 2.1× |
| internet kvu | 4.68 | 4.36 | 11.24 | 2.4× |
| LAN nokvu (§3) | 5.64 | 5.60 | 14.56 | 2.6× |
| LAN kvu (§3) | 5.86 | 5.31 | 14.17 | 2.4× |

Trace budgets, internet, `--parallel 3` (medians over ~690 cycles, c1 and c3 passes mixed):

| term | nokvu | kvu |
|---|---|---|
| GET#1 wait | 125.5 ms | 123.0 |
| GET#2 wait | 53.7 | 51.4 |
| host gap | 30.2 | 30.4 |
| remainder | 0.9 | 1.0 |
| sum of medians / cycle median | 210.3 / 218.1 | 205.9 / 214.8 |

Same shape as `--parallel 1` (§1) to within jitter: the ring step does not care whether the trip carries 1 or 3 tokens on the LAN, and on the internet path 3 tokens cost ~16 % more per trip (the 3× larger boundary payload through the tunnel). `--kv-unified` on/off: no difference at decode without a draft, on either path. The 5–9 ms gap between the sum of term medians and the cycle median is the expected difference between medians of parts and the median of the whole; per-cycle sums close exactly by construction.

## 7. MTP on the ring, first window (`fnring-mtp3-20260904T065311Z`, `--parallel 3`, internet, Q4_K_M head on Metal)

Baseline in this window: nospec c1 4.61 tok/s, c3 11.40 aggregate (consistent with §6). **The ported draft loads on the real ring** (`llama-server` healthy with `--spec-type draft-mtp`, 3 slots, draft on `MTL0`), the first time speculation has been attempted on 3-node Flash-Next. The first speculative decode then aborts in the target's hidden-state read-back:

```
src/llama-context.cpp:1961: GGML_ASSERT(backend_h != nullptr) failed   (server_context_impl::decode)
```

That is the one piece the port could not verify without the 104 GB model: the main graph's exported `t_h_nextn` tensor has no backend in the multi-backend scheduler (two RPC devices + Metal + CPU), i.e. it is not scheduled as a graph output. The draft side and the head-only load are fine. Fix in progress (register the export in the main graph the way `qwen35moe.cpp`/`deepseek4.cpp` do; rebuild; rerun). Chain arms 6–12 in this window fail identically and are not counted. Also noted: this window's MTP arms ran with `--kv-unified` (an empty-string override fell through to the default); the QSA-on MTP variant is scheduled with the rerun.

Chain-length ceiling from Legion VRAM (same window): chain 10 at `--parallel 3` failed to start with `failed to allocate RPC0 buffer of size 232353920` — the verify batch is (chain+1)×slots = 33 tokens and the GTX 1650's compute buffer for a 33-token batch of one Flash-Next layer (hyper-connection width 10240, 512-expert `mul_mat_id`) no longer fits beside the layer weights (cards at ~2.2 GB used with 1 layer). So with 4 GB cards: chains up to 8 at `--parallel 3`; chains 10–12 only at `--parallel 1`. This is a hard rig limit, not a tuning knob.

## 8. Transport probes, Legion 1 (no production window; `scratchpad/leg-probe-suite.sh`, evidence `leg-probe-20260904T070108Z`)

Warm-socket RPC round trips (`GET_DEVICE_MEMORY`, 40 samples), request framed as one coalesced send vs three separate sends (cmd byte, size, payload), client socket with and without `TCP_NODELAY`:

| path | 1 send | 3 sends, Nagle on | 3 sends, NODELAY |
|---|---|---|---|
| lan-direct: raw TCP M5 → Legion 1 over Wi-Fi | 8.1 ms | **56.3 ms** | 9.8 ms |
| lan-ssh: `ssh -L` forward, same hosts | 8.2 ms | 8.8 ms | 8.6 ms |

The classic Nagle × delayed-ACK stall exists on this Wi-Fi path and costs ~48 ms per exchange when a client fragments a small request without `TCP_NODELAY`; the ssh hop coalesces and does not show it. The lab RPC transport sets `TCP_NODELAY` on both its connect and accept sockets and flushes each command as one write, so the ring's own sockets are not the stall. Therefore the 40 ms GET#2 on the LAN ring (§3) is not Nagle; §9 tests whether it scales with payload size (2B model, 8 KiB boundaries, same LAN ring) — a size-proportional cost points at Wi-Fi burst throughput, a flat ~40 ms at a per-GET fixed cost in the hop stack or the server.

## 9. Where the second fetch and the 40 ms come from (`lan-2b-ring-20260904T070303Z`, `leg-probe-20260904T070335Z`)

Qwen3.5-2B on the same LAN ring, split 2/2/20, trace on:

| | forwarding on | forwarding off |
|---|---|---|
| cycle | 63.2 ms | 91.6 |
| GET#1 wait | 52.5 | 44.1 |
| **GET#2 wait** | **0.0** | **0.0** |
| host gap | 9.8 | 47.6 (the M5 relays L1→L2 itself) |

The 2B has **one** boundary tensor; Flash-Next has **two** (its hidden state is the 4-stream hyper-connection residual plus a second per-layer tensor). GET#2 is therefore a Flash-Next graph property, and its ~40–54 ms is one full serialized fetch, not a stall: the RPC transport already runs `TCP_NODELAY` and one write per command (§8). The fix is structural — issue both boundary GETs before waiting (pipelined GETs, §11) — worth ~40 ms LAN / ~52 ms internet per step.

Cloudflare stack, Legion 1, warm socket, one RPC round trip (`GET_DEVICE_MEMORY`, 40 samples), edge registered at Vienna for this probe (`vie06`; Zagreb `zag01` is ~2–4 ms better in earlier runs):

| M5 client | 1 send | 3 sends, Nagle | 3 sends, NODELAY |
|---|---|---|---|
| Python `ws-bridge` over cloudflared QUIC | 37.7 ms (p10 35.6, p90 60) | 41.7 | 35.9 |
| websocat over cloudflared QUIC | 38.1 (p90 62) | 44.9 (p90 103) | 41.3 |

ICMP M5→edge is ~10 ms and Legion→edge ~13 ms, so **the tunnel stack costs ~27 ms per round trip on top of the wire** (cloudflared QUIC + TLS + WebSocket + bridge), the same on both bridge implementations. That is the lever-4 number: a direct datagram path between the three sites would take each ring leg from ~38 to ~10–13 ms; the rig cannot realise it (all nodes share one public IP, no relay), so the internet numbers in this report carry ~25 ms × 3 legs ≈ 75 ms of tunnel stack that a real multi-site deployment with WireGuard would not pay.

cloudflared `--protocol http2` cannot carry this path at all (the WebSocket upgrade is closed: `FAIL closed` on every probe), so QUIC is the only usable quick-tunnel mode; the ~38 ms per round trip above is the floor of this stack. Side effect of the probes: Legion 1's operator tunnel was restarted and re-registered at `zag01` (`fn-tunnels.txt` updated) before the next window.

## 10. MTP export fix (agent `mtp-port`, build 07:11Z)

Root cause of the §7 abort: `llm_graph_result::set_outputs` only flags `t_h_nextn` as an output, it does not expand it into the graph; the port exported a detached reshape that nothing consumed, so the scheduler never placed it. Fix (`qwen4exp.cpp:494-501`): export the last hyper-connection combine node itself, the tensor the head reads. Evidence: a 4.7 GB two-layer qwen4exp fixture built from the MTP head (`scratchpad/make_2layer_gguf.py`) and a driver (`nextn_target_test.cpp`) that runs the exact server first-decode shape through `llama-context.cpp:1961`. Old export: `GGML_ASSERT(backend_h != nullptr)` reproduced on CPU and on Metal (exit 134). New export: PASS on all-CPU, CPU layers + Metal head, split CPU/Metal, all-Metal, Metal with experts on CPU (6 scheduler splits), and Metal with flash attention; masked single row equals unmasked row 5 to 0–0.006; read-back bit-identical when only the head moves device. RPC backends not in the fixture (assignment is backend-agnostic; the export sits on whichever device holds the last layer). Diff stat for the whole port: 3 files, +212/−6.

## 11. Levers 5 and 1: wire compression and batched boundary GETs (agent `rpc-wire`, delivered 07:20Z)

Patch `/tmp/llama-wire-lab-delta.patch` (1094 lines; `ggml-rpc.h`, `ggml-rpc.cpp`, `ggml-backend.cpp`; protocol minor 8.0 → 8.1). Three features, all off by default, wire-off path byte-identical:

- **`GGML_RPC_WIRE=f16|q8`**: F32 activation transfers ≥ 4 KiB (non-weight buffers) go as F16 or Q8_0 via four new `*_WIRE` commands (SET/GET/FORWARD/PUSH); the forward carries the mode so servers need no env; a client only uses them against servers advertising minor ≥ 1, else warns once and sends raw. Per token on the 2B ring: 33.1 KiB raw → 17.1 f16 → 9.6 q8 (with forwarding 25.1 → 13.1 → 7.4). At 20 ms one-way with a 20 Mbit/s cap: 112–114 ms/token raw → 104 f16 → 100–105 q8; uncapped, delay hides the bytes (96–98 all modes). **Parity: 0 differing tokens in all 43 runs**, Q8_0 included (lossy in principle, no flip on this model/prompts).
- **`GGML_RPC_GET_PIPELINE=1`**: in the scheduler's fallback copy branch (RPC source → Metal destination), enqueue every RPC input GET of a split first, synchronize once, then write. Synthetic two-input split at 20 ms one-way: **85 → 42.5 ms per evaluation** (two round trips → one), outputs bit-exact. Requires `GGML_RPC_PIPELINE=1`. The 2B has one boundary tensor per split (no change there); Flash-Next has two, so this targets its GET#2 directly.
- **`GGML_RPC_SERVER_TRACE=1`** on `ggml-rpc-server`: per-command receive, compute begin/end with ms, forward/push/wait_inbound with blocked ms, push receive with bytes — the per-leg timeline the client trace cannot see.

Caveats carried into the remeasure: F16 overflows above 65504 (no 2B activation did; Flash-Next unverified — a bf16 mode is a small addition if it does); minor-version bump means every client and server binary must be rebuilt together (an 8.0 client aborts on an 8.1 server by upstream's HELLO rule).

## 12. MTP on the ring, measured (window `fnring-mtp3b-20260904T071329Z`, internet, `--parallel 3`, QSA on, Q4_K_M head on Metal, fixed export)

**First speculative decode ever on 3-node Flash-Next.** Chain 4:

| | c1 per stream | c3 per stream | c3 aggregate | acceptance | tokens / verify step |
|---|---|---|---|---|---|
| nospec (same window) | 4.69 tok/s | 4.26 (one stalled prompt, min 1.89) | 7.02 | – | 1.00 |
| **MTP chain 4** | **10.89** (min 9.87) | 5.23 (min 4.96) | **13.98** | 59–60 % | 3.15 / 3.23 |

Per-prompt acceptance 41–73 % (mean length 2.6–3.9 of 4). Verify-step budget from the trace (75 cycles, medians):

| term | chain 4 | nospec (§6) | Δ |
|---|---|---|---|
| GET#1 wait | 147.5 ms | 125.5 | +22: 5-token batch through both Legion layers |
| GET#2 wait | 62.0 | 53.7 | +8 |
| host gap | 75.5 | 30.2 | +45: 46-layer 5-token verify + draft chain of 4 + sampling |
| remainder | 1.0 | 0.9 | |
| **cycle** | **287.2** (sum 286.1) | 218.1 | |

287 ms ÷ 3.15 tokens = 91 ms per token = 10.9 tok/s, matching the client. Gap-free.

Parity against the greedy baseline (same prompts): c1 5/6 outputs identical, the sixth shares a 58 % prefix; c3 2/6 identical (median prefix 69 %). The c3 divergence is the batch-composition near-tie effect already documented for batched verification on this Metal backend (`HANDOFF…ADDENDUM` §1.6): with three slots in one verify batch, greedy argmax at near-ties depends on batch shape, so bit-exactness against single-token greedy is not achievable for any batched verifier here; c1 divergence on one prompt is the same effect with the draft tokens as batch mates. Acceptance/reject is self-consistent by construction.

Aggregate at c3 (13.98) is 1.5× c1's rate, not 3×, because each of the three slots drafts its own chain and the verify batch is 15 tokens: the M5 host term and the Legion compute grow with batch, so `--parallel 3` and MTP overlap rather than multiply.

Chain sweep, same window (internet, `--parallel 3`, QSA on, `p-min 0`):

| chain | c1 per stream | acceptance | tokens / step | c3 per stream | c3 aggregate |
|---|---|---|---|---|---|
| 4 | **10.89** tok/s | 59 % | 3.15 | 5.23 | **13.98** |
| 6 | 9.93 | 47 % | 3.56 | 4.46 | 11.15 |
| 8 | 7.56 | 38 % | 3.73 | 2.52 (min 0.93) | 4.50 |

Tokens per verify step rise slowly with chain length (3.15 → 3.73) while acceptance falls (59 → 38 %) and every extra draft token lengthens the verify batch through both Legion layers and the M5; the trip grows faster than the yield, so **chain 4 is the optimum on this ring**, not the longer chains that win on a local Metal verify. The chain-8 c3 pass in this window collapsed to 4.5 aggregate (min 0.93 per stream); the `--kv-unified` replicate of the same arm (§13) gave 10.44, so that collapse was a transient stall, not a systematic card limit. This is the measured answer to "iterate MTP chain size": the ring wants short chains.

Verify-step budgets by chain (trace medians; each cycle = one ring trip = one verify of (chain+1) draft positions × 3 slots when all slots are busy):

| term | chain 4 | chain 6 | chain 8 |
|---|---|---|---|
| GET#1 wait (ring incl. Legion compute on the batch) | 147.5 ms | 181.4 | 262.5 |
| GET#2 wait | 62.0 | 62.5 | 63.8 |
| host gap (M5 verify + draft + sampling) | 75.5 | 138.8 | 183.5 |
| remainder | 1.0 | ~1 | ~1 |
| cycle (sum) | 287.2 (286.1) | 389.4 (384.1) | 514.3 (510.8) |
| accepted tokens per cycle (c1 pass) | 3.15 | 3.56 | 3.73 |
| ms per accepted token | 91 | 109 | 138 |

Every budget closes within 1 %. GET#2 is flat (one fixed fetch regardless of batch), GET#1 grows with the batch through the two Legion layers, and the M5 host term grows fastest: verifying 15/21/27 positions through 46 layers plus running the draft chain is real compute, not network. That host term is the ceiling of the chain lever on this rig.

## 13. Lever 2 closed: `--kv-unified` on/off with real verify batches (window `fnring-mtp3c-*`, same rig, same prompts)

| | chain 6 c1 | chain 6 c3 aggregate | acceptance | nospec c1 / c3 agg |
|---|---|---|---|---|
| QSA on (no `--kv-unified`, §12) | 9.93 tok/s | 11.15 | 47 % | 4.69 / 7.02† |
| `--kv-unified` (dense attention) | 9.96 | 9.73 | 45 % | 4.76 / 10.59 |

† one stalled prompt in that pass (§12). Within run-to-run jitter in every cell. The audit's hypothesis that dense attention under `--kv-unified` costs a fixed ~38 ms per verify step is **not borne out on this ring at ctx 1536**: the host term is dominated by the 46-layer MoE verify itself, and at this context length the sparse-attention gather has nothing to save. Lever 2 is a null result here, measured with and without speculation, on LAN and internet.

Chain 8, `--kv-unified` replicate: c1 7.51 tok/s (38 %, 3.69 tokens/step), c3 4.22 per stream / 10.44 aggregate — same as the QSA arm at c1, and it shows the QSA arm's c3 collapse was a one-off stall.

## 14. Remeasure design (all levers, one window)

Binaries: `/tmp/llama-full-lab` = lab tree + MTP port + wire patch (protocol 8.1), built at `/tmp/llama-full-lab-build`; both Legions rebuilt from the same `ggml-rpc` sources (`scratchpad/e2e/legion-rebuild-full.sh`) so client and servers move to 8.1 together. Operator `scratchpad/run-fnring-full.sh` = `run-fnring.sh` plus knobs `GETPIPE` (`GGML_RPC_GET_PIPELINE`), `WIRE` (`GGML_RPC_WIRE=f16|q8`), `STRACE` (`GGML_RPC_SERVER_TRACE` on the Legion servers, logs pulled into the evidence dir). Every arm keeps forwarding + pipelined dispatcher + `--parallel 3` + split 1,1,46 + ctx 1536, internet path, Zagreb edge. Arms, in order, each with the greedy baseline of its own window as parity reference:

1. nospec, GETPIPE=1 — isolates lever 1 (batched boundary GETs) against §6.
2. nospec, GETPIPE=1, WIRE=f16 — adds lever 5; then WIRE=q8.
3. MTP chain 4, GETPIPE=1 — the best chain with lever 1.
4. MTP chain 4, GETPIPE=1, WIRE=f16 — everything on.
5. Server trace on for one nospec and one chain-4 arm — per-leg timeline (transit, compute, push, wait, reply) to split GET#1.

Then a LAN pass of arms 1 and 4 to bracket the fabric (lever 4) once more with the final stack.

## 15. Long chains at `--parallel 1` (window `fnring-mtp1-20260904T073704Z`, `--kv-unified`, internet)

| chain | c1 per stream | acceptance | tokens / step |
|---|---|---|---|
| nospec | 4.93 tok/s | – | 1.00 |
| 10 | 6.98 (min 4.82) | 32 % | 3.80 |
| 12 | 7.37 (min 4.34) | 28 % | 3.84 |

Full chain curve on this ring (c1, internet): 4 → **10.9**, 6 → 9.9, 8 → 7.6, 10 → 7.0, 12 → 7.4. Tokens per verify step saturate near 3.8 while the verify trip keeps growing; chain 4 is the optimum by a wide margin. Baseline replicates across five windows: 4.61, 4.69, 4.76, 4.84, 4.93 tok/s at c1 — the reference is stable to ±4 %.

## 16. Remeasure, internet, protocol 8.1 client + servers (window `fnring-remeasure-20260904T074556Z`, `--parallel 3`, QSA on, server trace on)

**Lever 1 on the real ring — batched boundary GETs (`GGML_RPC_GET_PIPELINE=1`):**

| arm | c1 per stream | c3 per stream | c3 aggregate |
|---|---|---|---|
| nospec, 8.1 stack, GETs serialized | 4.63 tok/s (219 ms) | 3.81 | 7.38 |
| nospec, batched GETs | **6.70** (149 ms, +45 %) | 5.01 | 8.04 |

Trace budget (medians): GET#1 124.8 → 118.4 ms, **GET#2 54.6 → 5.3 ms**, host 33.4 → 45.2 (the second tensor's copy now lands inside the host gap), sum 214.0 → 168.9, cycle 221.7 → 172.5. The client trace shows two `WRITE cmd=8` before a single `READ … waiting` per token. The two boundary tensors are now identified by name and shape from the WIRE trace: `l_last-2` (the hyper-connection residual, F32 `[2560,4]`, 40 KiB) and a reshaped `[10240]` copy of the same residual that the scheduler fetches as a separate input — 40 KiB each, so the ring was paying a full serialized round trip for a duplicate view. The 8.1 client and servers behave identically to 8.0 with the toggles off (baseline 4.63 within the 4.6–4.9 band).

Operator defect in this window: the `GGML_RPC_WIRE` value was expanded after a line continuation and executed as a command, so the two wire arms (`ns-gp-f16`, `ns-gp-q8`) failed to start (`GGML_RPC_WIRE=f16: command not found`). Fixed (`GGML_RPC_WIRE=${WIRE:-off}`, "off" is the client's documented no-op); the wire arms rerun in a follow-up window. The chain-4 arm of this window is unaffected.

**Chain 4 + batched GETs (the best internet configuration measured):**

| arm | c1 per stream | c3 per stream | c3 aggregate | acceptance | tokens / step |
|---|---|---|---|---|---|
| chain 4 (§12, serialized GETs) | 10.89 tok/s | 5.23 | 13.98 | 59 % | 3.15 |
| **chain 4 + batched GETs** | **12.59** (min 11.27) | 6.17 | **15.66** | 59–61 % | 3.15 / 3.25 |

Budget: cycle 234.7 ms = GET#1 164.0 + GET#2 0.0 + host 69.5 + ~1 (sum 233.6); 234.7 / 3.15 = 74.5 ms per token = 13.4 tok/s server-side, 12.6 at the client (the difference is per-request HTTP overhead and prompt processing in the client's wall clock). Parity vs greedy: c1 5/6 identical (same prompt diverges at 58 %), c3 3/6 — unchanged from §12, so batching the GETs changes nothing numerically.

**Per-leg split of one ring trip** (server trace `GGML_RPC_SERVER_TRACE=1` on both Legions + client trace; `scratchpad/srv-leg-budget.py`; legs that start and end on the same machine are clock-offset-free, the two cross-machine legs are consistent with the ~10 ms one-way edge RTT plus stack and are reported as measured):

| leg | nospec, serialized GETs | nospec, batched GETs | chain 4, batched GETs |
|---|---|---|---|
| client SET write → L1 receive (M5→edge→L1) | 17.6 ms | 18.2 | 23.3 |
| L1 compute (1 layer, GTX 1650 Ti) | 3.2 | 5.1 | 6.8 |
| L1 push send (socket write) | 0.2 | 0.2 | 0.2 |
| L1 push begin → L2 push receive (L1→edge→L2 peer tunnel) | **51.7** | **44.4** | **63.4** |
| L2 wait satisfied → compute begin | 3.6 | 4.5 | 0.7 |
| L2 compute (1 layer, GTX 1650) | 1.4 | 2.4 | 3.3 |
| L2 reply sent → client GET done (L2→edge→M5) | **40.7** | **39.3** | **60.4** |
| M5 host (46 layers + head + sampling [+ draft]) | 33.4 | 45.2 | 69.5 |
| cycle (client) | 221.7 | 172.5 | 234.7 |

Legion compute is 5–10 ms of a 172–235 ms trip. Everything else is transport through the Cloudflare stack: three tunnel legs of 18 + 44 + 39 ms at one token, growing to 23 + 63 + 60 with the 5-position verify batch (200 KiB per boundary instead of 40). That growth is the payload cost lever 5 targets. The remaining unattributed time in the batched-GET cycles (≈ 172.5 − (18.2+5.1+0.2+44.4+4.5+2.4+39.3+45.2) ≈ 13 ms) is the client's own writes and scheduler work between legs plus the medians-of-parts effect; the serialized baseline additionally carries the 54 ms GET#2 round trip inside its reply leg.

## 17. LAN bracket with the final stack (window `fnring-remeasure-lan-*`, SSH forwards over Wi-Fi, direct Wi-Fi peer push, 8.1 client + servers, `--parallel 3`)

| arm | c1 per stream | c3 per stream | c3 aggregate |
|---|---|---|---|
| nospec, serialized GETs | 5.73 tok/s | 5.47 | 14.58 |
| nospec, batched GETs | **9.30** (+62 %) | 6.83 | **17.75** |
| chain 4, batched GETs, F16 wire | **18.17** (min 13.85), 60 % acc, 3.17 tok/step | – | – |

Batched-GET budget on LAN: cycle 113.0 ms = GET#1 70.7 + GET#2 8.2 + host 29.8 (+~4), from 176 with serialized GETs (§3). On the LAN the second fetch was 40 of 176 ms, so removing it is worth more here (+62 %) than on the internet (+45 %).

F16 wire confirmed active from the client trace: each of the two boundary tensors at the 5-position verify batch goes `raw=204800 mode=f16 enc=102400` on FWD and GET, no fallback to raw. **Parity, however, changed:** chain 4 + batched GETs + F16 wire matches the greedy baseline on only 1/6 prompts (median common prefix 77 %, min 9 %), whereas chain 4 + batched GETs with a raw wire matched 5/6 (median 100 %, §16). F16 rounding of the hyper-connection residual (values are re-quantised at every boundary, twice per trip, and again on the push) perturbs the greedy argmax on this model. So on Flash-Next the F16 wire is a **speed-for-exactness trade**, not a free lever; the internet window (§18) separates the wire's own effect from the draft's by running nospec + F16 and nospec + Q8 against the greedy reference.

LAN final-stack budgets and per-leg splits (server trace on both Legions):

| term | nospec, batched GETs | chain 4 + batched GETs + F16 |
|---|---|---|
| client SET → L1 receive | 8.2 ms | 8.8 |
| L1 compute | 3.2 | 6.8 |
| L1 → L2 push transit (direct Wi-Fi peer) | 26.2 | 33.1 |
| L2 compute | 1.4 | 3.3 |
| L2 reply → client GET done | 19.5 | 29.9 |
| client budget: GET#1 / GET#2 / host | 70.7 / 8.2 / 29.8 | 106.7 / 11.7 / 73.6 |
| cycle | 113.0 (121 per-leg match) | 194.5 |
| per accepted token | 113 | 194.5 / 3.17 = 61 ms |

Even on a 7 ms LAN each RPC leg costs 2–4× the ICMP round trip (8 / 26 / 20 ms): the ssh forward + websocat hop framing and the RPC command framing dominate the air time. With F16 the 5-position boundary payload halves (200 → 100 KiB) and the LAN push/reply legs come in at 33/30 ms versus 63/60 on the internet with raw payloads (§16), but the F16 parity loss (§17) stands.

## 18. Lever 5 verdict: wire compression is lossy on Flash-Next (window `fnring-wire-20260904T080352Z`, internet, `--parallel 3`, batched GETs on)

| arm (no draft) | c1 per stream | identical to greedy raw | common prefix median / min |
|---|---|---|---|
| batched GETs, raw wire (§16) | 6.70 tok/s | 6/6 (it *is* the greedy reference path) | – |
| batched GETs, **F16 wire** | 6.64 | **2/6** | 77 % / 34 % |

F16 confirmed on every GET (890 `mode=f16` transfers). Speed: no change on the internet at single-token payloads (40 KiB → 20 KiB per tensor is invisible behind the ~38 ms per-leg stack; the agent's delay-line already showed the bytes only matter under a bandwidth cap). Exactness: rounding the hyper-connection residual to F16 at each of the three boundary crossings per token changes the greedy argmax on 4 of 6 prompts. On Qwen3.5-2B the same wire flipped 0 tokens in 43 runs; Flash-Next's 4-stream residual is evidently near-tie-dense enough that 11-bit mantissas are not enough. **Lever 5 is closed for the stated goal (accuracy preserved): F16 and Q8 are not lossless on this model, and F16 does not even buy speed on the internet path. It buys ~25 % of the LAN chain-4 trip (§17) at the cost of exactness; that trade is the user's to make, not a default.**

## 19. Scoreboard: every configuration measured, 3-node Flash-Next ring, `--parallel 3` unless noted

Client-side per-stream medians over 6 prompts × 64 tokens (4 prompts in the first two windows); aggregate = 3 concurrent streams. Windows named for the evidence dirs under `sin-harness/data/legion-goal/`.

| # | path | draft | GETs | wire | c1 tok/s | c3 agg tok/s | exact vs greedy (c1) | window |
|---|---|---|---|---|---|---|---|---|
| 1 | internet | – | serial | raw | 4.58–4.93 (7 windows) | 10.3–11.4 | reference | trace-qsa, inet3, mtp3*, remeasure, wire |
| 2 | internet | – | **batched** | raw | **6.70** | 8.04† | 6/6 | remeasure |
| 3 | internet | – | batched | f16 / q8 | 6.64 / 6.52 | 13.96 / 14.82 | 2/6 / 3/6 | wire |
| 4 | internet | chain 4 | serial | raw | 10.89 | 13.98 | 5/6 | mtp3b |
| 5 | internet | chain 6 / 8 | serial | raw | 9.93 / 7.56 | 11.15 / 10.44 | 3/6 / 2/6 | mtp3b, mtp3c |
| 6 | internet, `--parallel 1` | chain 10 / 12 | serial | raw | 6.98 / 7.37 | – | 2/6 | mtp1 |
| 7 | internet | **chain 4** | **batched** | raw | **12.59** | **15.66** | 5/6 | remeasure |
| 8 | internet | chain 4 | batched | f16 / q8 | **14.92** / 14.27 | 15.16 / **16.62** | 1/6 / 5/6 | wire |
| 9 | LAN | – | serial | raw | 5.64–5.86 | 14.2–14.6 | reference | lan3, remeasure-lan |
| 10 | LAN | – | batched | raw | **9.30** | **17.75** | 6/6 | remeasure-lan |
| 11 | LAN | chain 4 | batched | f16 | **18.17** | 18.15 | 1/6 | remeasure-lan |

† the c3 pass of that arm ran into the same 3-stream contention that makes batched GETs pay less at c3 (three slots share one ring trip either way).

Best exact configuration over the public internet: **row 7, 12.59 tok/s per stream / 15.66 aggregate**, 2.7× the starting point (4.6). Best exact on the LAN without a draft: row 10. Fastest measured over the internet: row 8 at 14.9 tok/s (F16 wire) and 16.6 aggregate (Q8 wire); fastest anywhere: row 11 at 18.2 tok/s on the LAN. Rows 3, 8 and 11 are not exact (§18).

## 20. Where every millisecond goes (final stack, internet, chain 4 + batched GETs, one verify trip of 3.15 accepted tokens)

```
client writes SET+RECOMPUTE+FORWARD to L1, WAIT+RECOMPUTE+GET+GET to L2   ~1 ms
M5 -> edge -> L1 (SET receive)                                              23 ms   transport
L1: 1 layer, 5-position batch, GTX 1650 Ti                                   7 ms   compute
L1 -> edge -> L2 peer tunnel (push of both boundary tensors)                63 ms   transport
L2: wait satisfied -> compute -> 1 layer                                     4 ms   compute
L2 -> edge -> M5 (both GET replies, issued together)                        60 ms   transport
M5: 46 layers x 5 positions + output head + draft chain of 4 + sampling     70 ms   compute
client-side gaps between legs (scheduler, sampling hand-off)                ~7 ms
                                                                    cycle  235 ms   (measured 234.7; per-term medians sum to 233.6)
per accepted token = 235 / 3.15 = 74.5 ms -> 13.4 tok/s server-side, 12.6 client-side
```

Transport is 146 of 235 ms (62 %); Legion compute 11 ms (5 %); M5 compute 70 ms (30 %). Of the transport, ~30 ms is wire (three ~10 ms one-way edge legs) and ~115 ms is the Cloudflare quick-tunnel stack (cloudflared QUIC + TLS + WebSocket + bridge, ~27 ms per leg measured in §9, growing with the 200 KiB verify payload).

## 21. Gap audit

- Every client-side cycle budget in this report sums to its measured cycle within 1–5 ms (medians of parts vs median of the whole); the per-leg server splits account for the client budget's GET#1 term to within the client-side gaps listed. No term is inferred.
- The one term that cannot be split further with these tools is the ~27 ms per leg inside the Cloudflare stack; it is measured as a black box (§9) and bounded below by the 10 ms ICMP round trip.
- Chain-8 c3 in `mtp3b` (4.50 aggregate) is a transient stall; the replicate (`mtp3c`) gave 10.44. Both are reported.
- The first MTP window's `--kv-unified` fell through to the default; corrected in `mtp3c`, both variants reported (§13).
- The remeasure window's wire arms failed on an operator quoting bug; rerun in `fnring-wire`. Reported, not hidden.
- Parity criterion: bit-identical greedy output against the same window's no-draft raw-wire run. Batched verification on this Metal backend is known not to be bit-reproducible across batch compositions (fork/commit addendum §1.6), so chain arms at 5/6 are at the documented ceiling; F16 arms at 1–2/6 are below it and attributable to the wire (§18).

## 22. Verdict against the goal

- `--parallel 3` runs in every arm: 3 streams ride one ring trip; aggregate 2.1–3.1× single-stream on the LAN, 1.5–2.3× on the internet.
- Levers 1–6, done and measured: (1) the "unexplained 65 ms" was a serialized second boundary fetch, removed by batched GETs, +45 % internet / +62 % LAN; (2) `--kv-unified` on/off: null, with and without a draft; (3) MTP head ported and running on the ring, first ever, chain 4 optimum, 2.3× alone and 2.7× with lever 1; (4) fabric: each tunnel leg costs ~38 ms of which ~10 is wire; a direct path is not realisable in this rig (one public IP, no relay), so the internet numbers carry ~115 ms of tunnel stack per trip that a WireGuard mesh between real sites would not; (5) F16/Q8 wire: built, parity-verified on the 2B, **lossy on Flash-Next**, closed for the exactness goal; (6) chain sweep 4–12: monotone downward past 4 on this ring.
- Remeasured, all: rows 1–11 above.
- 20 ms per token was the "out of the box" target: with everything exact the internet ring stands at 74.5 ms per accepted token (12.6 tok/s), the LAN ring at 61 (18 tok/s, not exact) or 108 (9.3, exact). Reaching 20 ms needs the ~115 ms of tunnel stack gone (a real multi-site fabric) *and* a bigger accepted-tokens-per-trip multiplier than a chain MTP can give on this model (tree drafts, no head exists for Flash-Next), *and* GPU nodes that can hold more than one layer so the M5's 70 ms verify share moves off the critical path.

Addendum to §18, full wire matrix (internet, batched GETs; parity = identical outputs to the same window's greedy raw run, c1 / c3):

| arm | c1 tok/s | c3 agg | identical c1 | identical c3 | prefix median c1 |
|---|---|---|---|---|---|
| nospec raw | 4.58 (serial GETs, this window's reference) | 10.66 | – | – | – |
| nospec f16 | 6.64 | 13.96 | 2/6 | 2/6 | 77 % |
| nospec q8 | 6.52 | 14.82 | 3/6 | 4/6 | 100 % |
| chain 4 f16 | 14.92 | 15.16 | 1/6 | 3/6 | 77 % |
| chain 4 q8 | 14.27 | 16.62 | 5/6 | 4/6 | 100 % |

Two things the matrix settles. (a) The wire's *speed* value on the internet appears only when payloads are large: nothing at one token (6.6 vs 6.7 raw), +19 % at chain 4 (14.9 vs 12.6) and +74 % at c3 without a draft (14.0–14.8 vs 8.0), because the 3-slot and 5-position batches turn a 40 KiB tensor into 120–200 KiB, at which point bytes through the tunnel stack cost real time. (b) The wire's *exactness* loss is not monotone in precision: Q8_0 (block-scaled, 8-bit) matched greedy on as many prompts as the raw chain-4 run (5/6 at c1), while F16 matched 1–2/6. Q8_0's per-32-value scale preserves relative precision on the hyper-connection residual better than F16's fixed 11-bit mantissa where the residual's dynamic range is wide. Neither is bit-exact; both perturb near-ties; which prompts flip is effectively random. For the accuracy-preserving goal, wire compression stays off; if a deployment accepts near-greedy output, **Q8 is the mode to use, not F16** — it is at least as fast and measurably closer.
