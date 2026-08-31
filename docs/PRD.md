# PRD: Sovereign Intelligence Network

## Free, self-improving, frontier-class AI on consumer hardware

**Version:** 1.0 · **Author:** Mladen / The Shop · **Date:** 2026-08-07
**Status:** Vision PRD — deliberately spans from shippable core to full dream; each phase is independently valuable

---

## 0. The Dream, Stated Honestly

Frontier-class AI capability, on hardware people already own, that gets better the more it is used, owned by no one and available to everyone — functionally free.

This PRD takes the dream seriously instead of hedging it. Where physics or economics impose a real limit, the limit is named and the design routes around it rather than pretending it away. The core thesis: **intelligence is becoming a commodity; what remains scarce is accumulated knowledge, verification, and trust. Build the scarce parts as a commons; let the commodity part ride the industry's own depreciation curve down to free.**

### Why "free" is not naive
- Base models: open-weight frontier-adjacent models (Qwen3.8-27B class) already run on ~17 GB consumer hardware. Each generation imports frontier gains at zero cost to us. The industry pays the training bill; we absorb the output.
- Compute: the marginal cost of inference on hardware someone already owns (gaming PC, MacBook) is electricity. "Free" means "no new money changes hands," which is achievable for the owner-operator tier.
- Knowledge & verification: text artifacts (skills, eval templates) cost nothing to replicate. The community license keeps personal/noncommercial use and Commercial Use while the Corporate Group's Worldwide Gross Annual Revenue is not more than EUR 1,000,000 free; larger commercial users fund continued work.
- What is NOT free and never will be: novel frontier reasoning (residual API dependency, shrinking each generation), human attention for curation/deployment (monetized), and trust certification at scale (monetized). The business model funds the free tier from the non-free residue — the Red Hat / Linux structure, applied to intelligence.

---

## 1. Problem

1. **Capability is rented, not owned.** Businesses and individuals build workflows on APIs that can reprice, deprecate, or geo-block overnight. Nothing accumulates for the user; everything accumulates for the vendor.
2. **Data leaves the building.** For EU SMEs the frontier-API default is a GDPR liability; for individuals it is a privacy tax paid for capability.
3. **AI doesn't learn your work.** Frontier models are stateless generalists. The 20–30 workflows any person/org actually repeats are exactly where a specialist would win — and no product systematically builds that specialist from usage.
4. **Small models are unreliable alone.** Historical data: Qwen3.6-27B ranks mid-pack overall and near the bottom of its cohort on agentic tasks. Raw local models fail exactly where they're needed most. The gap is closable — but by architecture, not by hoping.
5. **No trust fabric for shared improvements.** Community fine-tunes exist (thousands of LoRAs) but are opaque, unauditable, non-composable, and impossible to evaluate against *your* data before installing. The sharing economy for model improvements is stalled on trust, not supply.

## 2. Product Definition

A five-layer system. Each layer is a product surface; layers ship independently; every layer is designed to survive the death of the layer below it.

**Governing design test (applied to every feature): "Does it survive a base-model swap untouched?" If no → it lives in the disposable layer (L3) and must be regenerable automatically.**

**Proof-of-concept constraint:** the entire loop is first implemented against a **small MoE model ≤ 12B total parameters** (OLMoE-1B-7B-Instruct: 6.9B stored / ~1.3B active, Apache 2.0, fully open incl. training data; fallback/swap-target: IBM Granite-4.0-H-Tiny, 7B A1B). Rationale: a 27B proves nothing about architecture that a 7B-A1B can't prove cheaper and faster — if the harness (L1 refinement + L2 verification + routing) lifts a tiny sparse model measurably on narrow recurring workflows, the same machinery lifts every larger generation. The MoE choice additionally stress-tests the L0 contract on a non-dense architecture. The swap from OLMoE → Granite-4.0-H-Tiny (different vendor, different attention hybrid) doubles as the first live rehearsal of the base-swap procedure.

### L0 — Model Contract *(permanent, published source-available spec)*
- OpenAI-compatible endpoint + capability manifest (context length, tool-calling, modalities, quantization).
- Base model is a config line. Qwen3.6-27B today, Qwen3.8-27B on release, anything in 2027+.
- Swap procedure is a first-class, automated flow: re-baseline evals → re-audition adapters → done.
- **Reasoning:** the base model is the *least* durable component in the entire stack — generations ship every ~4 months and each one obsoletes fine-tunes built on its predecessor. Therefore no value may be stored in it. This inversion is the single most important decision in the PRD: everyone else bets on models; we bet on everything around them.

