# Permanent physical mesh matrix

The canonical operator is `swarmlet/e2e/mesh-matrix.py` (Python standard library).
The matrix is a **screening campaign**, not a claim that every proposed architecture
exists or that short-request throughput qualifies interactive chat.

## Commands

Run from the repository root. Evidence belongs outside the repository; it includes
machine paths, engine logs, synthetic prompts and metrics, but no API credentials.

```sh
OUT="$HOME/.swarmlet/backups/mesh-matrix-$(date -u +%Y%m%dT%H%M%SZ)"
python3 swarmlet/e2e/mesh-matrix.py plan --out "$OUT"
python3 swarmlet/e2e/idle-window.py -- \
  python3 swarmlet/e2e/mesh-matrix.py run --out "$OUT"
python3 swarmlet/e2e/mesh-matrix.py status --out "$OUT"
```

The same `run --out` resumes completed arms/repetitions without repeating them.
The manifest pins the runner source hash, seed and repetition count; changed
inputs require a new output directory. Do not manually set `SWARMLET_IDLE_WINDOW`.
The wrapper waits for 60 quiet seconds and invokes the existing maintenance
client/ownership guard before stopping Flash-Next. It restores Flash-Next after
the child exits. Never kill the wrapper with SIGKILL. TERM/INT lets owned cleanup
finish; a second signal is ignored during baseline restoration.

For a deliberately partial regression check, add `--only P0`. For a recovery from
an uncatchable interruption, run `restore --out "$OUT"` through the same idle
wrapper after verifying no previous campaign is alive. `restore` only deletes
journalled profiles whose path, campaign prefix and content hash match. It restores
the baseline's original running intent, not an assumed desired state.

Do not use `--repeats 1` as qualification. Five is the screening default.
The entire campaign can take many hours or days: deployments reload for each
repetition and queued concurrent workloads can take minutes. No unmeasured ETA
is implied. Results checkpoint after each repetition and arm, so interruptions
do not erase completed evidence. A request timeout is retained as a failure.

## Runnable coverage

- Three first arms: Mac replica, 3/3/18, and the withdrawn 11/11/2 regression.
- All 23 positive splits for Mac plus either one Legion.
- All 11 balanced three-node splits in both worker orders.
- Each placement over forced relay and automatic direct-with-relay-fallback.
  Actual assignment transport details are recorded; `auto` is not labelled LAN.
- Forwarding on/off × batched reads on/off × raw/F16/Q8 wire × auto/relay,
  on representative 3/3/18, 6/6/12 and 11/11/2 placements.
- Greeting, five-message chat, approximate 128/512/1024-token text and 31-message
  conversation; 1/64/256 output limits; 1/2/4/8 simultaneous clients.
- 1/2/4 execution slots with 2048 context positions per slot; batch/microbatch
  128/32, 512/128 and 2048/512; direct engine, Mac node API and control API.
- Each repetition restarts the deployment and sends a process-cold request group,
  followed by an identical prefix-repeat group. This is **not** proof that every
  repeated request hit the engine's prefix cache; use reported engine timings.
- One baseline arm interleaved every ten arms. Compare these before attributing
  differences to a tested knob. Old historical measurements are not controls.
- Existing `real-rig-faults.py` runs after screening: channel pause/reconnect,
  Legion1 service restart, control restart, intentional stop and real inference.

This is staged coverage of dimensions, not the full Cartesian product of all
network, model, placement, prompt and failure dimensions. The catalogue deduplicates
identical configurations, except intentional interleaved baseline repetitions.

## Explicitly incomplete coverage

`manifest.json.blocked` is part of the result, not a list of successful skips:
484 asymmetric allocation/order cases, Legion replicas/pools, coordinator
relocation, persistent stage services, prefill/decode disaggregation, compatible
speculative-model testing, independent public relay, truly separate-network peers,
separate transport channels, scoped network impairment, graph-cache/prefill-engine
variants, CPU thread adapter, routing policies, native visible clients, remote
Legion client timing, full per-node/per-phase fault grid, and tail/soak qualification.

Some need architecture work; some (thread sweep and remote-client timing) need
additional runner adapters. These are not external-environment excuses and must
not be reported as tested. UI automation is unavailable in this session; HTTP
checks cannot establish that native windows render or remain interactive.
Current worker offers do not allow replicas and no 2B file is registered on them;
this runner does not silently rewrite persistent offers or install models.

