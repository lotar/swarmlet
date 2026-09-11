# Fleet allocation — 11 September 2026

The control web UI now has an **Allocation** page for placing multiple deployments together. Select workloads and a hardware pool, request a balanced recommendation, optionally assign nodes and qualified worker layer counts, then review and apply. Workloads can be created without starting them. Search and pagination cover large inventories, and apply progress survives a reload.

Source: `af7045634124d13daaae27d19d5819a64ea4e12a`. Signed node release: `2026091103`, version `0.1.0-fleet.20260911.3`.

## Requirements, deletion and scope

| Requirement | Named owner | Decision |
| --- | --- | --- |
| Assign hardware to multiple deployments through the web | Lotar | Keep: the requested workflow. |
| Work with hundreds of nodes | Lotar | Keep: bounded planning, a worker thread, search and pagination. |
| Balance response speed and aggregate throughput | Lotar | Keep: capacity, GPU placement, model availability, contention and measured controller RTT. |
| Match arbitrary hardware perfectly for maximum speed | Lotar | Treat as an aspiration: provide explained heuristics, without claiming an unmeasured maximum or inventing TPS. |
| Use every node or uniform worker counts | Unowned | Delete: more network hops can hurt performance. |
| Continuously migrate production in the background | Unowned | Delete: an explicit preview and apply satisfies the requested option. |
| Add model downloads, new engine topologies, or external-service shutdown | Unowned | Delete: reuse the existing qualified placements and inventory. |

**Deleted:** exhaustive search, a background benchmark fleet, automatic ongoing migrations, an animated node graph, and a replacement web framework. Per-GPU pinning is a possible later addition if node assignment proves insufficient.

**Simplified:** reuse the model planner, offers, process enforcement, durable deployment intent, and acknowledged cleanup. One shared resource ledger serves ordinary starts and fleet allocation.

**Accelerated:** bounded candidate sets and CPU-sharing passes, including dense sharing; large requests run in a worker so inference admission remains responsive.

**Automated:** calculate recommendations and budgets, validate a reviewed preview, and record apply outcomes. Applying still requires the operator's action.

**Scope:** a hosted fleet allocation option for existing replica/split workloads, with manual assignment, shared budgets, checked apply and progress. External services and qualified native placements remain fixed.

## Resource and lifecycle behavior

RAM and GPU reservations derive from model profiles with headroom. CPU budgets become actual engine thread/enforcement settings. GPU memory is scheduler accounting, not a hardware partition; GPU compute remains shared. OS enforcement retains its platform-specific implementation. Fresh memory pressure can reject a candidate and steer placement elsewhere. Scores rank candidates; they do not predict tokens per second.

Existing deployments reserve capacity, including failed or retired assignments awaiting acknowledged cleanup. Legacy placements reserve their full offers until replaced. Unified memory is not added twice to physical RAM. Agents must advertise fleet-budget support before taking a shared allocation.

Previews bind structural fleet state and expire after ten minutes. Active requests, changed offers, and concurrent deployment/update operations prevent admission. Applying atomically records the run and withdraws selected routes, waits for all cleanup acknowledgements, rechecks capacity, saves specifications transactionally, and starts at most four workloads concurrently. Failed cleanup retains original specifications. Partial starts and controller interruptions are visible; retrying an accepted apply returns the existing run.

## Verification

Commands run against the committed source:

- `bun run --cwd swarmlet typecheck` → `$ tsc --noEmit` (exit 0).
- `bun test swarmlet` → `354 pass`, `0 fail`, `4115 expect() calls`, `Ran 354 tests across 49 files. [136.62s]`.
- Production image under 1 GiB RAM / two CPUs: `bun test swarmlet/control/test/fleet.test.ts swarmlet/control/test/fleet-apply.test.ts` → `17 pass`, `0 fail`, `81 expect() calls`.
- 500-node / 20-deployment planning: 9,600 candidates, 1,305 ms locally and 3,321 ms in the production-sized image. These are planner timings, not inference-speed benchmarks.
- The real controller HTTP API and two full node-agent processes with a fake engine ran two budgeted replicas on one node, one CPU core each. Both served routed requests, then stopped cleanly.
- Docker Playwright: automatic preview; filtering; widths 320, 375, 768, 1024 and 1440; stale-selection race during planning; apply; page reload; durable progress; zero page errors and no document overflow. Desktop and mobile screenshots were inspected.
- A separate 500-node browser fixture verified 25-row pagination, search, a manual three-layer worker assignment mixed with automatic placements, apply, and unauthorized API rejection.
- Real signed Mac bundle reconstruction verified all bundle files, code signing, canonical agent identity, retained backup, and repeat-install idempotence.

Browser evidence uses synthetic inventory; the agent end-to-end test uses real process supervision and networking with a fake engine. Neither is evidence of improved real-model TPS.

