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

## Goal and current state

Done means all six requested capabilities have implementation and physical evidence,
with original standing deployment restored and existing recovery checks retained.

Verified live API: all three nodes online, Qwen3.5-2B relay split ready; Legions have
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
Roles and native packages are not yet updated. Native stage proof is in progress.

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
Physical qualification is pending; these checks authorize installation, not a
claim that the six requested capabilities are complete.
