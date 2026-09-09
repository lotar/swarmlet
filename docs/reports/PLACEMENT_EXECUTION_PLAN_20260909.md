# Placement and execution expansion — September 9, 2026

## Requirements

| Requirement | Owner | Decision |
|---|---|---|
| Unequal per-worker layer placement | Lotar | Keep; exact counts and fit checks are missing |
| Legion replicas and pools | Lotar | Keep; reuse replica deployments and existing router pooling |
| Coordinator relocation | Lotar | Keep; existing explicit selection needs provisioning and physical qualification |
| Persistent execution stages | Lotar | Keep; resident partial-model contexts must execute their own stages |
| Prefill/decode separation | Lotar | Keep; transfer full compatible attention and recurrent state |
| Speculative decoding | Lotar | Keep; draft/verify counters and correctness must be demonstrated |
| New replica-pool resource/scheduler | UNOWNED | Drop; existing same-model router already pools deployments |
| Generic stage API for every architecture | UNOWNED | Drop from initial implementation; qualify current Qwen3.5-2B first |
| New draft-model download or speculative tuning API | UNOWNED | Drop; shipping engine has ngram-simple support without extra weights |

## Deleted, simplified, accelerated, automated

Delete a new pool resource, replacement scheduler, extra speculation tuning fields,
and a generic multi-architecture stage framework. A compatible draft model may be
added back only if native ngram speculation cannot exercise real acceptance.
Reuse existing deployment lifecycle, node offers, routing, recipes and guarded
maintenance. Use exact per-worker counts and one explicit ngram mode. First prove
native staged execution and full state transfer before exposing their deployment
schema. Three parallel subagents own placement, speculation and native stages;
the primary agent owns provisioning, control integration and serialized physical
qualification. Automate qualification only after its contracts pass local tests.

## Goal and initial state

Done means all six requested capabilities have implementation and physical evidence,
with original standing deployment restored and existing recovery checks retained.

Initial live API: all three nodes online, Qwen3.5-2B relay split ready; Legions have
worker-only offers and no registered model. Source import chain is main.ts ->
server.ts -> DeploymentManager -> planDeployment. Existing planner already selects
explicit replica/coordinator nodes. Router pools ready same-model deployments.
Worker counts are currently equal. Replica assignment drops planner MTP/device data. Review also verified that native tensor-split weights include an output slot; the new explicit placement path needs separate engine weights. Automatic placement keeps its historical weight semantics.
Native engine supports ngram speculation. RPC workers are not autonomous layer
stages. Full engine sequence serialization contains both attention and recurrent
state, but stock files alone do not bind state to a model digest.

## Steps and validation

1. Add explicit workerLayers with ordered node IDs, envelope/fit checks and legacy
   defaults. Run `bun test control/test/planner.test.ts` and typecheck.
2. Wire explicit ngram mode and replica device/MTP. Run recipes/planner regression
   tests and native request comparisons with draft/accept/reject counters.
3. Provision the existing 2B artifact on both Legions with verified hashes. Enable
   requested roles through owner APIs; qualify asymmetric placement, individual
   replicas, pooled routing and relocated coordinators inside idle-window.py.
4. Build isolated native Qwen35 stage proof: shard weights, resident partial-model
   contexts, raw boundary activations, sequence ownership. Compare activations,
   logits and generated tokens with an unsplit reference across repeated calls.
5. Implement bounded full-state prefill/export/import/decode with model, engine and
   layout identity. Compare same-node and cross-node continuation with reference;
   reject incompatible/truncated snapshots and sequence conflicts.
6. Integrate only verified native interfaces, build matching packages and run the
   full local suites plus physical feature and recovery qualification. Preserve
   per-feature evidence and update coverage only for passing concrete cases.

## Risks and pre-mortem

Most likely failures are incorrect shard layer renumbering, missing hybrid recurrent
state, wrong post-stage normalization, snapshot/model incompatibility, GPU fit,
and overlapping runtime owners. Prevent them with explicit metadata, reference
comparisons, bounded state, per-node fit checks and one guarded physical operator.
A speedup is not assumed; measure it separately from functional correctness.
The initial stage/P-D model is Qwen3.5-2B. No other blocked families are included.
No runtime may be stopped outside its owning maintenance operator.