Trace limitations: current logs and telemetry report prompt/decode timings and
resource/network samples. The runner does not yet enable per-command client/server
RPC traces, GPU timelines, or request IDs across all internal stages. It therefore
cannot fully apportion the 40-second prefill regression. Lossy wire arms report
text and stream completion but are **not quality-qualified**; cross-run semantic
and parity evaluation is still required. These gaps prevent production promotion.

## Results and interpretation

- `manifest.json`: exact ordered plan, seed, runner SHA256 and unavailable families.
- `journal.json`: baseline state and only resources owned by this campaign.
- `results.json`, `summary.json`: completed repetitions, errors, functional outcomes,
  and latency gate failures. `status` is read-only while the campaign runs.
- `arms/<arm-id>/<rep>.json`: plan, load time, prompt count, full SSE output,
  first content time, per-content-chunk timestamps, finish reason, DONE evidence,
  engine timing/usage fields when present, node samples, route details and logs.
- `faults.json`: existing real-rig acceptance output after screening.

Prompt labels are targets, not tokenizer claims. Synthetic text is trimmed using
actual chat-template/tokenizer endpoints; actual prompt counts are recorded. Full
conversations are rejected when prompt plus requested output exceeds per-slot
context, never silently truncated. Load latency is reported separately. Request
wall time includes the route; first content is not confused with receipt of headers.
Null content role chunks and empty usage chunks are valid SSE.

`pass` means functional stream completion with visible text, not latency success
or correctness of the model's statements. Short-chat provisional latency limits:
10 seconds process-cold, 5 seconds prefix-repeat. The runner also records these
thresholds for longer workloads for comparison; they are not approved long-context
SLOs. p95 is not inferred from five repetitions. Finalists need >=100 requests per
representative condition, quality checks, the full fault grid and soak testing.
The command exits **2** while blocked families remain or any runnable case fails;
zero must never be interpreted as success by suppressing unavailable cases.

## Implementation plan and review

Owner: Lotar. Requirements retained: permanent reproducible operator, execute
available cases, retain failures, save evidence, document reruns and recovery.
Deleted: temporary one-off scripts, unsafe global network changes, claiming
unimplemented variants as passes, and replacing runtime architecture inside a test.
Simplified: reuse deployment lifecycle, profile loader and the existing idle/fault
operators. Accelerated: deterministic manifest, checkpointed resume and deduplicated
arms. Automated only available backend configurations, after capability enumeration.

Pre-mortem: a failed experiment strands the live mesh or corrupts comparisons.
Mitigations: output/global locks, journal-before-mutation, campaign ownership checks,
try/finally restoration, original running intent, source-pinned manifest, full
failure records and interleaved baselines. Test profiles are isolated by unique
IDs and alias, loaded temporarily; the shipped qwen35-2b-q8 profile is never edited.
No test result automatically changes production placement.

Validation: `python3 -m unittest discover -s swarmlet/e2e -p 'test_*.py'` covers
manifest enumeration, deterministic deduplication, SSE null/usage/error/EOF handling,
atomic checkpoints and refusal to delete foreign/modified profiles. Live acceptance
must include actual startup, SSE response and cleanup; unit success alone is insufficient.

## 2026-09-06 campaign

Launched the full runnable manifest (no `--only` filter), 309 arms including 28
interleaved controls. Experimental arms have five repetitions; each interleaved
control has one. Output directory on the operator Mac:
`~/.swarmlet/backups/mesh-matrix-full-20260906`.

```sh
python3 swarmlet/e2e/mesh-matrix.py status \
  --out "$HOME/.swarmlet/backups/mesh-matrix-full-20260906"
tail -f "$HOME/.swarmlet/backups/mesh-matrix-full-20260906/campaign.log"
```

This entry records launch, not completion. The campaign has 17 blocked coverage
families. The user-facing chat deployment is intentionally unavailable while
experimental deployments own the hardware; the idle wrapper handles production
maintenance and the runner restores the standing mesh at exit. Check journal and
log before attempting any manual intervention.

Review lenses: correctness—functional versus latency outcomes explicitly separate;
contracts—uses existing server deployment API, strict profile schema and SSE;
data safety—only owned, hash-matching temporary profiles/deployments are removed,
restoration is idempotent and original baseline intent journalled; time—UTC labels
and monotonic durations; concurrency—exclusive campaign locks and guarded idle
entry; security—no tokens serialized or shell-interpolated; tests—30 operator
tests passed, physical startup still to be observed; simplicity—existing idle and
fault operators reused. Full coverage remains incomplete for the listed reasons.

