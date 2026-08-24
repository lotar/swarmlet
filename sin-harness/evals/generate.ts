// evals/generate.ts — fresh instance sampling (L2 anti-Goodhart core).
// The suite is a FUNCTION of (suiteSeed, version): every gate/version bump
// samples instances never seen before, so overfitting a fixed suite is
// structurally impossible. Pure transforms only — no network access needed.

import { fnv1a, mulberry32 } from "../core/mock.ts";
import type { EvalInstance } from "../core/types.ts";
import { getTemplate, listTemplates } from "./templates.ts";
import { applyPureTransform, PURE_TRANSFORM_IDS } from "./transforms.ts";

/** Transform choices per slot; "identity" leaves the base instance intact. */
const CHOICES = [...PURE_TRANSFORM_IDS, "identity", "identity"] as const;

/**
 * Deterministically sample `count` fresh instances.
 * Same (suiteSeed, version, count) => byte-identical list, forever.
 * Different `version` => a disjoint-feeling fresh set (new RNG stream).
 */
export function generateSuite(
  suiteSeed: number,
  version: string,
  count: number,
): EvalInstance[] {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`count must be a positive integer, got ${count}`);
  }
  const rand = mulberry32(fnv1a(`${suiteSeed}:${version}`));
  const templateIds = listTemplates().map((t) => t.id);
  const out: EvalInstance[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const tplId = templateIds[Math.floor(rand() * templateIds.length)] as string;
    const seed = Math.floor(rand() * 2 ** 31);
    let inst = getTemplate(tplId).makeInstance(seed);
    const choiceIdx = Math.floor(rand() * CHOICES.length);
    const choice = CHOICES[choiceIdx] as string;
    if (choice !== "identity") {
      inst = applyPureTransform(choice, inst, seed ^ (i + 1));
    }
    while (seen.has(inst.id)) {
      // Collision across slots (same template+seed drawn twice): rebase id,
      // content stays valid because it is still a fully-formed instance.
      inst = { ...inst, id: `${inst.id}#${i}` };
    }
    seen.add(inst.id);
    out.push(inst);
  }
  return out;
}
