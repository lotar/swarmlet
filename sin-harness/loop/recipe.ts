// loop/recipe.ts — adapter recipe export (L3, "recipes not weights").
//
// A recipe is the ONLY thing a saturated pattern ever produces that can leave
// the machine (PRD L4): a signed, executable training spec. Each node runs it
// locally against its own distilled data — weights stay personal and
// regenerable; recipes are commons-replicable text.

import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureKeys,
  signObject,
  verifyObject,
  type KeyMaterial,
} from "../core/sign.ts";
import type {
  AdapterRecipe,
  EventRecord,
  ModelManifest,
  SaturationVerdict,
} from "../core/types.ts";
import { redactPii } from "./events.ts";

export const RECIPE_VERSION = 1;

/** Conservative QLoRA defaults for ≤12B-class MoE bases on ~48 GB budget
 * (PRD reference node headroom). Overridable per call. */
export function defaultTrainingConfig() {
  return {
    method: "QLoRA" as const,
    r: 16,
    loraAlpha: 32,
    loraDropout: 0.05,
    targetModules: ["q_proj", "k_proj", "v_proj", "o_proj"],
    epochs: 3,
    learningRate: 1e-4,
    batchSize: 8,
    gradAccum: 4,
    maxSeqLen: 2048,
    budgetGb: 48,
    cadence: "saturation-triggered-weekly-max" as const,
  };
}

export interface RecipeInput {
  verdict: SaturationVerdict;
  /** Signal events belonging to this pattern (from the same store the
   * verdict was computed against). Payloads are redacted before export. */
  events: readonly EventRecord[];
  baseModel: Pick<
    ModelManifest,
    "name" | "quantization" | "contextLength"
  >;
  /** ISO; override for deterministic tests/replays. */
  ts?: string;
  outDir?: string; // default "recipes"
  keysDir?: string; // default "data/keys"
  keys?: KeyMaterial; // injectable for tests
}

/**
 * Build, sign, self-verify, persist. Idempotent given identical inputs + ts:
 * same bytes out every time (canonical JSON, sorted keys).
 */
export async function buildRecipe(input: RecipeInput): Promise<{
  recipe: AdapterRecipe;
  path: string;
}> {
  const { verdict } = input;
  if (!verdict.saturated) {
    throw new Error(
      `refusing to build recipe for non-saturated pattern (${verdict.reason ?? "?"})`,
    );
  }

  const ts = input.ts ?? new Date().toISOString();
  const eventIds = input.events.map((e) => e.id);
  // Bounded redacted samples: enough to seed local distillation, never raw.
  const samples = input.events
    .slice(0, 10)
    .map((e) => redactPii(e.payload))
    .filter((p) => p.length > 0)
    .slice(0, 10);

  const id = `recipe-${ts.slice(0, 10)}-${hashKey(verdict.patternKey)}`;
  const unsigned: AdapterRecipe = {
    id,
    createdAt: ts,
    status: "draft",
    sourcePattern: {
      patternKey: verdict.patternKey,
      occurrences: verdict.occurrences,
      firstSeen: verdict.firstSeen,
      lastSeen: verdict.lastSeen,
      samples,
    },
    baseModel: {
      name: input.baseModel.name,
      quantization: input.baseModel.quantization,
      contextLength: input.baseModel.contextLength,
    },
    trainingDataSpec: {
      source: "distilled-corrections-only",
      eventIds,
      minSamples: Math.min(20, eventIds.length),
      format: "jsonl-chat",
      piiPolicy: "redact-before-export",
    },
    trainingConfig: defaultTrainingConfig(),
    audition: {
      required: true,
      criteria: [
        "beat-incumbent-on-private-shard",
        "behavioral-diff-certificate",
        "off-domain-drift-below-threshold",
      ],
    },
  };

  const keys = input.keys ?? (await ensureKeys(input.keysDir ?? "data/keys"));
  const signed = await signObject(unsigned, keys.priv);
  // Tamper-evidence sanity before persisting (mirrors gate.ts discipline).
  if (!(await verifyObject(signed, keys.pub))) {
    throw new Error("recipe failed its own signature verification");
  }
  const recipe = signed as AdapterRecipe;

  const outDir = input.outDir ?? "recipes";
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${id}.json`);
  await writeFile(path, JSON.stringify(recipe, null, 2));
  return { recipe, path };
}

function hashKey(key: string): string {
  let h = 0x811c9dc5; // FNV-1a 32-bit
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
