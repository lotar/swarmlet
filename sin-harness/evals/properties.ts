// evals/properties.ts — property-based checks (L2).
// Properties are independent of gold answers: they hold for ANY correct
// implementation, which is what makes them useful against distributions
// nobody labeled in advance.

import type { ChatMsg, EvalInstance, L0Client } from "../core/types.ts";
import { evaluateInstance } from "./score.ts";
import { getTemplate } from "./templates.ts";
import { paraphrase } from "./transforms.ts";
import { extractJson } from "./templates.ts";

export interface PropertyReport {
  property: string;
  passed: boolean;
  detail: string;
}

/** P1: the output parses as a JSON object (our uniform response envelope). */
export function parses(inst: EvalInstance, output: string): PropertyReport {
  void inst;
  const parsed = extractJson(output);
  return {
    property: "parses",
    passed: parsed !== undefined,
    detail: parsed ? "output is a JSON object" : "output is not parseable JSON",
  };
}

/** P2: identical request twice (temp=0, pinned seed) yields byte-identical output. */
export async function idempotent(
  l0: L0Client,
  inst: EvalInstance,
): Promise<PropertyReport> {
  const msgs: ChatMsg[] = [{ role: "user", content: inst.prompt }];
  let a: string;
  let b: string;
  try {
    [a, b] = await Promise.all([
      l0.chat(msgs, { seed: inst.seed }),
      l0.chat(msgs, { seed: inst.seed }),
    ]);
  } catch (e) {
    return {
      property: "idempotent",
      passed: false,
      detail: `chat failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return {
    property: "idempotent",
    passed: a === b,
    detail: a === b ? "outputs identical" : "outputs diverged under fixed seed",
  };
}

/**
 * P3: pass/fail verdict is invariant under paraphrase of the prompt.
 * Uses the instance's own checker on both variants — no gold answer needed
 * beyond what construction already embedded.
 */
export async function invariantUnderParaphrase(
  l0: L0Client,
  inst: EvalInstance,
): Promise<PropertyReport> {
  try {
    const base = await evaluateInstance(l0, inst);
    const variant = await paraphrase(inst, l0, inst.seed ^ 0x5eed);
    const para = await evaluateInstance(l0, variant);
    return {
      property: "invariantUnderParaphrase",
      passed: base.passed === para.passed,
      detail:
        `base=${base.passed} paraphrased=${para.passed}` +
        (base.passed === para.passed ? "" : " — checker is prompt-brittle"),
    };
  } catch (e) {
    return {
      property: "invariantUnderParaphrase",
      passed: false,
      detail: `failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Run the full property battery for one instance against one endpoint. */
export async function runProperties(
  l0: L0Client,
  inst: EvalInstance,
): Promise<PropertyReport[]> {
  const tpl = getTemplate(inst.templateId);
  let output = "";
  try {
    output = await l0.chat([{ role: "user", content: inst.prompt }], {
      seed: inst.seed,
    });
  } catch {
    output = ""; // parses() will report the failure honestly
  }
  void tpl;
  const p1 = parses(inst, output);
  const p2 = await idempotent(l0, inst);
  const p3 = await invariantUnderParaphrase(l0, inst);
  return [p1, p2, p3];
}
