# Session record: Qwen3.8-27B two-Mac split, 2026-09-13

Question driving the session: **keep baseline c1 throughput (5.12 tok/s per caller) at c4 / c8 / c16.**

Everything below is measured on this rig unless marked *hypothesis* or *not measured*. Raw rows live in
`ctxsweep-raw-20260913.jsonl`, `ctxconc-raw-20260913.jsonl`, `levers-raw-20260913.jsonl` next to the
harnesses `ctxsweep.py`, `ctxconc.py`, `levers.py`.

---

## 1. Local rig: model on disk, and the split proven lossless first

- Inventoried all weights on the machine: ~360 GB across 7 stores.
- Fetched `ggml-org/Qwen3.8-27B-GGUF` Q8_0 + MTP head + mmproj into `models/qwen3.8-27b/`, SHA256-verified.
- Proved the darwin→darwin split is lossless **before** putting a network under it: 8/64 layers across
  `ggml-rpc`, byte-identical output sha `616f824037ab81fe26f2222093efc509`.
- Single-node reference on this Mac: **solo decode 5.9 tok/s**, **local RPC split 6.0 tok/s**, MTP locally **8.8 tok/s**.

That 6.0 vs 5.9 comparison becomes load-bearing later — it says a split costs ~nothing in decode.

## 2. Distribution: install, enrollment, model fetch, offers

- Published `app.swarmlet.ai/install.sh` and `/agent/latest.tar.gz` (+`.sha256`) through the Traefik
  file-provider router and nginx. Alias, not rename, so old URLs keep working.
- Friend enrolled as worker node `26bc380240373930` (M5 Pro).
- **Download block**: profiles gained `ModelDownloadFile`/`ModelDownload` + `DOWNLOAD_URL_RE`, plumbed
  through `control/catalog.ts` to `/v1/models?catalog=1`; new `node-agent/download.ts` (ModelFetcher)
  with `/api/models/fetch` and a Models tab. Verified by fetching the real 3.16 GB MTP head from HF
  (declared sha matched).
- **Update A**: `contributionOffer` + `OFFER_POLICY_VERSION=1` + `offerPolicy` marker → both Macs
  auto-adopted enabled offers, coordinator/replica roles preserved. Shipped as release `2026091212`.
- **Update B**: `defaultOffer.enabled = true`; worker layer count (`WorkerAssignment.layers`,
  `modelLayers`) and `planView()` → a Serving column in the node UI.

## 3. Standing measurements (all with byte-identical answers at every setting)

**Layer sweep** (worker lanes on a 32 GB M5 Pro, ctx 256K, parallel 1): 12 / 20 / 25 / 30 ready;
35 and 42 fail in `rpc_dispatcher::work_reader`. Reliable share = 12 layers.

**Context sweep** — `CTX_SWEEP_MAC2MAC_20260913.md`, 4K→256K:
decode flat 5.35–6.34 tok/s; prompt 119–256 tok/s; worker free RAM 8,830 → 4,679 MiB (workers *do* pay
for ctx); identical hash at every level; one 90.8 s load outlier at 32K coinciding with 108 ms RTT.

**Concurrency sweep** — `CTX_CONCURRENCY_MAC2MAC_20260913.md`:
| conc | TTFT | aggregate | per caller |
|---|---|---|---|
| c1 | 7.45 s | 5.12 | **5.12** |
| c4 | 14.3 s | 10.60 | 2.69 |
| c8 | 24.7 s | 12.03 | 1.50 |
| c16 | 46.6 s | 12.64 | 0.80 |

ctx is irrelevant to these numbers; all concurrent answers identical. Charts in `ctx-charts.html`
(self-contained, 7 charts, headless-Chrome verified after fixing 4 render bugs).

**Operator UI**: Throughput tab in `swarmlet/control/ui` — filters by model/node/kind, SSE-driven,
per-model+node rows, per-node rollup, relay rates. Deployed as control `20260912-throughput.1`.

