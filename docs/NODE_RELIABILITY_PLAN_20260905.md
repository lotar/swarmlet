# Node reliability implementation and acceptance plan

Owner: Mladen (requested 2026-09-05). Implementation checkout: `fix/node-reliability-20260905`.

## Requirements scrub, in order

| Requirement | Named owner | Keep/drop and reason |
|---|---|---|
| Recover desired deployments after node/channel/control interruption | Mladen | Keep: connected nodes currently leave inference unavailable |
| Clean stale workers and duplicate external watches | Mladen | Keep: orphan resources and doubled metrics are live defects |
| Accurate metrics and honest unknown/busy display | Mladen | Keep: operator needs trustworthy status |
| Matching agent/service/GUI binaries on Mac and both Legions | Mladen | Keep: current packages have older agents; L1 GUI absent |
| Real inference and deliberate disconnect/restart acceptance | Mladen | Keep: unit tests alone missed these failures |
| Stop production and run end-to-end tests only after local AI is idle | Mladen | Keep: current production client must finish uninterrupted |
| Five subagents | Mladen | Keep: three concurrent slots, five tasks in waves |

Deleted/deferred: new scheduler service, monitoring stack, speculative live token estimates for bypass traffic, signing/notarization, AppImage/DMG work, model distribution. Revisit a small subset only if a concrete acceptance failure requires it.
Simplified: extend the existing registry/state machine and agent metrics; build one agent per platform and copy it into native packages.
Accelerated: independent control, metrics, packaging work; bounded fault-test and review lanes follow when slots free. Focused unit tests during production activity.
Automated last: reconciliation/backoff after lifecycle semantics are pinned; a fail-closed idle maintenance operator after its guard/restoration tests pass.
Scope: recovery/cleanup, metrics, refreshed native packages, and real rig fault acceptance. No unrelated host settings or services.

## Goal and current state

Done when all three services and GUIs use current binaries, the 2B model serves through the three-node internet relay, node reconnect and control restart restore serving without manual deployment restart, intentional stop stays stopped, stale engines disappear, external metrics are counted once, and production is restored after the maintenance window.

Live checks on September 5: three online agents; `mesh-2b-internet` failed after a September 4 disconnect; L1 worker still listening; two external assignments watching Mac :8099; upstream processing=1 while agent reports 2; L1 GUI absent. Root verified actual LaunchAgent/systemd paths. Production metrics show one active request, zero deferred: live deployment/e2e gate is closed. Premise holds.

## Steps and acceptance

1. Control recovery/cleanup lane: durable running intent; serialized start/stop/recovery; bounded retry and backoff; reconciliation before port reuse; boot and reconnect checks. Validate `bun test control/test/recovery.test.ts` (lane may choose equivalent focused filename), then typecheck.
2. Metrics lane: dedupe canonical endpoints, per-endpoint token baselines, honest busy/unknown/stale output, release router inflight on completion/error/cancel. Validate focused new metrics/router tests and JS syntax checks.
3. Installer lane: canonical binary/hash manifest, strict engine staging, native `.app`/`.deb`, stable engine/service paths. Validate shell syntax and staged SHA comparisons; native build/install waits for idle.
4. Fault-test lane: simulated control restart/reconnect/manual-stop regressions and a real-rig 2B relay operator with cleanup. Write now; `bun test e2e` and real-rig execution wait for idle.
5. Independent review lane: adversarial lifecycle races, metric counting, installer consistency, and idle/restore behavior. Resolve findings, then fresh full unit/typecheck.
6. Root idle window: `python3 swarmlet/e2e/idle-window.py --check` is read-only. Full operator requires at least 60 continuous seconds of no active/deferred/routed requests and no token advance, then existing maintenance script's final client/PID guard. Never force another client's connection closed. Validate guard with `python3 -m unittest discover -s swarmlet/e2e -p test_idle_window.py`.
7. Inside owned window: backup state/binaries/config; build/stage/install current packages; restart agents/control; run simulated e2e and real three-node requests before/after worker disconnect and control restart; verify no duplicate assignments or orphan processes. Restore production even if an operator fails, and run maintenance `check-only` plus `/health`.

## Risks, assumptions, pre-mortem

No claim of uninterrupted individual requests across broken RPC streams: affected requests may fail, serving must recover. Do not retry requests invisibly. Existing failed deployments require explicit operator start during migration; intentional stops must never auto-start. Recovery must wait for required nodes/cleanup and not launch a second large model beside production. The real fault run uses 2B, sufficient to exercise the same control/transport lifecycle without requiring repeated 104 GB model loads. Existing Flash-Next production remains an externally managed service.

Main risks: cleanup/start race reuses busy ports; stale ready state after restart routes to broken relay; repeated external watchers inflate metrics; sidecar differs from installed service; idle becomes busy before stop; exception leaves production down. Each has an explicit regression or final maintenance guard/restoration check. Backups preserve identities, offers, enrollment URLs and model paths. No design-blocking questions: the user explicitly authorized the idle production-stop window and deployment.
