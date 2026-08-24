# Implementation Plan — Sovereign Intelligence Network

Companion to [PRD.md](./PRD.md). Covers stack, architecture, build sequence per PRD phase (P0–P4), and deep-dives on **security** and **speed** — the two properties that are load-bearing rather than incidental.

---

## 1. Stack Overview

| Concern | Choice | Why |
|---|---|---|
| Inference server | **llama.cpp `llama-server`** | OpenAI-compatible HTTP API out of the box (= L0 contract), GGUF Q8 quant support, prompt-cache persistence, speculative decoding via `--model-draft`, Metal backend on Apple Silicon, runs headless as a daemon |
| Harness / loop language | **TypeScript on Bun** (fallback: Node 22) | Single language for cron jobs, eval generator, git plumbing (`simple-git`), OpenAI-compatible clients; instant startup matters for frequent short cron invocations; types = the L0/L1 schemas stay honest |
| Knowledge store (L1) | **Plain git repo of markdown** + JSON frontmatter | The PRD's core bet: versioning/rollback/audit/blame come free from git; no DB to migrate; human-inspectable for GDPR (Art. 15 right of access becomes `git show`) |
| Event store | **SQLite (WAL mode)**, one file per node | Append-only capture stream; single-file backup/restore fits the Sovereign Deployment story; no server process; queryable with plain SQL |
| Eval execution | Same llama-server endpoint, deterministic sampling (temp=0, seed pinned) | The gate must be reproducible; same engine as production means no train/test skew between harness and serving |
| Fine-tuning (L3) | **MLX-LM LoRA** on Apple Silicon; **Unsloth QLoRA** on CUDA nodes | Both target consumer unified-memory / gaming GPUs; overnight job budget 40–60 GB; adapters exported back to GGUF for llama-server |
| Scheduler | **launchd** (macOS) / **systemd timers** (Linux) — not a resident scheduler process | Three schedules in P0 (3h curate, nightly gate, weekly train); OS-native = survives reboots, no orphan daemons, trivially auditable |
| Signing | **minisign / ed25519** via a thin TS wrapper | Artifact provenance signatures; dead-simple key story for customers |
| Packaging | Single OSS repo (`sin-harness`), pnpm workspace: `core/`, `evals/`, `loop/`, `cli/` | Commons-first licensing (Apache-2.0) matches the monetization table |
| Escalation tier | Thin OpenAI/Anthropic client behind the same L0 interface, EU-resident proxy only | Frontier fallback is a config line, never an architectural dependency |

### Repo layout

```
sin-harness/
  cli/            # sin init | capture | refine | gate | audition | swap-base
  loop/
    curate.ts     # every 3h: event triage → skill candidates → PII gate
    refine.ts     # smallest CRUD edit to L1 + git commit w/ provenance
    gate.ts       # nightly: fresh-sampled evals, deterministic scoring
    graduate.ts   # saturation detector → triggers adapter recipe
  evals/
    templates/    # ~200 task templates (TS functions, not data files)
    transforms/   # metamorphic: paraphrase, HR↔EN, permute, rescale
    properties/   # parses / invariant-under-paraphrase / idempotent
    shard.ts      # builds private per-node shards from real usage logs
    diffcert.ts   # behavioral-diff certificate generator
  core/
    l0.ts         # capability manifest probe + OpenAI-compat client
    routing.ts    # verifier-first router; escalation tier check
  knowledge/      # the L1 repo itself (skills/ memory/ system.md)
```

---

## 2. Build Sequence (mapped to PRD phases)

### P0 — one box, this week (L0 + L1 + loop)

Goal: the loop runs end-to-end offline on the M5 Max reference node, and a baseline is recorded before any base-model swap.

1. **Day 1–2: L0.**
   - Download Qwen3.6-27B **Q8_0** GGUF (~29 GB); run `llama-server` with `--ctx-size 32768 --cache-reuse 256`, draft model 4B for speculation.
   - Implement `l0.ts`: probe `/v1/models` + a manifest file (`context_length`, `tool_calling`, `quantization`, `modalities`). Base model lives in `config.toml` — swapping = editing one line.
2. **Day 2–3: L1 skeleton.**
   - `knowledge/` git repo initialized with immutable `system.md` (committed once, then branch-protected by convention: gate refuses edits), empty `skills/`, `memory/`.
   - Commit message schema enforced by `refine.ts`: `refine(<type>): <one-liner>\n\ntrigger: <event-id>…\nevidence: <outcome-signal>…`. Provenance is grep-able forever.
3. **Day 3–5: capture + curate.**
   - All agent sessions log events to SQLite: user corrections, retries, tool failures, outcome signals. Schema: `(id, ts, session, kind, payload, pii_flagged)`.
   - `curate.ts` (every 3h): local-model judge classifies each unprocessed event signal/noise, flags PII (regex + NER pass; anything flagged never reaches L1 prose), extracts skill candidates ("this failure recurred because X").