## Scope

Implement and physically qualify the six requested placement/execution capabilities;
retain existing functionality and restore the rig after each experiment.

## Initial implementation checks

The integrated TypeScript component suites currently pass 176 tests. The focused
planner/recipe/assignment tests pass 68 tests, including explicit engine weights,
external-option rejection and speculation propagation. Python operator discovery
passes 61 tests. These are local checks, not physical feature acceptance.

The 2B model was copied and SHA-256 verified on both Legions, then registered by
each node model rescan. Digest:
`1b04acba824817554f4ce23639bc8495ff70453b8fcb047900c731521021f2c1`.
The placement/speculation release `69d8b92` is installed as matching service and GUI
binaries on all three nodes. The installer passed the full physical recovery suite
and restored the standing deployment. Each owner API enabled the three requested
roles; before/after offers are retained with the installation evidence.

Replica MTP is explicitly refused pending full target+head memory qualification;
ngram speculation is the requested speculative-decoding path for this campaign.
Existing MTP recipe plumbing is retained, but is not claimed physically qualified.

## Placement/speculation integration review

All eight review lenses were checked before the first installation. Correctness:
fixed explicit layer weights including the native output slot. Contracts: traced
planner -> deployment assignments -> recipes; external deployments reject options
they cannot apply; UI distinguishes exact layer counts from historical weights.
Data safety: qualification retires only owned deployment prefixes and restores the
baseline; model copy refuses mismatched existing files and verifies new copies.
Time: UTC evidence and monotonic waits. Concurrency: existing router/lifecycle,
serialized physical ownership, explicit cleanup acknowledgements. Security: no new
public endpoint; existing admin authorization, strict speculation whitelist and
validated node/count arrays. Tests: 176 component tests, six simulated E2E tests,
61 Python operator tests, typecheck and diff checks pass. Simplicity: existing
replicas form pools, existing runner supplies cleanup, one speculation argv helper.
Those checks authorized the first installation. Physical results are recorded
below; they do not yet establish completion of all six requested capabilities.

## Native integration review

The independent integration review checked all eight lenses across planner,
deployment lifecycle, routing, node assignment/probing and the UI. It corrected
one UI contract error: compact native evaluation selects the greedy token in the
worker; control decodes returned bytes and streams text. Cleanup acknowledgements
hold the deployment lease until resident reset completes, and old callbacks cannot
fail a new deployment lifetime. Qualification records are controller-owned and
were initially empty pending native proofs. Existing admin and authenticated agent
transports are reused. That review found no other defects.

Measured CUDA host residency also exposed a planner admission error: the generic
1,024 MiB host allowance could admit a native worker requiring about 2,206 MiB.
Native records now require a positive `hostMiB` reserve. A red/green regression
proves that Linux offers below the qualified reserve reject and exact-boundary
offers pass; Mac unified fit includes the same reserve. The GPU calculation is
unchanged. The 52 focused tests passed after this correction. After the precision
identity alignment (F32 K/V, microbatch 1, disabled Flash Attention), the full
component run passed 232 tests with 1,236 assertions, plus typecheck.

Node restart and offer-refresh scans previously discarded verified model hashes,
which would block native recovery until another explicit rescan. The canonical
inventory now persists hashes from explicit scans in a private atomic cache and
reuses them only when path, device, inode, size, and nanosecond modification/change
times still match. Hashing verifies metadata both before and after reading. Changed
or corrupt entries remain unqualified, and the native worker still hashes the
actual file before loading. The original regression is green; 33 probe/cache tests
with 115 assertions and an independent eight-lens review pass. The initial
post-install hash rescan remains required to populate this cache.

The final integrated suite exposed a macOS process-retirement race after SIGTERM:
an exiting Bun child briefly retained its start time while its command became
`(bun)`, before `ps` reported it defunct. The canonical retirement guard now waits
through ambiguity only after a confirmed signal. Pre-signal identity checks remain
strict; any ambiguous interval prevents further signalling, and persistent
ambiguity fails closed. The original CPU reproducer passed 100 retirements after
the fix. The full component suite then passed 244 tests with 1,267 assertions,
typecheck passed, and all 77 Python operator tests passed. The native ABI is unchanged.
The final simulated E2E run also passed all six tests (62 assertions). Native CPU
checks passed all eight tests on Linux; Mac passed seven with the Linux-specific
test skipped. These checks precede package refresh and installed-router acceptance.