Live operator validation: five Mac-only repetitions completed with valid DONE
streams. The first process-cold request's first content was 0.385 seconds; its
prefix repeat was 0.067 seconds. These are preliminary observations, not qualified
hardware rankings. A controlled SIGTERM to the idle wrapper during the next arm
exercised real cleanup: all 309 owned profiles removed, no owned test deployment
remaining, and original 3/3/18 mesh ready. Journal `restoredAt`:
2026-09-06T13:24:04.675956+00:00. The wrapper then reloaded production as designed.
Completed repetitions remain checkpointed; the interrupted repetition is rerun.


### Controlled-input correction

Interval monitoring found arm IDs embedded in model prompts: the original
3/3/18 baseline had 81 prompt tokens and an interleaved control had 68. The
`mesh-matrix-full-20260906` campaign was stopped gracefully after 11 completed
arms. Preserve those results as exploratory functional observations; they are
superseded for controlled performance comparisons.

The corrected runner uses fixed messages per workload, independent of arm and
repetition. Synthetic text trimming preserves the summarization instruction.
Each repetition records `promptSha256` and actual `promptTokens`; a journalled
per-workload invariant rejects input drift before inference. Fresh engine starts
still establish process-cold repetitions without adding prompt nonces.

The replacement full campaign uses
`~/.swarmlet/backups/mesh-matrix-controlled-20260906`. Its manifest and results
are separate from the old campaign. Launch does not mean completion, and the
17 blocked families remain explicitly untested.


### September 8 recovery and resume

The controlled campaign exited September 7 at 04:38 UTC after 170 successful
arms and one incomplete arm (two of five repetitions saved). HTTP 400 occurred
in deployment stop; immediate cleanup and final restoration repeated the error.
The original runner discarded the server response body, so the exact historical
server reason is unavailable. Retrying the same stop on September 8 succeeded.

Stop/delete now retry transient cleanup acknowledgements and connection failures
for at most 20 minutes, journal the pending operation, and retain server error
bodies. Invalid requests still fail immediately. The control plane continues to
require acknowledged stops before releasing assignments or deleting deployments.

Resume a reviewed runner-only repair using `--accept-runner-update`; this archives
the previous manifest and requires the entire workload catalogue to be unchanged.
Use `--retry-incomplete` to finish errored arms with missing repetitions, retaining
the previous error and completed evidence. These options do not qualify different
benchmark inputs as comparable; review the code change before accepting it.

```sh
python3 swarmlet/e2e/idle-window.py --allow-stopped -- \
  python3 swarmlet/e2e/mesh-matrix.py run \
  --out "$HOME/.swarmlet/backups/mesh-matrix-controlled-20260906" \
  --accept-runner-update --retry-incomplete
```

`--allow-stopped` is explicit: it requires the production launch service to be
unloaded, its port to refuse connections, and router requests to remain idle.
It preserves that stopped state. Omit this flag when production is running;
the normal idle guard will stop and restore it. The campaign independently
checks the standing mesh for active local requests before taking it down.

The separate report monitor writes local files every 1800 seconds. It does not
deliver chat notifications or automatically restart failed campaigns. Its final
report marks an exited runner; inspect restoration and errors before resuming.

### Targeted failure reruns

Use a fresh output directory to rerun only failed arms without rewriting the
original campaign. Selection retains each arm's exact configuration and original
repetition count. For the September 6 controlled campaign this selects 11 arms
and 51 repetitions, including its one-repetition interleaved baseline.

```sh
python3 swarmlet/e2e/mesh-matrix.py plan \
  --failed-from "$HOME/.swarmlet/backups/mesh-matrix-controlled-20260906" \
  --out "$HOME/.swarmlet/backups/mesh-matrix-failures-20260909"
python3 swarmlet/e2e/idle-window.py --allow-stopped -- \
  python3 swarmlet/e2e/mesh-matrix.py run \
  --failed-from "$HOME/.swarmlet/backups/mesh-matrix-controlled-20260906" \
  --out "$HOME/.swarmlet/backups/mesh-matrix-failures-20260909"
```

Only use `--allow-stopped` when Flash-Next is already unloaded and its port is
closed. Otherwise omit it and use the normal verified idle window. The fault
operator still runs after targeted screening; unsupported families remain
blocked. Every request has an `x-request-id`. Failure records preserve partial
text, upstream HTTP error bodies, original assignment IDs, control events and
retained logs from all three agents. Diagnostic collection failures are explicit.

Agents retain bounded private logs under `state/assignment-logs` after cleanup
and restart: at most 128 assignment files, 256 KiB per file, 8 KiB per line and
400 lines per query. Capture them promptly; retention intentionally evicts old
records. Logs from before this feature cannot be reconstructed retrospectively.