4. **Day 5–7: refine + gate.**
   - `refine.ts`: applies the *smallest* CRUD edit (PRD rule) to one markdown artifact, commits with provenance. Memories promote same-day after smoke suite; skills wait for nightly gate.
   - `gate.ts` (nightly): sample fresh eval instances, run old-vs-new head-to-head at temp=0, deterministic scoring, auto `git revert` on regression. Write gate result as a signed certificate into `gates/YYYY-MM-DD.json`.
5. **Baseline:** run the full suite against stock Qwen3.6-27B and freeze the numbers. This is the generational-swap comparison artifact.

**Acceptance:** loop runs ≥3 days unattended with zero manual git ops; gate demonstrably reverts one deliberately-bad refinement.

### P1 — weeks 2–6 (L2)

1. Build the first ~50 task templates from The Shop's real recurring work (MCP delivery, proposals, Croatian legal research). Templates are code: `makeInstance(seed)` — instances regenerate forever, the template is frozen.
2. Metamorphic transforms: paraphrase (local model, temp>0, verified round-trip), HR↔EN translation, field permutation, value scaling. Property checks run post-hoc: output parses, paraphrase-invariance within tolerance, idempotency where claimed.
3. `shard.ts`: mine ~50 tasks from The Shop's actual session history → private shard v1. This artifact is also the sales demo.
4. Wire the gate onto generated instances only (never frozen files) — Goodhart-proofing is structural, not procedural.

**Acceptance:** two consecutive nights sample disjoint instance sets; a poisoned/refinement-targeted skill passes the fixed-suite check but fails the fresh-instance gate (red-team drill).

### P2 — months 2–4 (first Sovereign Deployments)