Fresh integrated checks after the native implementation: `bun run typecheck`,
229 component tests with 1,211 assertions, and 77 Python operator tests pass.
The final UI wording correction additionally passed JavaScript syntax and 69
focused tests with 477 assertions. Physical native acceptance remains separate.

## Physical results so far

The second placement run passed all ten cases: exact `2/3/19` and `3/2/19`
transformer-block splits, six replica/pool configurations, and each Legion acting
as coordinator. Every pooled member served complete routed streams. The standing
deployment was restored at `2026-09-09T12:35:48Z`.

The first run retained six passing replica cases and four evidence failures. Core
native model metadata is suppressed at default verbosity 3; startup logs were
complete but lacked the required layer/offload information. Explicit placements
now set `LLAMA_ARG_LOG_VERBOSITY=4` in their coordinator assignment. The rerun used
the original allocation assertions and proved exact block counts from actual
assignment weights and loaded native model metadata. Historical automatic split
weights retain their previous behavior.

Speculation passed both the Mac replica and relay split cases. Each compared four
fixtures against non-speculative generation with exact token and text matches,
zero drafts in the baseline, and consistent draft/accept/reject counters. Both
cases exercised accepted and rejected draft tokens. The standing deployment was
restored at `2026-09-09T12:45:21Z`.

Local native proof 04 passed at context 1024: resident `3/21` and `3/3/18`
stages matched every captured activation and all 248,320 logits exactly across
nine evaluations. Full-state prefill/decode transferred 20,325,212 state bytes and
a 4,826,842-byte envelope through acknowledged HTTP chunks, then produced eight
continuation tokens with zero prompt replay and exact logits. The proof also
rejected corrupted state/metadata, incompatible identities, conflicting sessions
and invalid HTTP origins. This rerun includes the export cleanup/close-error fix
in engine ABI `c1ba1477f734e69597318f7a4b0446b789611538815645e7e5c0f332667ac31d`.
Proof 03 is historical evidence for the preceding ABI.

Cross-node proof 01 failed at the first CUDA stage boundary:
`cross-chain2-stage0-step0: float mismatch max_abs=0.015679478645324707`.
The fixed gate remains `atol=0.001, rtol=0.0001`. The operator stopped at the
failure and restored the baseline at `2026-09-09T12:54:40Z`. Root-cause analysis
then compared the CUDA shard with a full CUDA model under the same forced token
sequence. All nine CUDA shard/full-model boundaries matched exactly. Full CUDA
versus Metal reproduced the boundary discrepancy, had logit differences up to
0.33748, and selected a different greedy token at one step. This isolates backend
arithmetic as the cause of the observed mismatch. The diagnostic restored the
baseline at `2026-09-09T12:59:31Z`.

The next diagnostic applied tiled F32 cuBLAS to native Q8_0 linear operations,
retaining the original weight bytes and using explicit pedantic math. Dequantized
workspace is bounded to 32 MiB. Diagnostic 02 matched all nine greedy tokens and
reduced full-model logit differences to 0.006–0.016, but still failed the original
float gate. Four of 38,912 prefill boundary values exceeded tolerance; all decode
boundaries passed. CUDA shard/full boundaries remained exact. Measured full-model
peak GPU memory was 2,122 MiB and host RSS about 2,206 MiB. Prefill arithmetic is
the next diagnostic target; this change is not yet qualified.

Diagnostic 02 retired all native workers, but baseline restoration initially
failed when Legion 2's control channel lost heartbeats. SSH and its node service
remained available; the agent reported a connected channel while control marked
it offline, and its logs recorded relay reachability failures. Restarting only
that node service restored heartbeats. The existing guarded restore completed at
`2026-09-09T13:14:04Z`, verified the original `[3,3,18]` plan, and a pinned routed
stream returned HTTP 200, `OK`, and `[DONE]`. Original failure evidence was retained.

