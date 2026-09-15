# Slot count vs latency on the two-Mac split

Measured 2026-09-13 on the live mesh (`qwen3.8-27b`, 12 layers on
**MBP-od-Veimir**, 52 + output on **Lotars-MBP.home**, relay transport). Harness `ctxconc.py`;
raw rows `ctxconc-raw-20260913.jsonl`.

Same configuration as the ctx sweep in `CTX_SWEEP_MAC2MAC_20260913.md`, except that the deployment's
slot count (`--parallel`) is the variable. **N concurrent streaming requests** per level, so
contention is present rather than assumed. Prompt ~500 tokens, 64-token answers, temperature 0,
seed 42, one warmup request before measuring.

The previous sweep could only report the controller's periodic link RTT, which describes the link and
not a request. These are per-request: **TTFT** is wall clock to the first content token, measured from
the client.

**Interactive view:** [`ctx-charts.html`](ctx-charts.html) renders both sweeps as charts from these same raw rows (self-contained; open it directly, no server needed).

## Results

### ctx 4096

| parallel | TTFT min | TTFT median | TTFT max | total median | aggregate tok/s | per-stream tok/s | answers |
|---|---|---|---|---|---|---|---|
| **1** | 7,452 ms | 7,452 ms | 7,452 ms | 7,622 ms | 5.12 | 5.12 | 1 |
| **4** | 14,311 ms | 14,497 ms | 14,497 ms | 14,714 ms | 10.6 | 2.69 | 1 |
| **8** | 24,697 ms | 24,993 ms | 24,995 ms | 25,927 ms | 12.03 | 1.5 | 1 |
| **16** | 46,629 ms | 47,261 ms | 48,113 ms | 47,263 ms | 12.64 | 0.8 | 1 |

### ctx 262144

| parallel | TTFT min | TTFT median | TTFT max | total median | aggregate tok/s | per-stream tok/s | answers |
|---|---|---|---|---|---|---|---|
| **1** | 7,498 ms | 7,498 ms | 7,498 ms | 7,649 ms | 5.1 | 5.1 | 1 |
| **4** | 15,075 ms | 15,338 ms | 15,341 ms | 15,540 ms | 10.04 | 2.54 | 1 |
| **8** | 21,381 ms | 21,685 ms | 21,689 ms | 22,485 ms | 13.87 | 1.73 | 1 |
| **16** | 45,724 ms | 46,318 ms | 46,913 ms | 46,906 ms | 13.05 | 0.83 | 1 |

## Findings

**1. Time to first token scales linearly with slot count.** 7,452 ms at one slot,
46,629 ms at sixteen — each doubling roughly doubles the wait (×1.92, ×1.73, ×1.89).
A caller's first token arrives after the ring has finished other callers' prompt work: slots serialize
prompt evaluation rather than parallelising it.

**2. Aggregate throughput saturates, while per-stream throughput collapses.** Aggregate rises
5.12 → 10.6 → 12.0 → 12.64 tok/s (×2.5 for ×16 the slots, and nearly
nothing beyond 8). Meanwhile the median caller drops from 5.12 to 0.8 tok/s — **6.4×
slower each**. Slots past ~8 buy no aggregate throughput and cost latency directly.

**3. Context size is irrelevant to this axis.** Every pair (4096 vs 262144) lands within noise, and
two levels were marginally *faster* at 262144. Consistent with the ctx sweep: window size does not
drive this system's speed. Slot count does.

**4. Concurrency does not corrupt output.** At every level all concurrent requests produced the
identical answer (`answers = 1`). Requests sharing the ring did not interfere with one another's
results.

**5. Prompt evaluation dominates TTFT, not the network.** At one slot a ~500-token prompt takes
7,452 ms to first token, i.e. an effective ~67 tok/s of prompt processing — far below the
256 tok/s the deep probes reached on long prompts. The gap is prompt shape and the streaming path, not
transport. **The immediate implication for users: on this split, prompt length is latency.**

## Interpretation for operating this**

| goal | setting | why |
|---|---|---|
| interactive use | **parallel 1–2** | TTFT stays under ~8 s; each caller gets the full ring |
| small team / batch | parallel 4–8 | ~2× aggregate for ~2× TTFT — the only region where both numbers improve |
| maximum off-peak throughput | parallel 8–16 | ~12–14 tok/s aggregate ceiling; do not expect it for interactive work |

Do not read the aggregate as a single conversation's speed: it is the sum over concurrent callers, each
of which is slower than it would be alone.

## Gaps and issues found

* **TTFT is not decomposed.** The harness records client wall clock and token counts but did not
  capture the engine's own `prompt_ms`/`predicted_ms` on the streaming path, so queueing versus prompt
  evaluation cannot be separated from this data. The design intended that subtraction; it was not
  implemented. Treat the ~67 tok/s prompt figure as inference.
* **Relay byte accounting failed again** (same defect as the ctx sweep). Per-token network cost remains
  unmeasured; do not quote bandwidth from either document.
* **One prompt shape, one repetition.** Repeated-sentence filler may behave differently from natural
  text (tokenizer locality, prefix caching — note `--cache-ram 0` disables the prompt cache, so every
  request re-evaluates its whole prompt).
* **`--parallel N` was paired with exactly N concurrent requests.** Whether TTFT saturates below the
  slot count (i.e. whether the ceiling is slots or the ring) is not established.

## Not yet visible in the UI, and what it would take

The Throughput tab shows per-node/per-model **link RTT** and relay rates, both real. It does **not**
show TTFT, because nothing server-side measures it:

1. `node-agent/inference.ts` proxies every completion and would have to timestamp first content per
   request (it already streams, so the hook exists),
2. the agent would report a rolling TTFT (p50/p95) with its metrics, likely per assignment, and
3. `control/telemetry.ts` already has the field list to carry it (`tokPerSec`, `inflight` are there),
   so a `ttftMs` field would follow the existing sampling path and the Throughput tab could render a
   latency column with the same one-second stream it already consumes.

That is a contained change in three files, but it ships as an agent release and therefore updates all
nodes.