### L1 — Knowledge Layer *(permanent, free, the compounding asset)*
- Git repository of markdown artifacts: `skills/`, `memory/`, `system.md` (immutable core), each artifact carrying trigger→outcome provenance (which real events motivated it, what result it produced).
- Model-agnostic by construction — text instructs any base. Evidence: Microsoft's SkillOpt showed optimized skill artifacts transfer across model scales and across harnesses (Codex ↔ Claude Code).
- Versioning, rollback, audit = git. Every refinement is one commit; revert-by-SHA; provenance in commit messages. Zero custom infrastructure for the property that took Prime Agent a custom refinement-history system.
- **Reasoning:** this is where "self-improvement" actually lives for the first year. Weight updates are slower, riskier, and disposable; text skills are instant, auditable, reversible, GDPR-inspectable, and survive every model swap. The Prime Agent precedent (Aug 2026) validates this: their entire self-improvement loop (Continual Harness `/refine`) edits prompts/skills/memory — no weights in the loop — with an immutable base prompt and revert-by-ID. Independently, their Factorio result is the cautionary tale baked into our gate design: their refinement loop, once it found an exploit, built *efficient cheating skills* — the improvement loop optimizes whatever it can reach.

### L2 — Verification Layer *(permanent, the moat, freemium)*
Three components, each answering a specific attack discovered in design review:

1. **Eval generator, not eval suite.** ~200 task templates × metamorphic transforms (paraphrase, translation HR↔EN, field permutation, value scaling, format shifts) + property-based checks (parses, invariant under paraphrase, idempotent). Every version bump samples a *fresh* ~5k instance set.
   *Attack this kills:* Goodhart. A fixed suite becomes the training target — for honest adapters and adversaries alike. You cannot overfit a distribution you never see twice. Frozen in design, moving in instances.
