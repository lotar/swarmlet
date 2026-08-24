# PoC Spec — MoE Loop + Locally-Simulated Mesh

> **STATUS: DONE — P0a acceptance passed 2026-08-24.**
> `bun test test/e2e.test.ts` → 8/8 green against real OLMoE-1B-7B-A1B (Q8_0, llama.cpp on :8081), reproduced on two consecutive runs.
> Evidence highlights: refine provenance commits verified; gate noise-aware three-way verdict (accept/keep/revert) — genuine lift 0.67→0.71 accepted, injected context-blowout regression 0.75→0.00 auto-reverted with signed cert; audition of node A's artifact against node B's private shard measured 0.600→0.400 → signed REJECT (transfer problem solved by measurement); distributed certification 24 instances across 3 processes with triple-run cross-check (minCopies=3, zero disagreements); churn drill SIGKILLs node C mid-run, certification completes via requeue.
> Design note added during acceptance: the gate verdict is noise-aware (one-sided ~95% binomial margin over the paired instance set) — a single flipped instance can never be misread as a regression; ties resolve to "keep" (incumbent stays, candidate not promoted).

Implementation contract for phase **P0a** (see PRD §5). All work happens in `/Users/lotar/projects/ai-mesh/sin-harness/`.

## Goal statement

Prove the five-layer thesis on a ≤12B MoE model (OLMoE-1B-7B-0125-Instruct Q8_0) with distributed compute exercised as a **local multi-process simulation**, end-to-end, before any external claim.

## Hard rules for all implementers

1. **Zero npm dependencies.** Bun built-ins only: `fetch`, `Bun.spawn`, `bun:sqlite`, `node:crypto` (ed25519), `node:fs`. No installs, no lockfile churn.
2. Stay inside your assigned directory; you may *read* anything. Root files (`package.json`, `tsconfig.json`) are owned by whoever scaffolds.
3. Determinism everywhere in eval paths: `temperature: 0`, `seed` pinned, stable JSON serialization.
4. Every async entry point must be idempotent / crash-resumable (cron jobs can be killed anytime).
5. TypeScript strict mode. No `any` without justification comment.

## Layout & ownership

```
sin-harness/
  package.json          # scripts only, no deps
  tsconfig.json
  config.json           # baseModel, endpoints, ports, seeds
  core/
    l0.ts               # L0Client: chat(), manifest probe; ModelManifest type
    types.ts            # shared types: Event, SkillArtifact, EvalInstance, GateCert...
    mock.ts             # deterministic mock OpenAI-compatible server (tests)
    sign.ts             # ed25519 sign/verify helpers
  evals/
    templates.ts        # makeTemplate(id, fn) registry; ≥6 real templates
    transforms.ts       # paraphrase, permuteFields, scaleValue, formatShift, hrEn
    properties.ts       # parses / invariantUnderParaphrase / idempotent checks
    score.ts            # deterministic scoring + head-to-head comparison
    generate.ts         # fresh instance sampling from template×transform matrix
  loop/
    events.ts           # SQLite event store (capture API)
    curate.ts           # judge pass over unprocessed events → candidates
    refine.ts           # smallest CRUD edit to knowledge/ + git commit w/ provenance
    gate.ts             # old-vs-new eval, auto-revert on regression, signed cert
  mesh/
    protocol.ts         # message types between coordinator & nodes
    coordinator.ts      # batches instances from seed, redundant-run cross-check
    node.ts             # one logical node process: own shard, own knowledge copy,
                        # serves eval execution against its L0 endpoint
  scripts/
    start-model.sh      # boots llama-server with models/OLMoE…Q8_0.gguf on :8081
  knowledge/            # created at runtime by init (git repo: system.md skills/ memory/)
  data/                 # sqlite event stores per node
  gates/                # signed gate certificates
  test/
    unit.test.ts        # eval engine + transforms + scoring (mock server)
    e2e.test.ts         # THE acceptance test (below)
```

## Key contracts

### L0 (`core/types.ts`)
```ts
interface ModelManifest { name: string; contextLength: number; quantization: string;
  moe: boolean; activeParams?: number; endpoint: string; }
interface L0Client { chat(messages: ChatMsg[], opts?: {seed?: number}): Promise<string>;
  manifest(): Promise<ModelManifest>; }
```
Manifest is derived at runtime from `config.json` + a probe request — never hardcoded per model.

### Mesh simulation
- Coordinator (`mesh/coordinator.ts`) reads `config.json` → spawns N=3 nodes via `Bun.spawn`:
  `bun run mesh/node.ts --id <n> --port <9201+i> --db data/events-<n>.sqlite`.
- Each node points at the same real llama-server endpoint (or mock in unit tests) but holds **its own private shard** and its own knowledge-repo clone.
- Certification run: coordinator generates instances deterministically from `(suiteSeed, version)`; dispatches batches over HTTP; **5% of instances are executed on 3 nodes and must agree** (deterministic scoring ⇒ identical results expected; disagreement = certification failure).
- Churn tolerance: coordinator retries failed dispatches on surviving nodes; killing any one node mid-run must not lose the run.

### Provenance & signing
- Refine commit messages follow: `refine(<type>): <one-liner>` + body lines `trigger: <event-id>` / `evidence: <outcome>`.
- Gate certificates: JSON in `gates/<date>-<sha>.json`, field `signature` = ed25519 over canonical JSON (key generated into `data/keys/` on init).

## E2E acceptance test (`test/e2e.test.ts`) — definition of done

Runs against the **real OLMoE model** (assumes `scripts/start-model.sh` healthy on :8081):

1. Boot 3 simulated nodes + coordinator as separate OS processes.
2. Seed each node with ≥10 synthetic session events (incl. one recurring failure pattern).
3. Run curate→refine on node A: assert a skill/memory artifact exists with provenance commit in git log.
4. Run gate on node A: fresh-sampled instances, old-vs-new comparison, signed certificate written; deliberately inject a regression refinement and assert **auto-revert fires**.
5. Audition: export node A's artifact → audition against node B's private shard → accept/reject decision recorded.
6. Distributed certification: coordinator certifies a suite across all 3 nodes with triple-run cross-check passing.
7. Churn drill: kill node C mid-certification → run still completes via retry.
8. Exit 0 with a summary table printed (per-node pass rates, cert IDs, timings).

`bun test test/e2e.test.ts` green == P0a done. No shortcuts: a skipped step fails the test.
