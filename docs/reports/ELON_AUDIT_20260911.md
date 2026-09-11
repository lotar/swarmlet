# Swarmlet ten-reviewer ts-elon audit — 2026-09-11

Scope: current Swarmlet product, fleet allocation, node and hosted UIs, signed updates,
qualified execution integration, owner resource controls, installers and operator validation.
Reviewed baseline: `48bb02f`. Lotar requested ten independent reviews, fixes, commit and push.
All ten review reports were completed before tracked implementation edits began.

## REQUIREMENTS

| Requirement | Named owner | Challenge and decision |
| --- | --- | --- |
| Keep working web control, local nodes, chat and fleet assignment | Lotar | Keep: these are delivered workflows, not removable scaffolding. |
| Respect resource owners, peer authorization and current controller signing authority | Lotar | Keep: removing them changes whose hardware or code may be used. |
| Preserve restart recovery, cleanup acknowledgment and numeric qualification | Lotar | Keep: each protects a demonstrated failure boundary. |
| Exactly ten independent reviews and fixes for verified findings | Lotar | Keep: explicit request; reviews ran in bounded batches. |
| Commit and push the reviewed changes | Lotar | Keep: explicit delivery scope. |
| Rewrite the scheduler, updater or native executor; deploy to the live fleet | UNOWNED for this audit | Drop: no such scope is needed to fix the reproduced source defects. |

## DELETED

Removed invented GPU-memory reclaim, pre-fit candidate truncation, stale port snapshots,
empty waiter buckets, duplicate concurrent tunnel creation, catalog callbacks that release
another operation's busy state, and the rule that made stale telemetry look fresh at completion.
Removed acceptance of unowned relay/log traffic and malformed wire payloads before mutations.
Removed silent resource-enforcement fallback, false installer success, raw XML interpolation,
and shell validation that only parsed its first argument.

Refused new scheduling/updater frameworks, supervisor self-reexec, native-kernel changes and
additional live qualification runs. Some compatibility details survive the deletion challenge:
external service watches do not claim managed resource ownership; bootstrap/helper installation
remains a distinct operator operation. These are the necessary add-backs, not duplicate systems.

## SIMPLIFIED

| Review lane | Verified symptom / cause | Applied correction and direct evidence |
| --- | --- | --- |
| 01 Fleet | A selected 4000 MiB GPU reservation with no process made a 3000 MiB request pass despite only 192 MiB measured free. The first 24 unfit replicas hid a fitting 25th node. | `control/fleet.ts` uses measured GPU availability without unattributed reclaim; candidate quotas count feasible placements. Original repro now reports `only 192 MiB`, and chooses `n24`. Regression also covers a fitting coordinator after 12 unfit ones. |
| 02 Lifecycle | Concurrent split starts both selected coordinator port 8100 across a worker-readiness await. Ten start/stop cycles retained ten empty waiter keys. | `control/deployments.ts` reads ports at synchronous coordinator dispatch and deletes empty waiter entries. Original repro: coordinator ports 8100/8101; retained waiter keys 0. |
| 03 Updates | Rebinding A→B during download still activated A and requested A's lease. An unlaunchable active executable bypassed rollback. | `node-agent/supervisor.ts` associates candidates with controller URL/key, rechecks around asynchronous admission/promotion, and routes synchronous launch failure through durable rollback. Subprocess regressions cover download, key-only change, lease and drain, plus missing-executable fallback with replay floor preserved. |
| 04 Hosted fleet UI | Removing worker w2 from the pool hid it in the manual dialog but still submitted it. Deleted deployments remained selected. | `control/ui/fleet.js` filters manual worker state at open and submit, and prunes absent selections on refresh. Browser repro submits only w1 and shows `0 selected` after deletion. |
| 05 Node chat / telemetry | A pending model catalog response unlocked an active stream. A 60-second-old sample became “At reply end” data when generation finished. | `node-agent/ui/chat.js` leaves current chat ownership intact on late success or failure. Shared `processing.js` freezes sample freshness at completion and invalidates pending telemetry. Original repro keeps `busy=true` and `Telemetry unavailable`; late telemetry cannot rewrite the completed panel. |
| 06 Protocol / transport | Unrelated enrolled nodes could relay to an assignment port; foreign logs were retained; malformed hello mutated state; malformed OPEN leaked a stream; target close leaked relay accounting. | Shared wire guards reject malformed nested data before writes. Relay checks target assignment and source certificate permission. Logs and unconsumed stream buffers are bounded; failed OPEN cleans up; either endpoint closes relay accounting exactly once. Authorized 10 MiB TCP echo still returns bit-exact. |
| 07 Native integration | Concurrent tunnel misses created two listeners and leaked the first. Matching ±Infinity passed the numeric helper. | Shared `control/tunnel.ts` publishes one pending listener and handles close during startup. Repro changes two ports / `[true,false]` after close into one port / `[false,false]`. `engine/stages/verify.py` rejects nonfinite arrays; local and remote verifiers share this comparator. No native engine binaries or existing qualification records changed. |
| 08 Owner resources / fans | Disabled or revoked roles still admitted work; rejected CLI offers were persisted with exit 0; absent Linux systemd silently removed limits; Linux fan max had no owner lifetime. | Assignment admission checks the current owner before startup and spawn. Resource reductions/disable are rejected while managed assignments remain; stop them first. Online CLI uses the daemon as writer and reports rejection; offline changes validate before saving. Linux enforcement fails closed. Both platforms use the existing fan lease; Linux restores journaled settings on EOF, heartbeat expiry or termination. Fixtures touch no actual fan controls. |
| 09 Packaging / maintenance | Competing idle windows could restore another operator's stopped production; installer reported success after all failed probes; custom paths corrupted an existing plist. | `idle-window.py` holds a distinct nonblocking process lock through sampling, command cleanup and restoration, including `--allow-stopped`; `--check` stays read-only. Installer serializes/lints a temporary plist before replacement and fails after bounded unhealthy probes. Isolated tests cover contention, partial-stop restoration, XML metacharacters and prior-plist preservation. |
| 10 Validation / current docs | `bash -n a.sh z.sh` ignored broken z.sh; present-tense docs denied shipping Mac signing and app updating. | Release check loops over each script; isolated second-file mutation now fails. Current guides describe Mac signatures, existing-app updates and service prerequisites. Dated historical proofs remain intact. |

