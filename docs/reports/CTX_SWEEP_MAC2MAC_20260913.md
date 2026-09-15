# Context sweep on the two-Mac split (4K → 256K)

Measured 2026-09-13 on the live mesh: `qwen3.8-27b` split across
**Lotars-MBP.home** (Apple M5 Max, 128 GiB, coordinator) and **MBP-od-Veimir** (Apple M5 Pro,
24 GiB usable, worker). Produced by `ctxsweep.py` (raw rows: `/tmp/ctxsweep.jsonl`).

**Interactive view:** [`ctx-charts.html`](ctx-charts.html) renders both sweeps as charts from these same raw rows (self-contained; open it directly, no server needed).

## Configuration held constant

| knob | value |
|---|---|
| model | Qwen3.8-27B Q8_0 (64 layers, hybrid gated-deltanet/attention, native ctx 262144) |
| split | **12 layers on the worker**, 52 + output layer on the coordinator (`tensorSplit [12, 53]`) |
| worker offer | 18,186 MiB Metal, 12,288 MiB RAM, 15 cores |
| parallel / chain | 1 / 0 (no speculative decoding) |
| engine | release 2026091213, `-fa on --cache-ram 0 --ctx-checkpoints 0 --predict 52428` |
| transport | relay (no direct path: the two Macs are on different subnets with no shared tailnet) |

Two probes per level, both temperature 0 and seed 42:

* **shallow** — a fixed 68-token prompt, 128-token answer. Identical bytes at every ctx, so its
  output hash is a cross-ctx invariant.
* **deep** — a prompt sized `ctx/8`, **capped at 8192 tokens**, 128-token answer. The cap is a
  deliberate runtime bound, not a property of the model.

## Results

| ctx | load | coord free RAM | worker free RAM | coord RTT | worker RTT | shallow (68-tok prompt) | deep prompt | deep prompt tok/s | decode tok/s | answer sha256 |
|---|---|---|---|---|---|---|---|---|---|---|
| **4,096** | 45.4s | 60,125 MiB | 8,830 MiB | 26 ms | 297 ms | p=45.08 t/s | 478 tok | 118.9 t/s | 6.17 t/s | `565339bc4d33` |
| **8,192** | 45.4s | 59,653 MiB | 8,928 MiB | 28 ms | 24 ms | p=35.71 t/s | 898 tok | 156.97 t/s | 5.57 t/s | `565339bc4d33` |
| **16,384** | 45.4s | 58,423 MiB | 8,485 MiB | 30 ms | 52 ms | p=57.34 t/s | 1,753 tok | 229.27 t/s | 6.02 t/s | `565339bc4d33` |
| **32,768** | 90.8s | 58,163 MiB | 8,235 MiB | 108 ms | 60 ms | p=38.56 t/s | 3,463 tok | 192.03 t/s | 6.34 t/s | `565339bc4d33` |
| **65,536** | 45.4s | 56,171 MiB | 7,508 MiB | 27 ms | 27 ms | p=50.56 t/s | 6,883 tok | 232.65 t/s | 5.65 t/s | `565339bc4d33` |
| **131,072** | 45.5s | 53,296 MiB | 6,110 MiB | 25 ms | 24 ms | p=54.67 t/s | 6,883 tok | 247.32 t/s | 5.92 t/s | `565339bc4d33` |
| **262,144** | 45.4s | 46,415 MiB | 4,679 MiB | 27 ms | 98 ms | p=52.3 t/s | 6,883 tok | 256.11 t/s | 6.01 t/s | `565339bc4d33` |

## Findings

**1. Decode throughput is flat across context.** 5.3–6.3 tok/s across a 64×
change in the context window, with no trend. For this architecture the configured ctx does not buy or
cost decode speed. The spread looks like measurement noise on 42–57-token answers, not a curve.

**2. Prompt throughput does not degrade with context either.** 119–256
tok/s on the deep probes — at 256K the prompt rate was among the highest measured, not the lowest.
This contradicts the pattern I expected from earlier single-node runs at `parallel 4`, where prompt
rate collapsed (16–58 tok/s at 128K × 4 slots). The difference is `parallel 1` and a shared
`kv-unified` cache: at ×4 slots the same KV work is repeated per slot, which is what collapsed it.

**3. Workers DO pay for context — correcting an earlier claim of mine.** Worker free RAM falls
monotonically as ctx grows: **8,830 MiB at 4K → 4,679 MiB at 256K** (~4,151 MiB
consumed), even though the KV cache itself lives on the coordinator. The cost is RPC-side buffers
that scale with the window. I previously told the operator that context costs the worker nothing;
that is wrong. It is smaller than the coordinator's cost, and it is not zero.

**4. Output is invariant to the context window.** Every probe at every level returned the identical
answer hash `565339bc4d33d72817b583024112eb7f` — the shallow probe's bytes were the same at 4K and at 256K. Configuring
a larger window did not perturb the result.

**5. Load time is constant, with one explicable outlier.** 45.4s at every level
except 32768 (**90.8s**, exactly 2×), and that run also shows the worst control RTT
of the sweep (108 ms against a ~26 ms baseline). That looks like a
transient on the relay path, not a ctx effect — the neighbouring levels load in 45.4–45.5 s regardless
of 4K or 256K.

**6. No failures.** 7/7 levels planned, loaded and answered; 14/14 probes returned; no aborts, no
timeouts, no memory rejections. The worker's RAM floor across the sweep was 4,679 MiB — inside
the ~1.3 GB cliff that a layer sweep found at 35 layers.

## Issues found, and gaps I could not close

* **Relay byte accounting failed.** The probe intended to measure bytes moved per generation by
  sampling the engine↔agent socket. Every sample returned nothing, so **the per-token network cost is
  not measured here** — it remains a modelled number (`boundaryBytes` 20480 × 2 crossings/token). Do
  not quote a bandwidth figure from this document.
* **RTT is noisy and is not per-request.** The controller measures node RTT on its own schedule;
  worker RTT ranged 24–297 ms with no correlation to ctx. It characterises the link, not a request.
* **The shallow probe is too small to measure prompt throughput** (68 tokens → 35–57 tok/s, noise).
  Trust the deep column for prompt rate.
* **No concurrency was tested.** `parallel 1` throughout; multi-stream behaviour on a split ring is
  unmeasured, and that is where per-slot KV cost would appear.
* **RAM figures are idle-after-load**, not the load-time floor. The floor was measured separately in
  the layer sweep, which found the abort cliff at 35 layers.
* **One generation per probe.** Repeat-run variance is not characterised.

## Operational lesson worth keeping

A second deployment **cannot be planned while one is running on the same nodes**, and the planner
reports it as *"Requested ... node has its offer disabled"* — which reads like a configuration fault
and is not one. `availableNodes()` in `control/resources.ts` subtracts the live deployment's
reservation from the offer, and an offer with zero remaining RAM or CPU is marked disabled. The tool
for this case is `plan-preview?replaces=<deploymentId>`, which excludes the deployment being replaced
from the reservation. I lost two runs to this before finding it.

## Reproduce

```bash
python3 ctxsweep.py          # /tmp/ctxsweep.py; writes /tmp/ctxsweep.jsonl + /tmp/ctxsweep.log
```

Levels, probes and caps are constants at the top of that file. The sweep stops every `ctxsweep*` and
`qwen38-27b-mac2mac*` deployment before planning, because of the reservation behaviour above.