Further diagnostics isolated the remaining discrepancy. Single-token prefill
eliminated the early batched-matmul difference, and capture at the first attention
layer showed the residual error growing there. Disabling Flash Attention and
requesting F32 value accumulation passed twelve comparisons before F16 cache
rounding still exceeded the fixed gate. Using F32 K/V storage then passed all 27
diagnostic comparisons (19 prompt tokens and eight decode steps): no outliers,
all greedy tokens equal, maximum attention-boundary difference `1.073e-6`, and
maximum full-vocabulary logit difference `1.240e-5`. This is engine ABI
`fefcec450d5b009e1f6fd2853c892e7d4be45d6a765ce9f7207d94e9589f9a3c`.

The full final-profile runs then passed: local proof 05 matched all activations,
logits and tokens exactly for both stage layouts and full-state transfer. Cross
proof 02 passed the two-stage and three-stage chains and both state-transfer
directions. Maximum absolute differences were respectively `1.001358e-5`,
`9.536743e-6`, `7.629395e-6` and `5.722046e-6`, all inside the unchanged float gate;
every greedy token matched and decode receivers evaluated zero prefill tokens.
All native workers retired, and the original standing deployment was restored at
`2026-09-09T13:38:43Z`.

Four controller admission records now pin the final source ABI, platform binary
hashes, artifact hashes and cross-proof SHA-256
`5bddb3bec4a3bd437af76f8dd3b045e5e73fbbc9365bb725e6780d34d5ea3d79`.
An independent executable comparison matched every record to the actual proof
identities. Maximum measured host RSS was 2,205.60 MiB and GPU residency 2,072 MiB;
the records reserve the entire source model plus 512 MiB GPU workspace and 3 GiB
host RAM. Installation, its first live integration findings, and final routed
acceptance are recorded below.

## Installed integration checks

The full refresh of revision `b5f1cc1` installed matching GUI/service binaries on
all three nodes and passed the real fault suite at `2026-09-09T14:04:29Z`.
The installed Linux packages contained the qualified native engine, but the
refresh operator left `enginePath` pointing at the old engine directory. The
canonical refresh now verifies transferred package/helper hashes and invokes a
guarded activation helper. That helper requires a stopped user service and empty
assignment ownership, checks all four packaged executable hashes, privately
backs up the configuration, and atomically changes only `enginePath`.

Applying the same helper to both Legions passed. All three nodes advertised the
qualified native ABI and actual worker hashes, and a separate installed audit
passed 23 checks against the GUI/service release manifests. Explicit rescans
hashed nine Mac artifacts and two artifacts on each Legion; Legion 2 retained
both hashes across a service restart. The baseline was restored at
`2026-09-09T14:08:16Z`. All 84 Python operator tests passed.

All four native specs then passed controller admission. The first actual routed
deployment exposed an omitted protocol case: the agent's control-message parser
rejected `stage` assignments with `unknown assignment kind stage`, before the
native supervisor ran. The qualification operator was interrupted through its
cleanup handler and restored the baseline at `2026-09-09T14:11:33Z`; its failed
attempt is retained. The canonical parser now accepts fully validated stage
assignments, including full-model P/D contexts, and rejects malformed native
identities, resource limits and fields. Regression tests exercise serialized
messages through `parseControlMessage`, where the real failure occurred.
The dispatch audit also corrected the participant processing snapshot to show
every stage with its actual layer count, or both Prefill/Decode roles without
inventing a percentage of computation. The corrected release was then installed
and the routed acceptance cases repeated, as recorded below.

## Final acceptance

All six requested capabilities are implemented and physically qualified for the
documented model/configuration scope.

| Capability | Physical evidence |
|---|---|
| Asymmetric placement | Exact `[2,3]` and `[3,2]` worker-block layouts pass |
| Legion replicas and pools | Individual Legions, Mac/Legion pairs, both Legions and all-node pools pass |
| Coordinator relocation | Both Legion coordinators pass |
| Persistent stages | Legion/Mac two-stage and Legion/Legion/Mac three-stage routed cases pass |
| Prefill/decode separation | Mac-to-Legion and Legion-to-Mac routed cases pass |
| Speculative decoding | Mac replica and split cases pass, with native draft/accept evidence |

