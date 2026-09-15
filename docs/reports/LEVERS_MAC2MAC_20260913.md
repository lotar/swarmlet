# Family A levers: what actually moved the ceiling

Measured 2026-09-13 on the live 2-Mac split. Harness `levers.py`, raw rows
`levers-raw-20260913.jsonl`. Configuration is identical to `CTX_CONCURRENCY_MAC2MAC_20260913.md`
(12 layers on MBP-od-Veimir, rest + coordinator on Lotars-MBP.home, ctx 262144, relay), except for the
single lever each row changes. **ttft min–max** and rates are client-measured on `conc` concurrent
streaming requests, same prompt and seed as the concurrency sweep.

## Result: no lever improved the ceiling, and one is a severe regression

| lever | conc | outcome | TTFT | aggregate | per caller | identical answers |
|---|---|---|---|---|---|---|
| baseline | c4 | ready | 16,691–16,692 ms | 9.23 tok/s | 2.31 tok/s | 1 |
| baseline | c8 | ready | 23,792–24,082 ms | 12.45 tok/s | 1.56 tok/s | 1 |
| mtp3 | c4 | **plan_refused** | — | — | — | no plan: Deployment "lever-mtp3-c4" (qwen38-27b-q8, split) cannot be planned. Ex |
| mtp3 | c8 | **plan_refused** | — | — | — | no plan: Deployment "lever-mtp3-c8" (qwen38-27b-q8, split) cannot be planned. Ex |
| ngram | c4 | ready | 64,226–64,227 ms | 2.42 tok/s (-74%) | 0.61 tok/s | 1 |
| ngram | c8 | ready | 150,379–150,677 ms | 2.07 tok/s (-83%) | 0.26 tok/s | 1 |
| w6 | c4 | **plan_refused** | — | — | — | no plan: Deployment "lever-w6-c4" (qwen38-27b-q8, split) cannot be planned. Work |
| w6 | c8 | **plan_refused** | — | — | — | no plan: Deployment "lever-w6-c8" (qwen38-27b-q8, split) cannot be planned. Work |
| w20 | c4 | **failed** | — | — | — | assignment as-11df78f6a663 on 26bc380240373930 failed: engine exited (code 143,  |
| w20 | c8 | **plan_refused** | — | — | — | no plan: Deployment "lever-w20-c8" (qwen38-27b-q8, split) cannot be planned. Req |
| nobatchget | c4 | **plan_refused** | — | — | — | no plan: Deployment "lever-nobatchget-c4" (qwen38-27b-q8, split) cannot be plann |
| nobatchget | c8 | **plan_refused** | — | — | — | no plan: Deployment "lever-nobatchget-c8" (qwen38-27b-q8, split) cannot be plann |

Baseline here reads 9.23 / 12.45 tok/s at c4 / c8 against 10.60 / 12.03 in the concurrency sweep —
run-to-run variance of ~13%, so treat differences below that as noise.

## What each result means

**MTP (`chain 3`) — refused by the planner, by design.**

```
Exact workerLayers with MTP is not qualified; use chain 0 until target block-count and draft
residency are qualified together.
```

`control/planner.ts:582` refuses an *explicit* `workerLayers` together with `chain > 0`. Dropping
`workerLayers` does get through, because automatic placement is allowed to choose:

```
PLAN OK: tensorSplit [42, 22] | mtpPath …/mtp-Qwen3.8-27B-Q8_0.gguf
```

**But 42 is a row the layer sweep measured to FAIL** (abort at 42, failure at 35, clean at 30 and
below). So the only currently-permitted path to MTP on a split selects a configuration already known
bad on this hardware. That is a defect in the envelope, not in MTP: the ladder's 35 and 42 rows were
derived from the GPU's reported device total, never measured, and automatic placement prefers the
largest row that fits the offer. **Pruning those rows is the prerequisite to testing MTP at all**, and
until then MTP-on-a-split is unmeasurable rather than merely untested.

**ngram-simple speculation — a severe regression, not a speedup.** Aggregate fell from 9.23 to
**2.42** tok/s at c4 and 12.45 to **2.07** at c8; TTFT went from 17 s to **64 s**, and from 24 s to
**150 s** at c8. Draft proposals that miss cost extra boundary exchanges, and on a ring every
exchange is a network round trip — so speculation that helps a local model can multiply the cost of
the one resource this system is short of. This is the clearest evidence yet that the binding
constraint is trip count, not compute or bandwidth.

**Rebalance — capacity per worker shrinks as slots grow.** `workerLayers 6` was refused because the
envelope has no row for 6 (my matrix error: the ladder is 5, 10, 12, …). `workerLayers 20` at c4
**failed**:

```
assignment as-b45d88ba0662 on 26bc380240373930 failed: engine exited (code 143, SIGTERM):
Client connection closed | Accepted client connection | Client connection closed | …
```

20 layers is clean at parallel 1 (layer sweep: 8,235 MiB free) but not with four slots, and the
churn of connect/close is the RPC peer being torn down and retried. So the layer budget a worker can
carry is a function of both ctx **and** slot count — three variables, and the envelope currently
encodes none of the interactions.

**`batchedGets: false` — not measured.** The cell was refused by the planner because the previous
cell's failed assignment still held the nodes' reservation. A matrix that does not free and verify the
reservation between cells will silently produce `plan_refused` for the cells after a failure; that is
what happened here and it cost two cells.

**Batch sizing (`-b` / `-ub`) — not tested.** These are not per-deployment: `DeploymentSpec` has no
`env`/`extraArgs`, so they can only be set in the profile's `extraArgs`, and every cell would inherit
them. Testing them requires a dedicated redeploy round with its own control. The fork's defaults are
`-b 2048 -ub 512`; with ≤16 tokens per decode step a batch-size limit is unlikely to bind, but that
is reasoning, not measurement.

## Where this leaves "keep c1 rate at c4/c8/c16"

Unchanged: it needs the aggregate ceiling to move 1.6× (c4), 3.2× (c8) or 6.5× (c16), and none of
Family A 1/3/4 achieved any of that. What the run *did* establish is the shape of the constraint —
trip-count-bound, since the lever that adds trips (ngram) is catastrophic and the lever that spreads
compute (more slots) saturates. That points away from these levers and toward:

1. **Cutting trips per token** — which is what MTP is for, once the envelope is fixed. Prune the 35/42
   rows so automatic placement cannot select a known-bad split, then re-run `auto-chain0` vs
   `auto-mtp3` at a *measured-good* layer count.
2. **Cutting trip latency** — a direct path between the two Macs instead of the relay (Family A #2).
   Nothing in this run touched it, and given the trip-bound shape it is the largest remaining lever.
3. **Family B** — bound concurrency so each caller keeps the good rate, rather than trying to make
   sixteen callers each get what one gets.