## 4. Family A levers — `LEVERS_MAC2MAC_20260913.md`

One variable per cell against baseline (12 layers, chain 0, batchedGets on) at c4/c8:

| lever | c4 | c8 |
|---|---|---|
| baseline | 9.23 agg / 2.31 per, TTFT 16.7 s | 12.45 / 1.56, TTFT 23.8 s |
| **MTP** (`chain 3`) | refused by planner | refused |
| **ngram-simple** | **2.42 / 0.61**, TTFT 64 s | **2.07 / 0.26**, TTFT 150 s |
| `w6` / `w20` | no envelope row for 6 · failed | same |
| `batchedGets:false` | refused (stale reservation) | refused |

Baseline reads 9.23/12.45 against the sweep's 10.60/12.03 → **~13 % run-to-run variance**; treat
smaller differences as noise.

Findings:
- **Sizeable regression from speculation.** ngram cut aggregate ~75–83 % and pushed TTFT to 64 s and
  150 s. Draft misses add boundary exchanges, and on a ring an exchange is a network round trip.
- **MTP refused by design**, `control/planner.ts:582`: an explicit `workerLayers` with `chain > 0` is
  refused ("not qualified … until target block-count and draft residency are qualified together").
  Omitting `workerLayers` gets through, because automatic placement may choose.
- **My own errors, stated**: `w6` was never runnable (the ladder had no row for 6); `batchedGets:false`
  and every c8 cell after `w20` were `plan_refused` because a *failed* deployment still held the nodes'
  reservation. A matrix that does not free and verify the reservation between cells silently turns
  later cells into refusals.
- **Batch sizing (`-b`/`-ub`) not tested.** `DeploymentSpec` has no `env`/`extraArgs`, so it cannot be
  per-deployment; it needs a dedicated redeploy where every cell inherits it. Fork defaults are
  `-b 2048 -ub 512`.

## 5. Envelope fix (this round)

Dropped rows **35 and 42** — both measured failures, both derived from the GPU's reported device total
rather than from a measurement, and automatic placement prefers the largest row that fits the offer, so
leaving them in meant the planner would select a split this hardware aborts on. Added a row for **6**
so the rebalance cell is runnable. Rows are now **5, 6, 8, 10, 12, 15, 20, 25, 30**.

Deployed as control `20260913-envelope.1`. Verified: automatic placement with `chain 3` now returns

```
tensorSplit [30, 34] | mtpPath …/mtp-Qwen3.8-27B-Q8_0.gguf
```

against `[42, 22]` before the fix. The fix works; the remaining blockers are elsewhere (below).

## 6. Transport: the ring is relayed, and that turns out not to matter for decode

Both Macs report `192.168.1.x` — but they are **not** on one network:

```
192.168.1.181:47801 (mine)  → OPEN
192.168.1.112:47801 (his)   → no connect
ping 192.168.1.112          → 100 % packet loss
```

Colliding private subnets on two separate networks, so instead of a direct dial the ring runs
my Mac → Cloudflare edge → VPS → his Mac. My agent holds exactly two sockets, both to Cloudflare
(`172.67.162.30:443`, `104.21.10.18:443`); his control RTT is 113 ms against my 26.9 ms.

**Correction to my own earlier framing**: this does *not* explain the decode ceiling. A same-machine
RPC split measured 6.0 tok/s vs 5.9 unsplit, and the relayed split 5.4–6.3 — so **per-stream decode is
compute-bound, not network-bound**, and a direct path would buy roughly nothing there. Latency does
show up in TTFT (7.5 s at c1 rising to 46.6 s at c16), where prompt processing issues many sequential
trips.

**Why SSH tunnels are not the fix** (asked and answered): SSH needs a reachable endpoint, which is the
one thing missing — so a tunnel would go through the same VPS, over the same two legs. It would also
add a second node-to-node identity system alongside the Ed25519 enrolments and per-assignment pinned
client-cert fingerprints. The mesh already dials direct TLS first and falls back to the relay; the
missing piece is a routable path (same tailnet / port forward / same physical LAN), not a tunnel.

