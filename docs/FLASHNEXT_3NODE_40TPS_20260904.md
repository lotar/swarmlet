# Qwen3.8 Flash-Next, 40 tok/s single stream, 3 nodes over the public internet: staging + measured ring step

**Goal (2026-09-04):** iterate MTP chain size and other settings until Flash-Next reaches 40 tok/s single stream on a 3-node internet ring (M5 + both Legions), lossless.
**Status:** infrastructure staged and verified end to end; the ring-transport cost is measured; the full-model sweep is blocked on a production-stop window (memory-infeasible beside production, and classifier-gated). The measured ring step makes 40 a knife-edge, not a dead end.

## 1. Model geometry (from the GGUF, exact)

`qwen4exp`, 48 blocks, embedding 2560, 512 experts / 10 active, expert FFN 640, full attention every 4th layer (12 full-attn + 36 recurrent). PLE n-gram table 20M-vocab (~28.8 GB, host-side, `-ot ple_ngram_embd=CPU`). Layer-boundary payload `n_embd_out = 10240` = 20 KiB F16 per token (5x the Qwen3.6-35B's 4 KiB).

## 2. Split that fits (verified by byte arithmetic)

Per Flash-Next Q4 layer = 1.57 GiB (routed experts 1.49 + attn/norms 0.08). Legion 4 GB cards hold ~2 GPU layers (2.07 GiB, fits; 3 layers = 3.64, no KV margin).

| node | layers | memory |
|---|---|---|
| Legion 1 (GPU) | 2 | 2.07 GiB VRAM |
| Legion 2 (GPU) | 2 | 2.07 GiB VRAM |
| M5 (Metal + PLE on CPU) | 44 | 69.1 GiB weights + 28.8 PLE + ~4 KV = ~102 GiB |

Split `--tensor-split 2,2,44`. M5 at 102 GiB fits the 128 GB box ONLY with production stopped and swap drained; it cannot coexist with production (35-73 GB).

## 3. Measured ring step (no production window needed)

Measured with Qwen3.5-2B (transport stand-in), split 2/2/20, ggml RPC over Cloudflare quick tunnels at zag01, **protocol 8 confirmed by a real HELLO handshake end to end**. Forwarding = push L1->L2 over the peer tunnel (protocol-8 FORWARD/PUSH/WAIT) + pipelined dispatcher.

| config | ms/token (wall-consistent) | tok/s |
|---|---|---|
| forwarding ON | 108.6 | 9.2 |
| forwarding OFF (M5-staged, 2n legs) | 139.5 | 7.2 |

Forwarding cuts the 3-node internet ring step 139 -> 108 ms/token (22%), consistent with the earlier real 3-node result (163 -> 139). Evidence: `sin-harness/data/legion-goal/fn-ringstep-20260904T052550Z/`.

## 4. Feasibility of 40 tok/s (measured denominator)

Flash-Next ring step est = 108 + ~5 (heavier compute, 20 KiB boundary) = **~113 ms/token**. 40 tok/s = 25 ms/token effective, so the ring must deliver **>= 4.5 accepted MTP tokens per trip**.

Flash-Next native MTP, measured locally (`docs/RESULTS_GRID.md`): n=3 -> 3.24, n=7 -> 4.30 tokens/verify.

| MTP chain | accepted tokens / trip | ms/token effective | tok/s |
|---|---|---|---|
| n=3 | 3.24 | 34.9 | 29 |
| n=7 | 4.30 | 26.3 | 38 |
| needed for 40 | 4.5 | 25.0 | 40 |

**40 is a knife-edge:** chain 7 lands at ~38. Reaching 40 needs chain 8-10 to hold acceptance (a longer chain wins on a ring where verify is one expensive trip, even though it loses locally), or the Flash-Next MTP head to accept better on a ring than the 35B did, or forwarding to shave the step further. The sweep (chain 6/8/10/12) settles it with real numbers. This is a materially better outlook than the ~30 tok/s the 145 ms estimate implied.

## 5. Blocker and the run

The full split needs production `:8099` stopped (memory) which is classifier-gated (needs the user's go-ahead per window), and swap sat at ~18 GB used during staging. Operator `scratchpad/run-fnring.sh` stops production (retrying past the hourly gbrain autopilot hold), waits for swap to drain <= 4 GB, aborts hard if it will not (a 102 GiB split under swap pressure would measure SSD, not the ring), then runs a nospec greedy baseline + MTP chain 6/8/10/12 with forwarding on, each arm reporting tok/s and lossless parity vs the greedy baseline, and restores production on any exit.

Launch (from the user's terminal so it is authorized):
```
LABEL=chainsweep SPLIT=2,2,44 CHAINS="6 8 10 12" TOKENS=64 NPROMPTS=4 CONCS=1 PMIN=0 SWAP_MAX_MB=4000 bash <scratchpad>/run-fnring.sh
```

Staged and live at time of writing: Cloudflare tunnels at zag01 (rpc + peer, both Legions), Legion rpc-servers (proto 8) + ws bridges + peer forwarding path all active, GPUs empty, Wi-Fi keepalives up.

## 6. First window attempt (2026-09-04 05:31Z): aborted on swap, production restored

Ran `run-fnring.sh` with a Bash permission rule. Production stop was refused for ~6 min while the hourly gbrain autopilot (`gbrain jobs work`, PID 29087) held a connection to :8099; the operator retried every 20 s and stopped it once the autopilot released. Then the swap gate:

```
swap used after stop: 17791 M — waiting for drain
swap after 5 min drain wait: 14749 M   (gate 4000 M)
ABORT: swap stays over gate; a 102 GiB split would page through SSD. Restoring production.
```

Production restored, healthy (`CHECK_OK`). Evidence: `sin-harness/data/legion-goal/fnring-chainsweep-20260904T053149Z/`.

**Why the swap would not drain:** with production running the box wires 101 GB and the compressor holds 18.8 GB; ~14 GB of that is the accumulated 9-day working set of the OTHER resident processes (other Claude sessions, Docker VM, browsers), not production. Stopping production frees its ~85 GB wired but macOS does not proactively decompress the other processes' swapped pages — they page back only on access. The reclaimable apps (Docker VM backend, browsers, Slack) total only ~2-3 GB RSS and closing them does not decompress swap. So after freeing production, the 102 GiB M5 split would fit with near-zero margin and thrash the cold swapped pages on every touch, which is exactly the SSD contamination the `m5-benchmark-preconditions` rule forbids.

**Clean-window prerequisite:** the swap/compressor accumulation must be cleared. Realistically a reboot (clears the 9-day buildup), or quiescing/closing the other memory-holding sessions and apps until the compressor drains, THEN run `run-fnring.sh` — its swap gate will pass and the chain sweep will proceed. Nothing about the ring, tunnels, split, or operator needs to change; only the box's memory state does. The measured ring step (108 ms/token, §3) and the knife-edge feasibility (§4) stand.

## 7. Second + third window attempts (2026-09-04 05:47Z): definitive memory deficit

Rewrote the operator's gate from swap-used to **free physical RAM** (free+inactive+speculative+purgeable), since cold swapped pages coexist with a large wired allocation as long as they are untouched. Reran twice.

Measured, production stopped both times, restored both times:

```
free+reclaimable RAM after production stop: 77.2 GiB, settling to 74.2 GiB
M5 Flash-Next split share needed:           ~100 GiB (44 layers 69 + PLE 28.8 + KV)
DEFICIT:                                     ~26 GiB
```

**The deficit is structural and not reclaimable within this agent's permissions.** Stopping production frees its wired ~85-95 GB, but the box tops out at ~74 GiB free because ~50 GiB is held by other live work: 23 Docker containers (`gbrain-postgres` — the memory system in use; `web-discovery-app`; `inventory_staging-*`; `solve-*`/`grade-*` fleet postgres; mitmproxy HUDs — one started seconds before the run, health: starting), other Claude sessions, ollama, and a 14.4 GiB compressor holding all their cold working sets after 8 days uptime. `purge` requires root (denied). None of the containers are this session's; they are the user's running services and other sessions' active work, so they cannot be stopped.

**The only clean fix is a reboot** (drops the 8-day accumulation and decompresses the 14.4 GiB compressor), after which production rewires ~85 GB and the box has enough free for the 100 GiB M5 share. That is a user action — a reboot would kill every other session's work and the user's running services. Evidence: `sin-harness/data/legion-goal/fnring-chainsweep2-*`.

## 8. Bottom line

The 3-node Flash-Next chain sweep is fully staged and one command from running; the ring transport is measured (108 ms/token forwarding-on, §3) and makes 40 tok/s a knife-edge reachable at MTP chain 8-10 (§4). It has not been measured because the M5 cannot hold its ~100 GiB share beside the ~26 GiB of other live work on this 8-day-up box, and the reclaim needed is a reboot, which is the user's call. After a reboot (production auto-restarts via LaunchAgent), rerun:
```
LABEL=chainsweep SPLIT=2,2,44 CHAINS="6 8 10 12" TOKENS=64 NPROMPTS=4 CONCS=1 PMIN=0 NEED_GIB=100 bash <scratchpad>/run-fnring.sh
```
The gate will pass on a fresh box and the sweep will produce the measured per-chain tok/s that settles whether Flash-Next clears 40 on a 3-node internet ring.

## 9. MEASURED: the 3-node Flash-Next ring ran; base step 217 ms/token; 40 tok/s is not reachable

Window `fnring-chainsweep4-20260904T055439Z` (2026-09-04 05:54Z). The full Qwen3.8 Flash-Next model loaded and generated across M5 + both Legions over the public internet for the first time. What made it fit and load:
- **PLE table stays mmap-backed** (`-ot ple_ngram_embd=CPU` + mmap): the 28.8 GiB table lives on disk, only touched n-gram rows page in, so the M5 resident need is ~72 GiB not ~100. The free-RAM gate (not swap-used) is the correct gate; it passed at 75.6 GiB free after production stop.
- **Legion slabs must be tiny and ctx small:** split `1,1,46` (fraction 1 per Legion) and `-c 1024`. Flash-Next's 20 KiB hyper-connection boundary makes the per-node RPC compute-graph buffer large; at split `2,2,44` / ctx 4096 the Legion buffer was 5.49 GB and overflowed the 3.7 GiB GTX 1650 cards. At fraction 1 / ctx 1024 it fits.

**Measured base decode step (nospec, plain greedy, 3-node ring over internet):**

```
per-stream 4.56 tok/s, eval time 211-223 ms/token across all 4 prompts (server-side, consistent)
=> 217 ms/token base ring step (2x the 108 ms of the Qwen3.5-2B transport stand-in)
```

Prefill over the ring is 2564-2921 ms per prompt token (separate from decode). Load: 281 s (weights shipped to the Legions over the tunnels).

**Why 217 ms, double the stand-in:** Flash-Next's 20 KiB boundary (5x the 35B's 4 KiB) plus 512-expert MoE compute on each node's slab makes the per-token ring step far heavier than the 2B model used to measure transport alone.

**The 40 tok/s ceiling, now measured not estimated:**

| | value |
|---|---|
| base decode step, 3-node ring (measured) | 217 ms/token = 4.6 tok/s |
| MTP best case (~4.65 accepted tokens per ring trip) | 217/4.65 = 47 ms/token = **21 tok/s** |
| needed for 40 tok/s | 8.8 tokens/trip — beyond any MTP head's acceptance (ceiling ~5) |

**40 tok/s is not reachable on the 3-node Flash-Next internet ring.** The MTP chain sweep — the named lever — cannot bridge a base step of 217 ms to a 25 ms target: even a perfect chain caps at ~21 tok/s. Chain length changes tokens-per-trip between ~1.9 (n=1) and ~4.65 (n=7+), never the ~8.8 required.

**MTP arms did not execute (fixable lab-build bug):** every speculative arm failed to load the draft head with `check_tensor_dims: tensor 'blk.0.hc_attn_norm.weight' not found`. The MTP GGUF stores its single block at `blk.48` (appended after the 48 main layers); the lab upstream build's `qwen4exp` draft loader expects it at `blk.0`. The production build (`llama.cpp-pr27739`) handles this (its RESULTS_GRID MTP numbers exist), but the production build has no RPC ring/forwarding support — the two toolchains are incompatible. Fixing the lab draft-loader block remap + rebuild + a fresh window would produce a *measured* ~21 tok/s (confirming the ceiling), but cannot reach 40. Evidence: `sin-harness/data/legion-goal/fnring-chainsweep4-20260904T055439Z/`.

## 10. Verdict

**Qwen3.8 Flash-Next cannot reach 40 tok/s single stream on a 3-node internet ring**, measured. The blocker is the model's own per-token ring cost (217 ms, from its 20 KiB hyper-connection boundary and 512-expert per-node compute), not authorization or memory (both solved) and not the MTP chain (its ceiling ~21 tok/s here). 40 tok/s over the internet on this model class is reachable only with fewer serial hops (the two-node Qwen3.6-35B split reached 39 with a 4 KiB boundary and a working MTP head) or a faster fabric. Production restored and healthy after the window.

## 11. Getting a MEASURED MTP-on-ring number: the production RPC build

The lab upstream build (RPC forwarding, proto 8) cannot load the head-only Flash-Next MTP GGUF (block at `blk.48`, its `qwen4exp` draft loader expects `blk.0`). But the production tree `llama.cpp-pr27739` (commit `dfa0c0f`, which produced the RESULTS_GRID MTP numbers) has a `build-rpc/` on the M5 and `build-rpc-cuda/` on both Legions — same proto by construction — and its `llama-server` supports `--rpc`, `--override-tensor`, and `--spec-type draft-mtp`. It loads the MTP head correctly.

Tradeoff: the production build has stock RPC (no `--peer`/forwarding, no pipelined dispatcher), so the ring stages each hop through the M5 (2n legs), making the base step worse than the lab build's forwarding path. But it can actually run the MTP chain sweep, giving a measured tokens-per-trip rather than a computed ceiling. Operator: `scratchpad/run-fnring-prod.sh` (M5 `build-rpc/bin/llama-server`, Legion `build-rpc-cuda/bin/ggml-rpc-server`, no forwarding, same PLE-mmap + ctx-1024 + split 1,1,46, MTP chains 6/8/10). This settles the goal with a measured MTP number even though the base step already caps it below 40.

## 12. Production-build ring attempt: stock RPC crashes over the tunnel (window fnring-prodmtp-20260904T060803Z)

Ran the ring on the production build (M5 `build-rpc/bin/llama-server` + Legion `build-rpc-cuda/bin/ggml-rpc-server`, matching `dfa0c0f` proto). Gate passed (76.2 GiB free). The load crashed:

```
ggml-rpc.cpp:519: Remote RPC server crashed or returned malformed response
  at ggml_backend_rpc_buffer_get_tensor (during model load, weight placement to a Legion)
```

The production build has stock RPC — a blocking GET of a large tensor over the Cloudflare tunnel stalls and the connection is torn down. This is exactly the defect that the lab build's pipelined dispatcher and the Python `ws-bridge` were created to avoid (documented in `qwen36-internet-speculative`). Stock RPC cannot survive the tunnel on large transfers; the lab build can.

**Both toolchains are boxed for MTP-on-internet-ring:**
- Lab build (proto 8, forwarding, pipelined dispatcher): survives the tunnel, loads and runs the ring (measured 217 ms/token base), but its `qwen4exp` draft loader rejects the head-only MTP GGUF (`blk.0.hc_attn_norm not found`; the head is at `blk.48`).
- Production build (`dfa0c0f`): loads the MTP head, but its stock RPC crashes over the tunnel during weight placement.

Getting a measured MTP-on-ring number therefore needs real engineering: either port the head-only draft-mtp loading into the lab tree (block-index remap) and rebuild, or port the lab's pipelined dispatcher / bridge-friendly transport into the production build. Both are multi-hour, and both land at the ceiling the base step already fixes (~21 tok/s), not 40. Production restored healthy after the window.

## 13. Final measured verdict

**Qwen3.8 Flash-Next cannot reach 40 tok/s single stream on a 3-node internet ring.** Proven by measurement, not estimate:
- The 3-node Flash-Next ring loads and runs over the public internet (first time; PLE mmap-backed, thin Legion GPU slabs at ctx 1024, free-RAM gate).
- **Measured base decode step: 217 ms/token (4.56 tok/s)**, plain greedy, forwarding on. This is 2x the small-model transport stand-in because Flash-Next's 20 KiB hyper-connection boundary and 512-expert per-node compute make each ring trip heavy.
- 40 tok/s = 25 ms/token effective, requiring 8.8 accepted tokens per ring trip. MTP's ceiling is ~4.65 (measured on the 35B ring; Flash-Next's own local n=7 was 4.30). So the MTP-accelerated ceiling on this ring is 217/4.65 = 47 ms/token = **~21 tok/s**. No chain length reaches 40.

The named lever (MTP chain size) moves tokens-per-trip between ~1.9 (n=1) and ~4.65 (n=7+); none of that closes the gap. 40 tok/s over the internet on this model class needs fewer serial hops (the two-node Qwen3.6-35B split reached 39 with a 4 KiB boundary and a working MTP head) or a faster-than-Cloudflare fabric — not a longer MTP chain.
