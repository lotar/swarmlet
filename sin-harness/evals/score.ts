// evals/score.ts — deterministic scoring + head-to-head gate comparison.
// Scoring is a pure function of (output, instance) via the template's
// checker; sampling is pinned (temperature=0, seed=instance seed). Identical
// inputs therefore yield identical scores — the property the mesh's
// redundant-execution cross-check depends on.

import type { ChatMsg, EvalInstance, EvalResult, L0Client } from "../core/types.ts";
import { getTemplate } from "./templates.ts";

/** Evaluate one instance against one endpoint. Never throws: endpoint or
 * checker failures score 0 with the error recorded in output. */
export async function evaluateInstance(
  l0: L0Client,
  inst: EvalInstance,
  opts: { systemPrompt?: string } = {},
): Promise<EvalResult> {
  const t0 = performance.now();
  let output = "";
  try {
    const msgs: ChatMsg[] = [];
    if (opts.systemPrompt) msgs.push({ role: "system", content: opts.systemPrompt });
    msgs.push({ role: "user", content: inst.prompt });
    output = await l0.chat(msgs, {
      seed: inst.seed,
      // Verification determinism: no shared prompt-cache state (see ChatOptions).
      cachePrompt: false,
    });
  } catch (e) {
    output = `__ERROR__: ${e instanceof Error ? e.message : String(e)}`;
  }
  const tpl = getTemplate(inst.templateId);
  let passed = false;
  let score = 0;
  try {
    const outcome = tpl.check(output, inst);
    passed = outcome.passed;
    score = Math.max(0, Math.min(1, outcome.score));
  } catch {
    passed = false;
    score = 0;
  }
  return {
    instanceId: inst.id,
    output,
    passed,
    score,
    durationMs: Math.round(performance.now() - t0),
  };
}

export interface SuiteRun {
  results: EvalResult[];
  /** Mean of per-instance scores in [0,1]. */
  passRate: number;
}

export async function runSuite(
  l0: L0Client,
  instances: readonly EvalInstance[],
  opts: { systemPrompt?: string; concurrency?: number } = {},
): Promise<SuiteRun> {
  const limit = Math.max(1, opts.concurrency ?? 4);
  const results: EvalResult[] = new Array(instances.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, instances.length) }, () =>
    (async () => {
      while (true) {
        const i = next++;
        if (i >= instances.length) return;
        const inst = instances[i];
        if (!inst) return;
        results[i] = await evaluateInstance(l0, inst, opts);
      }
    })(),
  );
  await Promise.all(workers);
  const passRate =
    instances.length === 0
      ? 0
      : results.reduce((acc, r) => acc + r.score, 0) / instances.length;
  return { results, passRate };
}

export interface HeadToHeadResult {
  oldScore: number;
  newScore: number;
  delta: number;
  /** Noise-aware decision margin actually applied (max of caller tolerance
   * and the binomial sampling bound). Persisted on certs for auditability. */
  margin: number;
  decision: "accept" | "keep" | "revert";
  oldResults: EvalResult[];
  newResults: EvalResult[];
}

/**
 * Old-vs-new comparison over the SAME freshly-sampled instances — the only
 * honest way to attribute a delta to the knowledge change under test.
 * `tolerance` allows accepting noise-level regressions (default: strict 0).
 */
export async function headToHead(
  l0: L0Client,
  instances: readonly EvalInstance[],
  opts: {
    oldSystem: string;
    newSystem: string;
    tolerance?: number;
    concurrency?: number;
  },
): Promise<HeadToHeadResult> {
  const [oldRun, newRun] = await Promise.all([
    runSuite(l0, instances, { systemPrompt: opts.oldSystem, concurrency: opts.concurrency }),
    runSuite(l0, instances, { systemPrompt: opts.newSystem, concurrency: opts.concurrency }),
  ]);
  // Pair by instanceId so partial-credit deltas are attributable per instance.
  const n = Math.max(1, instances.length);
  const oldById = new Map(oldRun.results.map((r) => [r.instanceId, r]));
  const pairedDelta =
    newRun.results.reduce((acc, r) => {
      const o = oldById.get(r.instanceId);
      return acc + (o ? r.score - o.score : 0);
    }, 0) / n;
  // Noise-aware margin: one flipped instance on a small suite must never be
  // misclassified as a regression (or an improvement). Margin = max(explicit
  // tolerance, one-sided ~95% binomial bound on the mean-difference estimate).
  // Clamping p away from 0/1 keeps exact-delta stub scenarios decisive.
  const pVar = (p: number) => {
    const q = Math.min(Math.max(p, 0.02), 0.98);
    return q * (1 - q);
  };
  const tolerance = opts.tolerance ?? 0;
  const margin = Math.max(
    tolerance,
    1.645 *
      Math.sqrt((pVar(oldRun.passRate) + pVar(newRun.passRate)) / n),
  );
  // Conservative three-way rule: only a beyond-noise REGRESSION reverts;
  // ties keep the incumbent (never silently promoted, never destroyed).
  const decision: "accept" | "keep" | "revert" =
    pairedDelta >= margin ? "accept" : pairedDelta <= -margin ? "revert" : "keep";
  return {
    oldScore: oldRun.passRate,
    newScore: newRun.passRate,
    delta: pairedDelta,
    margin,
    decision,
    oldResults: oldRun.results,
    newResults: newRun.results,
  };
}