## 7. MTP retest: attempted three times, still unmeasured

| attempt | state | outcome |
|---|---|---|
| 1 | nodes busy | `offer disabled` — failed deployments hold reservations |
| 2 | free, plan `[30,34]` + mtp ✓, ctx 256K | **coordinator** `engine exited (code 1): failed to allocate buffer for kv cache` |
| 3 | ctx 32K | **worker** `engine exited (code 143, SIGTERM)` in `ggml_metal_library_compile_pipeline: kernel_flash_attn_ext_vec_reduce` |

Attempt 2: automatic placement puts 34 layers **and their KV** on the coordinator at 256K × c4 — about
2.6× the KV of the working config (52 layers × 1 slot) — and the admission model does not catch it.

Attempt 3: the failure moved to the worker and carries the **same signature as the earlier `w20`
failure**, which forces a correction — `w20` was not memory pressure; it was a Metal compile being
killed. *Hypothesis, not measured:* the flash-attn reduce kernel is specialized per tensor split, so
every new split triggers a cold Metal compile on the worker, and the load timeout kills the engine
before compilation finishes — which would make **any layer-rebalance experiment look like a capacity
failure**. Both chain-0 and chain-3 cells failed identically, so nothing here is attributable to MTP.

## 8. Where the original question stands

Preserving c1's 5.12 tok/s at c4/c8/c16 requires 1.6× / 3.2× / 6.5× the current aggregate ceiling, and
nothing in Family A 1/3/4 delivered it. What the session did establish is the *shape*: decode is
compute-bound at ~6 tok/s per stream, aggregate saturates near 13, the lever that adds decode work
(ngram) is catastrophic, and the levers that spread compute saturate. That leaves:

1. **MTP, once the blockers below are fixed** — the only lever that reduces work per output token.
   It measured +49 % locally (5.9 → 8.8 tok/s) where there is no ring at all.
2. **Family B (admission control)** — needs no engine change and is the only thing that holds the c1
   rate today, at the cost of queueing callers beyond the limit.
3. **A direct network path** — worth measuring for TTFT, not for decode.

## 9. Open items

- **Cold Metal compile vs load timeout** — the most likely reason every split change above 12 layers
  fails. Needs either a longer load budget or a warm-up compile per split, before any further
  rebalance or MTP measurement is meaningful.
- **Admission model** — must include KV for ctx × parallel against the coordinator's *and* worker's
  layer counts; automatic placement currently selects rows that OOM at the requested concurrency.
- **Failed deployments must release reservations** — they currently block every subsequent plan and
  silently produce `plan_refused` across a matrix.
- **Bound worker layers by `min(gpuOffer, ramBudget)`** so a row cannot be offered that the node
  cannot actually host.
- **TTFT column in the UI** (3-file change: `node-agent/inference.ts` timestamp → agent metrics →
  `control/telemetry.ts` field) — TTFT is the number the concurrency question is actually about.
- Unmeasured throughout: **relay bytes per token**, and TTFT decomposed (no engine `prompt_ms` /
  `predicted_ms` on the streaming path).

---

# Addendum: node-side NAT mapping (UPnP-IGD), shipped and measured

Problem: the RPC ring between the two Macs is relayed (my Mac -> Cloudflare edge -> VPS -> peer) because
the nodes sit on different networks that both use `192.168.1.0/24`. They are not on one L2: his
`192.168.1.112:47801` refuses connections and does not answer ping, so the colliding private ranges
are not routable to each other. The owner of the far router cannot be asked for a change, and future
nodes will be on routers nobody here administers, so the feature had to live in the node software.

## What shipped

