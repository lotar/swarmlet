# Matrix failure recovery — September 9, 2026

## Scope and acceptance

Lotar requested fixes for all 11 failed arms, using five subagents. Work is split
into reconnect handling, stream handling, durable diagnostics, targeted reruns,
and independent review. Runtime concurrency permits three subagents at a time.

| Requirement | Owner | Decision |
|---|---|---|
| Recover transient node disconnects | Lotar | Keep; withdraw route and rebuild invalid RPC sessions safely |
| Never silently truncate a response | Lotar | Keep; explicit stream error and cancellation |
| Retain failure evidence | Lotar | Keep; bounded per-assignment storage |
| Rerun failed configurations | Lotar | Keep; preserve original failures and use a separate result set |
| Automatic replay without cancellation acknowledgement | Unowned | Drop; risks duplicate work |
| Broader latency architecture redesign | Unowned for this repair | Defer; this repair qualifies functionality, not performance |

Existing process managers, routing handlers, journals and fault operators are
extended rather than replaced. Validate each component with focused regression
tests, then the full TypeScript/Python operator suites, matching installed binary
hashes, real three-node fault acceptance and a new 11-arm run.

## Starting evidence

The completed controlled matrix recorded 298 functional passes and 11 failures:
seven node-offline failures, three incomplete SSE streams, and one HTTP 502.
The successful recovery suite does not invalidate those failures.

Live preflight: all three nodes online, standing 3/3/18 deployment ready,
coordinator health OK; Flash-Next :8099 absent. The Mac is on AC power. Existing
swap usage was about 6 GiB, so this work does not claim new latency rankings.

Original artifacts remain at
`~/.swarmlet/backups/mesh-matrix-controlled-20260906`.

## Risks

A transient connection failure may invalidate RPC execution state even when
engine processes survive. Recovery must acknowledge cleanup before replacement,
keep routes withdrawn until ready, and respect intentional Stop. A response that
has already started must never be transparently concatenated with a retry.
Durable logs must remain bounded and private. Tests must not erase historical
failures or claim unsupported matrix families passed.

## Correlated historical failures

Read-only control SQLite events established that the three incomplete streams
and the 502 also coincided with node disconnects:

| Failed arm | Deployment | Event (UTC, September 8) |
|---|---|---|
| `0ad05a4e90b0ab54` | `dep-155e5aa1e112` | L2 offline 13:15:31.890; reconnect 13:15:47.564; coordinator stop 13:16:24.332 matches 130.94-second request EOF |
| `720812d596f8bc13` | `dep-dfbfdc352964` | L2 offline 14:50:50.461; coordinator SIGABRT in `rpc_dispatcher::work_reader` 39 ms later |
| `05e041ba75cce9c2` | `dep-d99b057ec35f` | Mac agent offline 19:10:28.951 before failed repeat |
| `66da350e1a33afd7` | `dep-f8b57dff94eb` | L1 offline 19:48:06.317; automatic recovery 19:49:37.633 |

These events establish interruption and invalidated RPC state, not the physical
cause of each WSS disconnect. No transparent continuation of an interrupted
response is claimed. New tests require explicit errors and safe fresh deployment
recovery. The old runner collected replacement assignment IDs in some failures,
which explains missing original engine logs in the result files.

## Implementation and review

Five distinct subagents contributed. An initial thread limit delayed the fifth
agent, so the durable-evidence agent first independently reviewed the stream
and reconnect changes it did not author. The fifth agent later audited the
installed release and rerun evidence independently. The primary agent integrated
and checked all changes and updated the metrics fixture to provide its required
stateDir.

The stream helper is shared by router and node gateway. It reports premature
SSE EOF explicitly, propagates cancellation, preserves request IDs, and never
replays a POST. Independent review additionally reproduced and fixed forwarded
gzip headers after fetch decompression. Real HTTP regression tests cover both
hops and direct router clients.

The physical fault operator now interrupts a real streamed response after its
first content by stopping Legion 1, requires an explicit interruption error,
then checks new assignment IDs, fresh inference and OS process/port ownership.
It continues its existing channel pause, node restart, control restart and
intentional-stop checks. Live results are recorded below after execution.

## Pre-install validation

- TypeScript typecheck passed.
- `bun test protocol control node-agent`: 162 pass, 0 fail.
- `bun test e2e`: 6 pass, 0 fail, 62 assertions (96.46 seconds).
- Python operator discovery: 40 tests, OK.
- Original offline-Stop e2e regression failed with HTTP 400 before the canonical
  bounded acknowledgement wait fix; the unchanged test passes afterward.
- Additional regressions cover reconnect returning inside grace while cleanup
  finishes later, bounded cleanup expiry, and RPC abort reports during recovery.
- Fresh targeted plan: 11 arms, 51 repetitions; original evidence unchanged.

## Installed release and physical fault acceptance

Revision `7e8092628b588195c1e4e4304bc226780293dc7b` was built and installed
on all three machines. The installer verified matching packaged GUI sidecars
and service binaries and all three refreshed agents online. Evidence:
`~/.swarmlet/backups/20260909T080752Z/refresh.json` (`success: true`).

The real fault operator completed at 08:20:12 UTC with `success: true` and
`cleanupErrors: []` in the same directory's `real-faults.json`. Its physical
stream cut returned `upstream_stream_interrupted` at 6.703 seconds from request
start, after first content at 5.078 seconds, without a successful DONE marker.
Fresh assignments, subsequent inference and OS process ownership checks passed.
The channel pause with surviving worker, Legion service restart, control
restart, intentional-stop retry-window check and final inference/process audit
also passed. The suite ended with the standing deployment ready.

The 11-arm targeted run is recorded separately at
`~/.swarmlet/backups/mesh-matrix-failures-20260909`.

## Targeted rerun results

All 11 original failed arms passed all 51 planned repetitions. Independent
artifact review counted 182 requests: all contained nonempty text and DONE,
with zero recorded request errors. Selection exactly matches the original
11 failures; preserved manifest/results provenance hashes match their source.
The original failed run is retained unchanged.

The rerun recorded 171 latency-threshold misses. This repair establishes
functional acceptance for these configurations, not latency acceptance.
The 17 blocked families remain unqualified.

Final post-matrix `faults.json` completed at 09:41:50 UTC with `success: true`
and `cleanupErrors: []`. All interruption, recovery, restart, intentional-stop,
inference and OS ownership checks passed again after the 51 repetitions.
`journal.json` records `deployment: null`, empty temporary `profiles`, and
restoration at 09:36:02 UTC. The final fault suite leaves the standing deployment
ready. Summary status `pass: 12` means 11 arms plus the fault suite, not 12 arms.
The runner's expected exit status is 2 because 17 proposed families remain
blocked; it does not indicate a failure among the 11 executed arms.