The updater delivery observation in lanes 03 and 09 is one shared boundary: signed releases
replace child agents/engines, not the stable supervisor currently executing the update logic.
The current guide now includes a bootstrap refresh procedure and separate parent/child hash
verification. The same guide states that unattended signed updates need an installed supervisor;
a standalone GUI sidecar runs `run` directly. No self-reexec architecture was added.

## ACCELERATED

Ten reviews ran before implementation, with isolated reproductions instead of production faults.
The pre-edit full baseline passed 354 tests. Targeted checks closed the reproduced failures,
then the full product suite exercised fake-engine HTTP/WebSocket lifecycle flows and compiled
signed-update activation/rollback. The first integrated run exposed three incomplete old test
fixtures; valid owner offers, enrollment capabilities and relay ACLs were added without weakening
any assertion. Its three previously failing tests then passed with their original expectations.
The existing 500-node/20-deployment planner case remains within its 12000-candidate/5-second gate.

## AUTOMATED

Extended existing regression suites only. The existing release shell gate now validates all listed
files. No new deployment, inference, qualification or unattended operator automation was added.

## SCOPE

Exactly the verified source/guide fixes above, regression checks, commit and push. Production
services, installed applications, bootstrap executables, privileged helpers and model artifacts
were not modified during this audit.

## Root-cause and verification record

Before the first edit, rival explanations were recorded: stale ownership/bookkeeping versus
physical capacity or invalid fixtures. The discriminating checks showed that the isolated late
node fits, port collision follows the readiness await, phantom GPU reclaim exists without a
selected process, and local-only tunnel/numeric calls reproduce without any remote engine.

Validation commands used:

- `bun run --cwd swarmlet typecheck`
- `bun test swarmlet` (includes real local HTTP/WebSocket flows with fake engines and compiled updater fixtures)
- `python3 -m unittest discover -s swarmlet/e2e -p 'test_*.py'`
- `python3 -m unittest discover -s swarmlet/node-agent/native-fans/linux -p test_fans.py`
- `python3 -m unittest discover -s swarmlet/engine/stages -p test_verify.py`
- `bash -n` individually for the 22 release/operator scripts in the changed scope, plus a second-script syntax mutation
- Headless Chromium against the actual fleet JavaScript with mocked fleet inventory
- `git diff --check`

Python checks produced `Ran 92 tests ... OK`, `Ran 10 tests ... OK`, and `Ran 3 tests ... OK`.
The shell check produced `SHELL_CHECK_OK files=22 second_script_mutation_rejected=true`.
Final Bun aggregate counts and pushed commit identity are reported with the delivery.

## Final review

| Lens | Assessment |
| --- | --- |
| Correctness | Canonical fixes checked against original symptoms and boundary regressions. |
| Contracts | Wire types checked against `protocol/types.ts`, `node-agent/agent.ts`, `localapi.ts` and controller consumers; valid relay and HTTP clients retain their routes. |
| Data safety | No DB migration or bulk deletion. Installer replacement is intentional, repeatable and only follows successful serialization/lint; failure preserves the old plist. Update rollback preserves the replay floor and existing signed-release state. |
| Time | Telemetry freshness uses epoch timestamps and freezes completion time; existing update expiry rules remain. Fan expiry uses monotonic time. |
| Staleness / concurrency | Covered port dispatch, waiter cleanup, tunnel publication/close, UI callbacks, controller rebinding, relay close and maintenance ownership. |
| Security | Peer ACL, log ownership, wire guards and bounded retention verified. No credentials included or production privileges exercised. |
| Tests | Original failure assertions retained; invalid fixtures corrected to satisfy current real contracts. Hardware qualification is not inferred from mocks. |
| Simplicity | Existing planner, supervisor, fan lease and float comparator extended; no replacement systems. Duplicate-symbol search covered `assertOfferChange`, `capabilitiesShape`, `MAX_PENDING_STREAM_BYTES`, `maintenance_window_lock`, binding checks and freshness fields. |

Remaining rollout boundary: these source changes require normal deployment. Supervisor and
privileged fan-helper fixes specifically require the documented installed-component refresh;
publishing a signed child alone cannot deliver them. No physical fleet acceptance is claimed.