`node-agent/nat.ts` (297 lines, no new dependencies): SSDP discovery of the default gateway's IGD,
`GetExternalIPAddress`, `AddPortMapping` with a lease, renewal at half life, `DeletePortMapping` on
stop. Wired through `protocol/types.ts` (`NodeCaps.publicEndpoints`), `control/deployments.ts` (merged
into the direct-dial candidates, last, port-bearing) and `node-agent/main.ts` (owns the mapper, publishes
the endpoint only when it agrees with the address the control plane observed).

Security rules, all deliberate: only the default gateway may answer discovery and its control URL must
live on that host over http (a hostile LAN device cannot redirect our SOAP calls); only the data
listener's port is mapped, on the default-route interface; a lease with renewal means a killed agent
expires its own hole; `stop()` deletes it on any clean shutdown; every failure path is silent and total
(no endpoint, relay as before). The listener itself already requires a client certificate whose SHA-256
fingerprint is in the assignment's allowed set (`transport/dataListener.ts`), so a mapping publishes an
authenticated address, not a grant.

## Verified end to end

| step | evidence |
|---|---|
| real mapping on a real router | `{"ok":true,"host":"93.139.213.145","port":42445,"expected":42445}`, internal `192.168.1.181:47801`, lease 3600 s |
| reachable from the public internet | from the VPS: `Connection to 93.139.213.145 42445 port [tcp/*] succeeded!` |
| unauthenticated peer refused | TLS with no client cert returned **0 bytes**; agent logged `data listener: peer refused {"from":"46.225.53.158:51182"}` |
| no hole left behind | `{"ok":true,"deleted":42445}`, and the later connect from the VPS no longer succeeds |
| shipped as a release | `2026091215` / `0.1.0-serving.20260913.15`, agent sha `dbb635917ac8b1ad…`, 16 files |
| both nodes adopted it | my node `publicEndpoints=[{93.139.213.145, 42445}]`; his node `publicEndpoints=[]` |
| serving unregressed | deployment `ready`, answer hash `565339bc4d33`, identical to the recorded baseline |

A deployment trap was caught by diffing file sets: the agent build ships 10 files while the live release
carried 16, missing `engine/desktop-app-00{0..4}.bin` and `desktop-app.json`. Publishing as-is would have
stripped those from the node payload on both machines; the release was republished merged, changing only
`swarmlet-node` and `agent-build.json`.

## Result: the direct path did not materialise on this pair

His node adopted the release and ran the mapper, and reports an **empty** endpoint list: his router
offers no usable UPnP-IGD mapping. The coordinator is the side that dials the worker, so the worker being
unmappable means the ring stays relayed - confirmed during the run, where the only established sockets
are three to Cloudflare (`172.67.162.30:443`) and none to his public address.

Remeasured with the **same harness, cell and context** as the recorded baseline:

| | TTFT | aggregate | per caller |
|---|---|---|---|
| c1 now | 8.29 s | 4.63 | 4.63 |
| c1 recorded | 7.5 s | 5.12 | 5.12 |
| c4 now | 15.7-15.9 s | 9.68 | 2.42 |
| c4 recorded | 16.7 s (levers) / 14.3 s (sweep) | 9.23 / 10.60 | 2.31 / 2.69 |

Everything inside the ~13 % run-to-run variance band measured earlier, with identical answers. **No
change, which is the correct result**: the path did not change, so nothing should have moved.

One intermediate reading of `TTFT 0.8 s / 16.7 tok/s` was discarded as a measurement artifact rather
than reported as a win - this model streams reasoning tokens first, and counting those as tokens moves
both numbers without anything in the system changing.

## The finding that matters for asymmetric routers

Dial direction is an implementation choice, not a property of the topology. The listener already forwards
an inbound peer connection to a local engine port, so if the mappable side accepts and the unmappable
side dials in, the ring goes direct with a mapping on only ONE of the two nodes. Today my node holds a
usable mapping and publishes it, and his does not, which is exactly the asymmetric case that a reverse
dial would convert into a direct path - with no router access on his side.