1. Package installer: one script → brew/apt deps, llama-server launchd unit, `sin init`, encrypted-at-rest SQLite, customer-held signing keys.
2. Week-one shard-building workshop (the playbook chapter written during deployment #1).
3. Monthly report generator: score trend from gate certificates → invoice attachment. No data leaves the machine except the scores.
4. Escalation routing live: EU-resident proxy, per-customer API keys, spend caps.

**Acceptance:** deployment #2 requires zero founder involvement beyond the playbook (kill-criterion tracking starts here).

### P3 — months 4–9 (hardening + license pilot + commons)

- Multi-node soak: crash-only design (any cron job can be killed mid-run; idempotent, resumable), atomic writes everywhere.
- Public commons repo: anonymized skill packs + eval templates, Apache-2.0, signed releases.
- License pilot kit: playbook + supported build.

### P4 — month 9+ (mesh, revenue-gated)

- Eval-certification mesh first: coordinator issues instance batches (generated deterministically from published seeds), nodes execute, 5% triple-run redundancy with cross-check, results signed per node. Churn-tolerant by design — no node state, no latency SLA.
- Thin-client serving second: idle nodes serve the commons base over authenticated QUIC/WebSocket; capacity follows churn models from the GPU-mesh design.

---

## 3. Security Deep-Dive

The security posture follows directly from the PRD's L2 reasoning: **classifiers narrow cheaply, deterministic verification decides, and nothing that learns ever holds authority.**

### Threat model

| Threat | Vector | Control |
|---|---|---|
| Goodhart / reward hacking | Refinement loop optimizes toward a fixed eval set | Fresh-sampled instances every gate; templates frozen, instances never reused; property-based checks independent of gold answers |
| Loop self-poisoning (Factorio lesson) | Refine finds exploits instead of improvements | Gate sits *outside* the loop, deterministic, never trained; regression → automatic revert; 3 flat/declining gates → refine freezes pending audit (PRD kill criterion, implemented in `gate.ts` exit codes) |
| PII leakage into shared artifacts | Curated memories contain customer data | Two-stage filter (deterministic regex + local-NER) at curate time; flagged events never enter L1; publish step re-scans and refuses unflagged residue; shards never leave machine by construction |
| Sleeper-trigger adapters | Poisoned weights behave until triggered | Behavioral-diff certificates: broad off-domain probing vs incumbent; drift over threshold = reject. Plus: commons shares **recipes, not weights** — each node trains locally from its own distilled data, so there is nothing foreign to inject |
| Supply-chain tampering of skills/templates | Malicious commit to commons pack | ed25519-signed releases; nodes verify signature before audition; provenance chain (trigger→outcome event IDs) must resolve locally or the artifact is quarantined |
| Prompt injection via captured content | Session events carry untrusted text into refine prompts | Events are treated as data, never instructions: curate/judge prompts wrap payloads in delimited, instruction-stripped blocks; refinements propose diffs, never execute content |
| Escalation-tier leakage | Unverifiable tasks ship sensitive context to frontier APIs | Routing policy: PII-gated contexts never escalate (fail closed, ask human); EU-resident proxy; per-customer spend caps; full audit log of what was sent |
| Local attack surface | Everything runs on the owner's box | llama-server bound to localhost/UNIX socket; SQLite + git dir 0600; FileVault/LUKS required at install; no inbound network services in P0–P3 |

### Structural rules (enforced in code, not docs)

1. `system.md` is immutable after `sin init`; the gate treats any diff as a hard failure.
2. Only `gate.ts` may write activation decisions; it is stateless w.r.t. the loop (reads artifacts, writes certificates, cannot be called from refine paths).
3. Every weight-changing action requires a fresh audition certificate < 24h old.
4. All outbound telemetry is limited to pass-rate statistics — enforced by a single egress module everything else must route through; unit test asserts no other module imports network libs.

Residual risk is stated honestly in the PRD: poisoning asymptotes to software-supply-chain levels, not zero. Signed provenance + recipes-not-weights + local audition reduce it to the same risk class as installing any open-source dependency.

---

## 4. Speed & Performance Engineering

Reference node: M5 Max 128 GB. Budget from PRD: ~50 GB resident, ~78 GB headroom so training and serving coexist.

### Memory layout

| Component | Resident |
|---|---|
| Qwen3.6-27B Q8_0 (~29 GB) + KV cache @32K | ~34 GB |
| 4B draft model (speculation) | ~4 GB |
| Judge/curation uses the *same* loaded main model (no second resident model) | 0 |
| Headroom for QLoRA training burst | ~78 GB |

One model serves chat, curation judging, and eval execution — loading a second 27B would halve the training headroom for zero quality gain.

### Latency tactics

1. **32K hard context cap.** On Apple Silicon, prompt processing (prefill) is the bottleneck, not generation. Long-context mush is replaced by harness retrieval (grep/embedding over L1) — smaller prompts are faster *and* more precise. Retrieval beats mush twice.
2. **Prompt cache reuse** (`--cache-reuse`): recurring prefixes — `system.md`, active skill block, few-shot scaffolding — persist across requests. For the repeated workflows this product targets, prefix hit rates should exceed 80%, cutting prefill cost proportionally.
3. **Speculative decoding** with the 4B draft: ~1.5–1.8× on structured outputs (JSON, tool calls, eval answers) where acceptance rates are high. Free latency; costs only the 4 GB resident slot.
4. **Best-of-3 only on precision-critical paths**, gated by the router: verification-defined tasks get n=3 + deterministic checker (+10–20pp on checkable tasks per SWE-agent literature); everything else gets n=1. The expensive path is earned, not default.
5. **Eval throughput:** nightly gate ≈ 5k instances × ~500 tokens ≈ embarrassingly parallel across batched `llama-server` requests; overnight window is hours-wide, so throughput tuning is unnecessary — determinism (temp=0, seed) matters more than speed there.
6. **Cron jobs are cold-start-tolerant:** Bun's startup (~20 ms) + a health-check ping to the running server; curate/gate never boot a model themselves.

### Training-window coexistence

QLoRA runs overnight *concurrent* with serving: 40–60 GB fits inside the 78 GB headroom; MLX pager degrades gracefully if both spike. If contention occurs, gate > training priority always — verification is the moat, training is disposable cache regeneration.

---

## 5. Testing Strategy

- **Gate tests the product**: every nightly gate result is itself a regression test for the whole harness; CI replays last night's certificates against the refactor under review.
- **Metamorphic self-tests**: transforms have known-answer tests (paraphrase preserves label; permutation preserves invariant).
- **Red-team drills** (P1+): scripted Goodhart attempt, injected sleeper skill, PII-bearing event — each must be caught by its named control; drill outcomes recorded as gate certificates.
- **Crash-only chaos**: kill every cron job at random offsets in staging; loop must converge to identical state (idempotency invariant).
- **Swap-day rehearsal**: quarterly, swap base to a different quant/family, run automated re-baseline → audition pipeline end-to-end. The procedure is a product; it gets tested like one.

---

## 6. First Sprint Checklist (P0, concretely)

- [ ] `brew install llama.cpp`, fetch Qwen3.6-27B Q8_0 + 4B draft GGUFs, launchd units for `llama-server`
- [ ] `pnpm` workspace scaffold; `config.toml` with model line; `l0.ts` manifest probe
- [ ] SQLite event schema + session-capture hook wired into daily agent use
- [ ] `curate.ts` + judge prompts + PII filter
- [ ] `refine.ts` with enforced commit-message provenance schema
- [ ] 10 seed task templates from The Shop's real work + 3 metamorphic transforms
- [ ] `gate.ts` with fresh sampling, deterministic scoring, auto-revert, signed certificates
- [ ] launchd timers: `curate` (3h), `gate` (03:00), `train` (weekly, disabled until saturation logic exists)
- [ ] Baseline run recorded → `gates/baseline-qwen36-q8.json` — **do this before Qwen3.8 ships**

~300 lines of TypeScript across `refine.ts` + `gate.ts` remains the honest size estimate; everything else is glue, prompts, and git.
