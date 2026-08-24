// evals/transforms.ts — metamorphic transforms (L2).
// Frozen in design, applied with fresh seeds: every gate samples a new set of
// transformed instances, so the suite is never seen twice (anti-Goodhart).
//
// Determinism contract: every transform is a pure function of
// (instance, seed) — except `paraphrase`, which is deterministic given an
// L0 endpoint honoring temperature=0 + pinned seed.

import { fnv1a, mulberry32 } from "../core/mock.ts";
import { canonicalize } from "../core/sign.ts";
import type { EvalInstance, L0Client } from "../core/types.ts";
import { isObj } from "./templates.ts";

/** Transforms that need no model access (safe inside generateSuite). */
export const PURE_TRANSFORM_IDS = [
  "permuteFields",
  "scaleValue",
  "formatShift",
  "hrEnPair",
] as const;

export type PureTransformId = (typeof PURE_TRANSFORM_IDS)[number];

function rebase(
  inst: EvalInstance,
  transformId: string,
  seed: number,
  patch: Partial<EvalInstance>,
): EvalInstance {
  return {
    ...inst,
    ...patch,
    id: `${inst.id}@${transformId}${seed % 9973}`,
    transformId,
  };
}

// ---------- paraphrase (L0-mediated) ----------

/**
 * Reword the prompt via the model itself. Facts, numbers, names and the
 * output-format instruction must survive verbatim — the checker verifies the
 * facts, property checks verify the invariance.
 */
export async function paraphrase(
  inst: EvalInstance,
  l0: L0Client,
  seed: number,
): Promise<EvalInstance> {
  const system =
    "You rewrite evaluation task prompts. Preserve every fact, number, name, " +
    "and the final output-format instruction verbatim. Change wording only. " +
    "Reply with the rewritten prompt text and nothing else.";
  let text = "";
  try {
    text = await l0.chat(
      [
        { role: "system", content: system },
        { role: "user", content: inst.prompt },
      ],
      { temperature: 0, seed },
    );
  } catch {
    text = ""; // fail-open to identity: a dead endpoint never corrupts a shard
  }
  const p = text.trim();
  return rebase(inst, "paraphrase", seed, {
    prompt: p.length >= 20 ? p : inst.prompt,
    meta: { ...inst.meta, paraphrased: true },
  });
}

// ---------- permuteFields ----------

/** Shuffle top-level blocks (\n\n-separated) deterministically. */
export function permuteFields(inst: EvalInstance, seed: number): EvalInstance {
  const blocks = inst.prompt.split(/\n\n+/);
  if (blocks.length < 2) {
    return rebase(inst, "permuteFields", seed, {});
  }
  const rand = mulberry32(fnv1a(`${inst.id}:permute`) ^ (seed >>> 0));
  const arr = [...blocks];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i] as string;
    arr[i] = arr[j] as string;
    arr[j] = tmp;
  }
  return rebase(inst, "permuteFields", seed, { prompt: arr.join("\n\n") });
}

// ---------- scaleValue ----------

const SCALE_FACTORS = [2, 3, 0.5] as const;

/**
 * Scale the numeric field named by meta.scaleTarget in BOTH the synthetic
 * input and the expected answer, keeping ground truth consistent. Templates
 * that opt in store scaleTarget in meta; others get an identity rebase.
 */
export function scaleValue(inst: EvalInstance, seed: number): EvalInstance {
  const target = inst.meta?.scaleTarget;
  if (
    typeof target !== "string" ||
    inst.expected.kind !== "exact"
  ) {
    return rebase(inst, "scaleValue", seed, {});
  }
  let obj: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(inst.expected.value);
    if (!isObj(v)) return rebase(inst, "scaleValue", seed, {});
    obj = v;
  } catch {
    return rebase(inst, "scaleValue", seed, {});
  }
  const oldVal = obj[target];
  if (typeof oldVal !== "number") return rebase(inst, "scaleValue", seed, {});
  const rand = mulberry32(fnv1a(`${inst.id}:scale`) ^ (seed >>> 0));
  const factor = SCALE_FACTORS[Math.floor(rand() * SCALE_FACTORS.length)] as number;
  const newVal = Math.round(oldVal * factor);
  const oldStr = String(oldVal);
  if (!inst.prompt.includes(oldStr)) {
    // Cannot keep input/truth consistent — degrade to identity rather than lie.
    return rebase(inst, "scaleValue", seed, {});
  }
  obj[target] = newVal;
  return rebase(inst, "scaleValue", seed, {
    prompt: inst.prompt.replaceAll(oldStr, String(newVal)),
    expected: { kind: "exact", value: canonicalize(obj) },
  });
}

// ---------- formatShift ----------

const FORMAT_REMINDERS = [
  "Output reminder: reply with a single line of minified JSON and no prose.",
  'Format requirement: your entire reply must parse as one JSON object, e.g. {"field": "value"}.',
] as const;

/** Append one of two equivalent output-format instructions (chosen by seed). */
export function formatShift(inst: EvalInstance, seed: number): EvalInstance {
  const variant = fnv1a(`${inst.id}:fmt`) ^ (seed >>> 0);
  const reminder = FORMAT_REMINDERS[variant % FORMAT_REMINDERS.length] as string;
  return rebase(inst, "formatShift", seed, {
    prompt: `${inst.prompt}\n\n${reminder}`,
  });
}

// ---------- hrEnPair ----------

/**
 * Mirror HR↔EN translation direction using the phrasebook pair stored in
 * instance meta (set by hr-en-translate). Non-translation instances are
 * rebased unchanged.
 */
export function hrEnPair(inst: EvalInstance, seed: number): EvalInstance {
  const hr = inst.meta?.hrText;
  const en = inst.meta?.enText;
  const dir = inst.meta?.direction;
  if (
    typeof hr !== "string" || typeof en !== "string" || typeof dir !== "string" ||
    inst.expected.kind !== "exact"
  ) {
    return rebase(inst, "hrEnPair", seed, {});
  }
  // Mirroring: the previous TARGET becomes the new SOURCE.
  const toEnglish = dir === "en->hr"; // previously EN->HR, now present HR and ask for EN
  const src = toEnglish ? hr : en;
  const tgt = toEnglish ? en : hr;
  const newDir = toEnglish ? "hr->en" : "en->hr";
  return rebase(inst, "hrEnPair", seed, {
    prompt: [
      `Translate the sentence to ${toEnglish ? "English" : "Croatian"}.`,
      'Respond with ONLY minified JSON: {"translation": "<string>"}',
      "",
      `Sentence: "${src}"`,
    ].join("\n"),
    expected: { kind: "exact", value: canonicalize({ translation: tgt }) },
    meta: { ...inst.meta, direction: newDir },
  });
}

// ---------- dispatch ----------

export function applyPureTransform(
  id: string,
  inst: EvalInstance,
  seed: number,
): EvalInstance {
  switch (id) {
    case "permuteFields":
      return permuteFields(inst, seed);
    case "scaleValue":
      return scaleValue(inst, seed);
    case "formatShift":
      return formatShift(inst, seed);
    case "hrEnPair":
      return hrEnPair(inst, seed);
    default:
      throw new Error(`unknown pure transform: ${id}`);
  }
}
