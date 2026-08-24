// loop/gate.ts — nightly verification gate (L2, the component that never
// learns). Fresh-sampled instances (evals/generate.ts), head-to-head scoring
// at temperature 0 with pinned seeds (evals/score.ts), AUTO-REVERT of the
// candidate commit on regression, and an ed25519-signed certificate written
// to gates/<date>-<sha>.json.
//
// The gate sits OUTSIDE the refine loop and holds no mutable state: given the
// same shas + suiteSeed it reaches the same decision. Three consecutive
// revert decisions must freeze refine upstream (PRD kill criterion).

import { resolveFromRoot } from "../core/config.ts";
import { ensureKeys, signObject, verifyObject } from "../core/sign.ts";
import type { EvalInstance, GateCertificate, L0Client } from "../core/types.ts";
import { generateSuite } from "../evals/generate.ts";
import { headToHead } from "../evals/score.ts";
import { knowledgePromptAt, revertCommit } from "./refine.ts";

export interface GateOptions {
  /** Knowledge repo root (absolute or project-root-relative). */
  knowledgeRoot: string;
  /** Candidate commit under evaluation (HEAD after refine). */
  candidateSha: string;
  /** Pre-refinement commit — the incumbent state. */
  baselineSha: string;
  client: L0Client;
  suiteSeed: number;
  instanceCount?: number; // default 12 for PoC-scale nightly runs
  gatesDir?: string; // default config.paths.gates resolved from root
  keysDir?: string; // default "data/keys"
  /** Suite version string; default `gate:<baseline>..<candidate>`. */
  version?: string;
  /** Noise tolerance on the paired mean delta (default 0 = strict). */
  tolerance?: number;
}

export interface GateRun {
  cert: GateCertificate & { signature: string };
  certPath: string;
  reverted: boolean;
  instances: EvalInstance[];
}

/**
 * Run one gate: old-vs-new over the SAME fresh instance set, decide, revert
 * on regression, write signed certificate. Idempotent per (candidateSha,
 * suiteSeed): reruns overwrite the same cert file and reach the same verdict.
 */
export async function runGate(opts: GateOptions): Promise<GateRun> {
  const count = opts.instanceCount ?? 12;
  const root = opts.knowledgeRoot.startsWith("/")
    ? opts.knowledgeRoot
    : resolveFromRoot(opts.knowledgeRoot);
  const gatesDir = (opts.gatesDir ?? "gates").startsWith("/")
    ? opts.gatesDir!
    : resolveFromRoot(opts.gatesDir ?? "gates");
  const keysDir = opts.keysDir ?? "data/keys";

  const version = opts.version ?? `gate:${opts.baselineSha}..${opts.candidateSha}`;
  const instances = generateSuite(opts.suiteSeed, version, count);

  const [oldSystem, newSystem] = await Promise.all([
    knowledgePromptAt(root, opts.baselineSha),
    knowledgePromptAt(root, opts.candidateSha),
  ]);

  const h2h = await headToHead(opts.client, instances, {
    oldSystem,
    newSystem,
    tolerance: opts.tolerance ?? 0,
  });

  let reverted = false;
  if (h2h.decision === "revert") {
    await revertCommit(
      root,
      opts.candidateSha,
      `delta=${h2h.delta.toFixed(4)} old=${h2h.oldScore.toFixed(4)} new=${h2h.newScore.toFixed(4)}`,
    );
    reverted = true;
  }

  const { priv, pub } = await ensureKeys(keysDir);
  const dateIso = new Date().toISOString();
  const unsigned: GateCertificate = {
    id: `gate-${dateIso.slice(0, 10)}-${opts.candidateSha.slice(0, 10)}`,
    date: dateIso,
    knowledgeSha: opts.candidateSha,
    baseModel: (await opts.client.manifest()).name,
    suiteSeed: opts.suiteSeed,
    instanceCount: count,
    oldScore: h2h.oldScore,
    newScore: h2h.newScore,
    decision: h2h.decision,
  };
  const cert = await signObject(unsigned, priv);

  // tamper-evidence sanity before persisting (cheap; catches key/canon bugs)
  if (!(await verifyObject(cert, pub))) {
    throw new Error("gate produced a certificate that fails its own signature");
  }

  const fs = await import("node:fs/promises");
  await fs.mkdir(gatesDir, { recursive: true });
  const certPath = `${gatesDir}/${dateIso.slice(0, 10)}-${opts.candidateSha}.json`;
  await fs.writeFile(certPath, JSON.stringify(cert, null, 2));

  return { cert, certPath, reverted, instances };
}