## Review

**Verdict:** merge. Verified issues were fixed before the committed source and shipping checks.

**Findings resolved:** changing selection during an outstanding preview now invalidates its response; admission writes and route withdrawal are one transaction; persistence failures release the lock and are logged; runtime budgets are checked against current offers; fresh GPU pressure steers candidate selection; dense sharing can reach one core per deployment. The stage process fixture was supplied with its actual RAM/CPU offer for the new enforcement check; its readiness assertions remain intact.

| Lens | Result |
| --- | --- |
| Correctness | Clean after the fixes above; success, stale, inflight, failed-cleanup, failed-transaction and interrupted-run cases exercised. |
| Contracts | Clean: `control/server.ts` API consumed by `control/ui/fleet.js`; protocol limits consumed by `node-agent/assignments.ts` and `roles/recipes.ts`; plans consumed by `control/deployments.ts`. |
| Data safety | Additive, repeat-safe `fleet_runs` DDL. Preview pruning deletes only excess unexecuted previews, reproducible by recommending again; accepted run history is retained. Bulk spec updates are transactional and apply retries are idempotent. Pre-deployment database/config/key backup saved before cutover. |
| Time | Clean: UTC ISO timestamps, structural revision excludes heartbeat changes, ten-minute preview expiry and fresh-metric checks. |
| Staleness/concurrency | Clean: draft versions, structural revision, synchronous admission lock, acknowledged cleanup, repeated-apply identity and bounded startup concurrency. |
| Security | Clean: existing admin authorization covers every new endpoint; parameterized SQL and text-based DOM construction; unauthorized API checked. |
| Tests | Clean: behavioral tests and actual API/agent/browser paths, including failures; no weakened assertions. |
| Simplicity | Clean: shared `resources.ts` extends `planDeployment`; existing enforcement and teardown retained; no second scheduler in the browser. |

**Questions:** none outstanding in the shipped scope. Real-model performance measurements are needed before claiming a particular recommendation is globally fastest.

## Hosted rollout

The hosted controller is `swarmlet-control:af70456`, healthy after the existing 60-second idle-window deployment gate. A SQLite snapshot plus controller configuration and keys were backed up before cutover.

All four real nodes automatically activated signed release `2026091103`. On-host audits matched the actual running executable and every signed inventory entry: Mac 16, Windows 6, and each Linux node 7 files. The Mac app automatically installed its matching bundle; all 15 bundle files, code signature and previous-app backup were verified.

`python3 -I /tmp/swarmlet-fleet-hosted-verify.py` returned:

```text
HOSTED_CHAT: existing 2B deployment returned FLEET_READY
HOSTED_FLEET: 4 online budget-capable nodes; canonical UI assets; valid real 2B preview; standing specifications unchanged; no allocation applied
MULTI_PREVIEW: 1 of 2 fit; canApply=False
```

The combined Flash-Next + 2B preview was blocked by current RAM pressure (about 72,329 MiB free plus reclaimable agent RSS versus at least 91,264 MiB in the reported candidates with headroom). Flash-Next was already failed for insufficient memory before this task. The 2B deployment remains ready. No standing deployment specification or layer assignment was changed to demonstrate allocation.

Docker Playwright against the actual hosted site returned:

```text
HOSTED_BROWSER: real 4-node fleet rendered; reviewed 2B recommendation with Apply enabled; mobile no overflow; 0 page errors; no apply performed
```

Hosted desktop/mobile screenshots were inspected. Evidence, browser scripts, signed installation audits and before/after inventories are retained locally under `~/.swarmlet/backups/fleet-allocation-20260911/`.

## Handoff

**State / done:** hosted allocation option, signed rollout, full source and shipping-image tests, real agent apply, and hosted preview verified by the commands above. The 2B service was checked after controller restart.

**Not done:** no globally fastest real-model placement is claimed. The existing Flash-Next workload still needs enough available RAM; this task adds the allocation option without forcing a production rebalance.

**Resume:** open `https://app.swarmlet.ai/#fleet`, select the workloads and hardware pool, and review a recommendation. The durable API contract and local fixture are documented in `swarmlet/README.md` and `swarmlet/e2e/fleet-fixture.ts`.

**Gotchas:** the Docker browser fixture needs `publicWeb: true` while remaining bound to loopback; otherwise the controller's intentional private-web boundary returns 404. Standalone native process tests need a realistic offer for runtime budget validation. A production inference smoke check must allow enough output tokens or disable thinking; the final exact-response check disabled thinking. Agent updates can briefly disconnect a local forwarded UI while the new process starts.

**Open questions:** none for this release. To evaluate model speed, measure actual inference after reviewing and applying a suitable allocation; the planner timing figures above do not answer that question.