## Defect found by verifying across a refresh (and fixed)

The first wiring set `publicEndpoints` only inside `measure()`, which runs at startup and then hourly, while
`refreshCaps()` rebuilds caps from a fresh probe every 5 minutes (`this.caps = caps`). So the published
endpoint appeared right after each start and **silently disappeared within five minutes** - caught because
a later check of a live node read `publicEndpoints=None` on a release that had just published it.

Fixed by applying the endpoint on every caps build through one helper, `applyNatEndpoints(caps)`, called
from both `refreshCaps()` and `measure()`. Shipped as release `2026091216` (`0.1.0-serving.20260913.16`),
agent sha `c7d60d82da95972d…`, republished merged so the engine payload stayed byte-identical.

Verified by watching a live node for 10.5 minutes across two 5-minute refreshes:

```
[45s] 2026091216 [{'host': '93.139.213.145', 'port': 42445}]
... identical at every sample ...
[630s] 2026091216 [{'host': '93.139.213.145', 'port': 42445}]
```

This is the reason the release was worth remeasuring rather than assuming: the feature was functionally
correct on every axis except the one that mattered for it being useful over time.

---

# Second measurement pass: context and concurrency, reported like the first

Re-ran both harnesses against agent release `2026091216` and reported them in the same shape as the
first report: same two record structures, same page shell (the previous `<style>` block verbatim), same
two sections.

- `ctxsweep2-raw-20260913.jsonl` (7 cells, 4K->256K at one caller, deep + shallow probes)
- `ctxgrid-raw-20260913.jsonl` (15 cells, c1/c2/c4/c8/c16 x ctx 8K/64K/256K)
- `ctx-charts2.html` - 10 charts in two sections, verified by rendering it in headless Chrome and
  reading the screenshot (axis labels were fixed to carry the `c` prefix, since concurrency axes were
  being labelled with the context formatter).

Result: context is still inert for decode (5.19-6.22 tok/s deep across 4K->256K, worker free RAM falling
9,074 -> 5,450 MiB as ctx grows), while concurrency is still the only lever and still saturates - the
aggregate reaches 12.20 tok/s against 5.14 at c1 (2.4x) while each caller drops to 0.76-0.81 tok/s, about
15% of the single-stream rate. All 22 cells produced the reference output hash `565339bc4d33`.

---

# Addendum: engine portability on macOS, and automatic re-placement

## The M1 could enroll but never serve

`llama-server --list-devices` aborted on the M1 (macOS 15.6.1):

```
dyld: Symbol not found: _posix_spawn_file_actions_addchdir
  Referenced from: …/llama-server (built for macOS 26.0 which is newer than running OS)
```

The bundle was intact (sha256 matched the manifest and the build host), so this was a build defect, not
transit damage. Two causes stacked:

1. `engine/build.sh` never set a deployment target, so CMake took the SDK's version.
2. The vendored `sheredom/subprocess.h` chooses between the POSIX-2024 `posix_spawn_file_actions_addchdir`
   (macOS 26+) and the older `…_addchdir_np` (macOS 10.15+) from `MAC_OS_X_VERSION_MIN_REQUIRED`. With
   `MACOSX_DEPLOYMENT_TARGET` set only in the environment, the *link* stamped `minos 15.0` while objects
   were still compiled for 26.0 - producing a binary that ran on the build machine and aborted on every
   older Mac, importing a symbol that does not exist there.

Fixed by pinning `-DCMAKE_OSX_DEPLOYMENT_TARGET` in the build script (and wiping the build dir so the
objects are recompiled with it). Verified on the target: `nm` shows `_posix_spawn_file_actions_addchdir_np`,
`minos 15.0`, and on the M1 the engine now reports `MTL0: Apple M1 Pro (10922 MiB)` instead of dying.