2. **Private per-node shards.** Every node auto-builds ~50 eval tasks from its *own real data*. Shards never leave the machine (GDPR-clean by construction). Foreign contributions are admitted by **local audition** — overnight trial against the private shard; activate only if it beats the incumbent *on your data*.
   *Attack this kills:* the transfer problem. Predicting whether a foreign adapter fits your distribution is genuinely unsolvable by cheap classifiers (topic match ≠ distribution match; the deciding information isn't in the query). Audition doesn't predict — it measures. The unsolvable prediction problem is deleted, not solved.
3. **Behavioral-diff certificates.** New version vs old, probed broadly *outside* the claimed domain; large off-domain drift = automatic reject. Certificate ships with every artifact.
   *Attack this mitigates:* sleeper triggers in shared weights. A trigger's existence perturbs the function somewhere; broad statistical sampling catches what fixed probes structurally cannot. Reduces poisoning to statistical improbability — never zero, same as all software supply-chain security; signed data provenance closes the rest to industry-standard.

- **Reasoning:** classifiers are cheap because they interpolate over labeled experience; every hard problem here lives exactly where labeled experience doesn't exist (novel inputs, unseen combinations, adversaries choosing the blind spot). Therefore: **classifiers narrow the field cheaply (routing to workflow family, PII gating, telemetry tagging); deterministic verification decides.** Anything that changes weights or executes irreversibly is gated by the expensive dumb thing — because it's the only component whose failure modes don't move with the attacker or the distribution. The gate itself never learns.

### L3 — Weight Layer *(disposable by design, free tooling)*
- LoRA adapters. One active per request (composition via merging is unsolved — interference is weight arithmetic, not a decision problem; we sidestep, not solve).
- Admitted only via L2 audition. Discarded at base swap and **regenerated**: L1 skills + logged trajectories are the recipe; retraining against a new base is an automated overnight job (QLoRA, ~40–60 GB, fits 128 GB unified memory; MLX/Unsloth).
- Trained only when a pattern *saturates* in L1 — appears 20+ times over weeks and text-level skills demonstrably don't fix it. Evidence-driven graduation, never scheduled training.
- **Reasoning:** adapters are cache, not state. This dissolves the depreciation problem: base models improving is no longer a threat to accumulated value — it's a free upgrade absorbed on swap day. Also dissolves the training-data-scarcity problem: one node's daily signal (~50–200k useful tokens) is too thin for nightly weight training anyway; saturation-triggered weekly-at-most training matches the actual data supply. Training data is distilled/corrected samples (stronger-model rewrite of lessons), never raw self-outputs — the anti-collapse measure.

### L4 — Mesh & Commons *(the "for the masses" layer, phased)*
- **Community source:** skill packs, eval templates, adapter *recipes* (not weights — recipes: data specs + training configs that each node executes locally). Text artifacts are auditable and replicable at zero cost. Personal/noncommercial use and Commercial Use while the Corporate Group's Worldwide Gross Annual Revenue is not more than EUR 1,000,000 are free under the Swarmlet Community License.
- **Mesh compute:** nodes contribute idle GPU cycles for (a) serving the common base to thin clients (phones, old laptops — the masses who own *no* capable hardware), (b) distributed eval certification — embarrassingly parallel, churn-tolerant, verified by redundant execution (5% of tasks triple-run and cross-checked). Directly reuses the skeleton/expert churn-immune architecture from the GPU-mesh work; eval traffic is an even better mesh workload than inference (no latency SLA, perfect parallelism).
- **Aggregated audition telemetry:** only pass-rate statistics leave nodes, never data. Produces honest transferability scores nobody — including authors — can game, because no one knows the shard contents.
- **Reasoning:** distribution "to the world" fails as weights (incompatible LoRAs pile) and succeeds as knowledge + verification. The durable shared asset is the skill/eval layer; weights stay personal and regenerable. Cold-start is solved by sequencing (see §5): the mesh is *last*, funded and seeded by earlier phases, never a prerequisite.

### The Loop (per node, fully offline-capable)
```
capture (session events, corrections, retries, outcome signals)
  → every 3h: curate (local-model judge: signal/noise/PII/skill-candidate)
  → refine (smallest CRUD edit to L1; git commit with provenance)
  → nightly: gate (fresh-sampled evals; deterministic scoring; revert on regression)
  → on saturation: adapter retrain (L3) → audition → activate
  → optionally: publish passing artifacts to commons (L4)
```
Two-tier promotion: memories pass a fast smoke suite (minutes, same-day activation); skills and subagent specs wait for the nightly full gate. Near-real-time where safe, gated where not.

## 3. Capability Claims — Calibrated, Not Hyped

| Claim | Verdict | Basis |
|---|---|---|
| Frontier-level on general benchmarks, single node | **No, ever, this hardware class** | ~100× compute gap is not closable by harness; anyone claiming otherwise is selling something |
| Frontier-level on a node's own recurring, verifiable workflows | **Yes, ~2–3 months of loop runtime** | Ramp precedent (small RL model beat frontier on their workflow); SWE-agent literature: verification + best-of-n worth +10–20pp on checkable tasks; specialist depth beats generalist breadth on narrow distributions |
| Frontier-level aggregate coverage across the network | **Plausible, years** | Collective L1+L2 compounds monotonically; base swaps import each generation's gains free; economically valuable work is concentrated in repeated verifiable workflows |
| Open-ended novel reasoning | **Residual API dependency, shrinking per generation** | Routed automatically via the unreliable-tier check (no definable verification → escalate); the architecture absorbs the shrinkage without redesign |

Reliability mechanics on consumer hardware (M5 Max 128 GB reference node): Q8 quant (precision over the unneeded Q4 savings), 32K context cap (harness retrieval beats mushy long context for precision; prompt processing is the Apple Silicon bottleneck), speculative decoding via 4B draft (~1.5–1.8× on structured output), best-of-3 + deterministic verifier on precision-critical paths, verification-first agenting (task must define its check upfront or gets escalated). Budget: ~50 GB used, ~78 GB headroom — QLoRA training and serving coexist.

## 4. Monetization — Funding "Free" Honestly

The community tier is real and load-bearing, not a trial. Revenue comes from larger commercial users and the layers where human attention and trust certification are irreducibly scarce. Structure: source available with a small-business commercial grant.

| Tier | What | Who pays | Price anchor |
|---|---|---|---|
| **Community source** | Harness, loop, eval generator, skill packs, recipes — source available | Individuals, noncommercial users, and Corporate Groups with Worldwide Gross Annual Revenue ≤EUR 1,000,000 | €0 within licence |
| **Sovereign Deployment** | Turnkey install on customer hardware; week-one private eval shard built from their real workflows; monthly invoice ships the score trend | EU SMEs (data can't leave; ownership resonates) | €5–15k setup + €300–500/mo |
| **Harness License** | Deployment playbook + supported build for other agencies to deliver | EU agencies (distributed *sales*, not distributed compute — they own customer relationships we lack) | per-deployment fee |
| **Certification** | Mesh-run eval certification for commons artifacts; transferability scores | Artifact publishers, enterprises consuming commons | usage-based |
| **Escalation routing** | Managed frontier-API fallback for the unreliable tier, EU-resident | Deployments wanting one bill | margin on passthrough |

**The sales artifact is the eval shard.** "Self-improving" is unfalsifiable at sale time — so make it contractual: the customer watches their private benchmark number monthly. Proof, retention, and upsell in one artifact. Nobody sells this; everyone sells demos.

**Reasoning behind the model:** roast-tested against — (a) *no named customer* → launch tier reuses the existing 140-prospect Croatian B2B motion, same buyers, bigger ticket; (b) *services don't scale* → agency deals fund the harness; the harness becomes the licensed product; license path is the scale story; (c) *GDPR fear doesn't sell* → lead with ownership ("AI that knows your business, gets better, and no vendor can take away or reprice"), compliance is the closer not the opener; (d) *frontier price collapse kills "cheap local"* → ownership and residency arguments survive price collapse; cost is never the lead argument; (e) *bakery problem* → deployment playbook is written during the first five deployments and *is* the license product. Honest ceiling of the business layer: €200k–500k/yr harness+services with license upside — the *commons* is the world-scale part, the *business* is the sustainable-family-in-Slavonia part, and conflating the two ambitions was the original error this PRD separates.

## 5. Phasing — Every Phase Independently Valuable

**P0a (PoC, before P0):** full loop on one box against the ≤12B MoE class (see Proof-of-concept constraint above), plus **distributed compute simulated locally e2e**: ≥3 logical nodes + coordinator as separate OS processes on the reference machine, exercising capture→curate→refine→gate, audition of an artifact trained/mocked on node A against node B's private shard, and redundant-execution eval certification (5% triple-run cross-check). **Gate rule: no distributed-compute claim may be made externally until this local e2e simulation passes** — the simulation is the acceptance test for all mesh code paths; P4 changes topology, not logic.
**P0 (this week, one box):** L0+L1+loop at production size. llama.cpp + Qwen3.6-27B Q8, git repo, `refine.ts` + `gate.ts` (~300 lines TS, three cron schedules). Baseline the eval suite *before* Qwen3.8-27B drops → swap day yields a clean self-measured generational comparison worth more than any launch benchmark. **License check on the 3.8 model card before client work — none named as of writing; prior Qwen patterns are not a compliance plan.**
**P1 (weeks 2–6):** L2 generator + first private shard from The Shop's own workflows. Dogfood: The Shop is customer zero; the agency's own recurring work (MCP delivery, proposals, Croatian legal research) is the first specialist.
**P2 (months 2–4):** First 3 Sovereign Deployments from the existing prospect list. Playbook written en route. Score-trend invoicing live.
**P3 (months 4–9):** Harness hardened → license pilot with 1–2 friendly agencies. Commons repo public (skills + eval templates from anonymized patterns).
**P4 (month 9+, gated on P2–P3 revenue):** Mesh: eval certification first (best-fit workload), thin-client serving second. Reuses the GPU-mesh architecture already designed. **Explicit gate: revenue, not architecture, justifies this phase.**

## 6. Risks & Kill Criteria

| Risk | Mitigation | Kill signal |
|---|---|---|
| Self-training collapse (loop echoes its own biases) | Distilled/corrected training data only; frozen deterministic gate outside the loop; Factorio lesson institutionalized | Eval trend flat/declining 3 consecutive gates → freeze refine, audit |
| Qwen 3.8 license restricts EU | L0 swapability is the mitigation *by design*; fall back Qwen3.6 (Apache 2.0) | — (designed around) |
| Adapter poisoning at commons scale | Audition + behavioral-diff + signed provenance; weights never shared, only recipes | Confirmed exploit passing audition → recipes-only mode |
| Frontier price collapse erodes "local" pitch | Ownership/residency lead the pitch, not cost | Cost was never the argument |
| Key-person bottleneck (first deployments) | Playbook-as-you-go = the license product | >5 deployments still requiring founder → license path failed, stay boutique |
| No one wants it | P2 is 3 customers from a warm list of 140 in 90 days | Can't close 3 → the market said no; source-available community project continues, business pivots |
| Signal scarcity (one node's data too thin) | Saturation-triggered training; weekly-at-most cadence; L1 does the fast learning | — (designed around) |
| Mesh code untested at scale until P4 | Local multi-process simulation is a P0a exit criterion; P4 swaps topology only | Simulation can't pass e2e → mesh stays design-only |

## 7. What This PRD Refuses To Pretend

- A 27B will not match a 2.4T model on arbitrary tasks. The product wins by making that comparison irrelevant for 90% of real usage and routing the 10% honestly.
- Adapter composition is unsolved. We sidestep (one-active), we don't solve.
- Poisoning risk asymptotes to software-supply-chain levels, not zero.
- The mesh at world scale needs network effects no PRD conjures. It is sequenced last, funded by the parts that don't need them, and the commons delivers "free AI for the masses" *before* the mesh exists — via artifacts anyone can run on their own machine today.
- The last 1% is execution, which no document de-risks.

**One-sentence thesis: own the knowledge and the verification, rent the intelligence, give away the recipe — and make all of it survive the thing everyone else is betting on.**