The final installed code revision is `4dd13767f234fdd9cc0dfdeba7b12a7c5fa74e12`.
Its full refresh passed the simulated end-to-end suite and real fault acceptance.
An independent installed audit passed all 26 checks: matching GUI/service build
manifests, exact qualified native worker hashes/ABI, and persisted model inventory
hashes on all three nodes (9/2/2 artifacts). Local checks passed 249 component
tests (1,387 assertions), six simulated end-to-end tests (62 assertions), 84 Python
operator tests, typecheck and diff checks.

The repeated native run passed all four cases and 20 completed requests. Each
case covers streaming and JSON chat/completions, stable resident PIDs across
requests, HTTP 429 during an overlapping request, cancellation followed by clean
reuse, and connection-refused proof after worker retirement. Four real `/v1/mesh`
snapshots also passed endpoint order, role and layer-count checks, without
exposing private assignment fields. Native numerical/token equivalence and zero
receiver prefill remain pinned to the unchanged native proof recorded above.

The first baseline restoration attempt after those four passing cases hit a
temporary classic RPC server bind failure (`Failed to create server socket`).
The controller recovered automatically to READY at `2026-09-09T14:42:42Z`.
A separate guarded `native-rig.py restore` completed with exit zero and recorded
restoration at `2026-09-09T14:43:31Z`, retaining the original `[3,3,18]` split.
The original operator failure was retained; no acceptance assertion was relaxed.
Final verification confirmed all 16 feature cases, no remaining native deployment,
all three nodes online, removed temporary install credentials, and a pinned routed
baseline smoke response of `OK`.

Native stages/P-D remain qualified only for Qwen3.5-2B Q8_0, context 1024, one
active request per deployment, greedy text generation and 1–128 output tokens.
This is functional/correctness qualification; it does not claim a speedup.

Evidence is retained privately under `~/.swarmlet/backups/`:

- `20260909T120314Z/refresh.json` and `real-faults.json`.
- `placement-features-20260909/` (first attempt) and
  `placement-features-20260909-02/` (10/10 pass, restored baseline).
- `stage-proof-20260909-03/result.json`, its memory sample, and
  `stage-window-20260909-03/journal.json` (restoration/process cleanup).
- `speculation-features-20260909/results.json` and `summary.json` (2/2 pass).
- `stage-proof-20260909-04/result.json`,
  `stage-cross-proof-20260909-01/result.json`, and
  `stage-window-20260909-04/journal.json` (current ABI, failed cross-node gate,
  restored baseline).
- `stage-backend-diag-20260909-01.log` (CUDA shard/full reference isolation).
- `stage-backend-diag-20260909-02/result.json` (bounded F32 path; residual
  numerical mismatch retained).
- `native-baseline-recovery-20260909/` (before-state, guarded restore, routed
  smoke response and headers).
- `stage-microbatch-diag-20260909-03/`, `stage-attention-diag-20260909-04/`,
  `stage-attention-diag-20260909-05/` and `stage-cache-diag-20260909-06/`
  (progressive precision diagnostics; final diagnostic 27/27 pass).
- `stage-proof-20260909-05/result.json`,
  `stage-cross-proof-20260909-02/result.json`,
  `stage-window-20260909-05/journal.json`, and
  `stage-final-resources-20260909.json` (final-profile proofs and restoration).
- `20260909T135233Z/refresh.json` and `real-faults.json` (installed `b5f1cc1`
  release and full recovery acceptance).
- `native-activation-20260909T1406Z/` (guarded Linux activation, inventory cache
  persistence, installed binary audit and restored baseline).
- `native-routed-features-20260909/` (first routed attempt, parser rejection,
  interrupted qualification and restored baseline).
- `20260909T141704Z/refresh.json`, `real-faults.json` and
  `final-installed-audit.json` (final installed release and 26-check audit).
- `native-routed-features-20260909-02/` (`summary.json`: 4/4 pass;
  `results.json`: 20 requests plus cancellation/busy/retirement checks;
  `processing-snapshots.json`: four live projections;
  `journal.json`: guarded baseline restoration;
  `final-verification.json`: final aggregate checks and baseline smoke).