Side effect worth noting: the agent's GPU probe *caught* the crash and fell back to `system_profiler`, so
the node looked healthy while unable to start an engine. A node that cannot run its engine should say so.

## Automatic re-placement (control + UI)

Implemented in `control/deployments.ts`: `redistribute()`, `onNodeOnline()`, `pinsNodes()`,
`placementGain()`, with `moveIntervalMs` / `moveSettleMs` as injectable knobs. Teardown gained
`abandonOfflineCleanup` so a re-placement is not blocked forever by a node that cannot answer, while
every reachable node is still waited for. Two bugs found by the end-to-end run and fixed:

- a departing agent reports its assignments failed/stopped on the way out; that was treated as an engine
  failure and killed the deployment instantly, bypassing the grace and the move entirely;
- a node that leaves after reporting its assignment stopped looked like a deployment with nothing wrong
  with it - ready, routing traffic, and missing a worker. The plan now decides too, not only live rows.

UI (`control/ui/app.js`): the deployments row shows the last placement change, and the drawer lists the
deployment's placement history, fed by its events.

Seven unit tests in `control/test/redistribution.test.ts` cover: node loss, pinned refusal, registration
with a material gain, no-viable-placement failure, departing-agent handling, genuine engine failures, and
a node returning without an abandoned assignment.

E2E on the live rig (`redist-e2e`, auto-placed 2B split):

| stage | plan | answer hash |
|---|---|---|
| before | `3/3/18` on legion > legion-2 > M5 Max | `a120e6472d4d40cd` |
| `systemctl --user stop swarmlet-node` on legion | withdrawn at 10 s, moved at 51 s to `3/21` on legion-2 | `a120e6472d4d40cd` |
| legion returns (after the 10-minute cooldown) | `… joined; fits better there (21 -> 18 layers on the serving node)` then `re-placing`, back to `3/3/18` | `a120e6472d4d40cd` |

Identical output at every stage, no spurious failure, and the move back fired from the registration hook
rather than the older recovery path.

## Re-placement, final state

Nine tests in `control/test/redistribution.test.ts` cover node loss, pinned refusal, a registration move
with a material gain, no-viable-placement failure, a departing agent, genuine engine failures, a node
returning without an abandoned assignment, a start blocked by unprovable cleanup, and a move onto a node
that cannot take the work (dropped, remembered, placement restored).

The end-to-end run on the live rig moved a serving split three times - twice on node loss, once on node
return - and every stage answered byte-identically (`a120e6472d4d40cd`). Along the way the run found four
real defects, all now fixed and covered: a departing agent's own assignment failures killed the deployment
before the grace could run; a node reporting `stopped` left the deployment `ready` and a worker short; a
departed node's unacknowledgeable cleanup made a failed deployment permanently unrestartable; and a move
onto a node whose engine aborts killed the deployment instead of falling back.

## Automatic model choice

Asked for as `profile: "auto"`: control ranks the profiles (a written-down `rank` per profile), tries a
whole-model replica before a split, and lets the planner refuse anything the nodes cannot really run.
Fourteen tests cover it - best-placeable wins, downgrade when the strong node leaves, upgrade path, no
restart when nothing changes, loud refusal when nothing fits, and the live-fit check (a node offering
100 GiB while 40 GiB is free must not be handed a 110 GiB model).

Two defects the feature exposed and fixed: the automatic choice planned with the *stale* spec after
switching models (it kept trying to place the model it was replacing), and it chose by *offer* rather than
*available memory*, so the first real run picked flash-next on a machine with 65 GiB free and the agent's
fit gate refused it (`does not fit: 65522 MiB free, need 109952`). The policy now checks the same
arithmetic the gate does and records the reason it skipped a model.

Live result: `mesh-auto` resolved to a **27B replica on the M5** - the best model that fits while Docker
holds ~26 GiB - serving `qwen3.8-27b, route=local` in 2.7 s, with flash-next's 109,952 MiB requirement
recorded as the reason it was passed over.
