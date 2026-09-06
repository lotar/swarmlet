# Legion-heavy 2B placement — 2026-09-06

## Scope and plan

Owner: Lotar. Keep Qwen3.5-2B, both Legions, Mac coordinator, context 4096,
parallel 2, existing internet relay, and configured GPU caps. Increase useful
worker allocation; filling memory for its own sake is not a requirement.
Delete artificial padding, a model change, and a new placement API from scope.
Retain the existing symmetric planner and add one profile row. Keep older rows
for higher concurrency, lower memory offers, and larger worker counts.
No automation or installer rebuild is needed: control reads the canonical JSON
profile at startup. The node engines already accept these assignments.

Done when the live deployment has split 11/11/2, real routed replies work in
both slots, and GPU measurements remain within offers. Validate profile planning
with `bun test swarmlet/control/test/planner.test.ts`, then the live deployment
API and routed chat completions. Roll back by removing the added row and
restarting the idle deployment/control. No blocking questions.
Pre-mortem: a larger worker share can expose runtime allocation or latency costs;
retain baseline evidence and verify actual inference before acceptance.

## Before evidence and diagnosis

Live deployment dep-65bedf5278d1 used 3/3/18. NVIDIA reported 511 MiB on Legion1
and 303 MiB on Legion2. The workers ran with caps of 3604 and 3600 MiB.
The 2B GGUF file is 2,012,012,800 bytes; it cannot fill 7 GiB of combined VRAM
with unique weights. Memory offered is a ceiling, not a reservation or usage
quota.

| Hypothesis | Distinguishing prediction | Check/result |
|---|---|---|
| GPU caps prevent more layers | Workers already consume most of their caps | NVIDIA memory counters refute this |
| Profile restricts placement | Highest eligible row has only 3 layers | Live plan reasons and canonical JSON confirm this |

Runtime chain: launchd runs control/main.ts → bootControl in server.ts →
loadProfiles in planner.ts → DeploymentManager.startSplit → planDeployment /
chooseRow → coordinator assignment → node-agent roles/recipes.ts engine argv.
Only control/profiles/qwen35-2b-q8.json is the live profile. Historical rig scripts
and archived releases are not alternative canonical profile sources.

The new row allows 11 layers per worker at ctx ≤4096, parallel ≤2, chain 0.
The planner requires a coordinator layer and equal worker shares, so with two
workers 11 each is the maximum balanced assignment. The Mac retains 2 layers.
Profile budget: 11 ×80 +512 =1392 MiB per worker; actual NVIDIA counters include
desktop and driver allocations and need not equal this conservative estimate.
Higher concurrency retains the prior measured envelope.

## Review

- Correctness — clean: 22 worker layers leave 2 coordinator layers; insufficient
  GPU offers and excessive worker counts fall back through existing guards.
- Contracts — clean: no new fields; planner.ts chooseRow consumes the row and
  deployments.ts startSplit passes the unchanged Plan contract to node agents.
- Data safety — clean: one additive JSON row, reversible; no DB edits/deletions.
- Time — clean: no time handling change.
- Staleness/concurrency — control restart reloads profiles; idle routing was
  checked before stopping 2B. The same deployment ID and spec are retained.
- Security — clean: no transport/auth change and no credentials in artifacts.
- Tests — added live-config and memory-fallback regression; existing Linux
  coordinator refusal test explicitly uses parallel 4 to retain its 18-layer
  capacity boundary rather than weakening assertions.
- Simplicity — clean: no planner branch, new schema, or duplicated algorithm.

## Acceptance

Applied and validated against the real three-node deployment. Private before/after
evidence and executable verification: ~/.swarmlet/backups/20260906-legion-split/.

- `bun run typecheck` succeeded; `bun test protocol control node-agent node-shell/test`
  reported `146 pass`, `0 fail`, `701 expect() calls`.
- `python3 ~/.swarmlet/backups/20260906-legion-split/verify.py` reported
  `READY split=11,11,2` and
  `PASS: greeting and two concurrent routed replies; deployment ready`.
- Both concurrent requests returned model text, with router inflight reaching 2.
  One response reached its requested 80-token limit; the other finished normally.
- NVIDIA memory after the concurrent test: Legion1 1011 MiB, Legion2 801 MiB,
  versus 511/303 MiB before. Heartbeat samples peaked at 1007/801 MiB.
- First comparable greeting decode: 7.19 tok/s before, 3.75 after. The subsequent
  concurrent responses measured 6.07 and 6.16 tok/s per response. A subsequent
  warm greeting measured 6.71 tok/s (prompt processing still took 15.68 seconds).
  Shared `/v1/mesh` data reports 45.83% /45.83% /8.33% assigned-layer shares. These are short
  checks, not a controlled throughput benchmark; maximizing worker share is not
  equivalent to maximizing speed.
- Control restart reloaded the profile; same deployment ID, context, parallelism,
  internet transport, caps, and node agent binaries retained. External model
  process was not stopped.

Review verdict: merge; no unresolved findings in the eight lenses above.
Full-context saturation and parallelism above 2 were not measured for the new
row; the latter retains the previous envelope.
The first operator readiness wait exceeded 150 seconds while the healthy engine
was still transferring uncached weights through the internet relay; it did not
stop or restart the engine. Runtime loading budget was retained.
