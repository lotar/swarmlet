// Tiny deterministic MoE math used to prove TRUE expert ownership/dispatch.
// This is deliberately dependency-free and tiny: it validates semantics and
// transport barriers, not frontier-model quality or GPU throughput.

export const HIDDEN = 8;
export const INTERMEDIATE = 4;
export const EXPERT_COUNT = 4;
export const TOP_K = 2;

export interface ExpertWeights {
  id: number;
  w1: number[][]; // [intermediate, hidden]
  b1: number[];
  w2: number[][]; // [hidden, intermediate]
  b2: number[];
}

export interface RouteChoice { expertId: number; weight: number; logit: number }
export interface ReferenceToken {
  choices: RouteChoice[];
  output: number[];
}

/** Router logits chosen for transparent test coverage: [x0,x1,-x0,-x1]. */
export function routerLogits(x: readonly number[]): number[] {
  if (x.length !== HIDDEN) throw new Error(`hidden width ${x.length} != ${HIDDEN}`);
  return [x[0]!, x[1]!, -x[0]!, -x[1]!];
}

/** Stable top-2: descending logit, then ascending expert id. */
export function routeTop2(x: readonly number[]): RouteChoice[] {
  const logits = routerLogits(x);
  const top = logits.map((logit, expertId) => ({ expertId, logit }))
    .sort((a, b) => b.logit - a.logit || a.expertId - b.expertId)
    .slice(0, TOP_K);
  const max = Math.max(...top.map((x) => x.logit));
  const exp = top.map((x) => Math.exp(x.logit - max));
  const z = exp.reduce((a, b) => a + b, 0);
  return top.map((x, i) => ({ ...x, weight: exp[i]! / z }));
}

function matVec(m: readonly number[][], x: readonly number[]): number[] {
  return m.map((row) => row.reduce((s, w, i) => s + w * x[i]!, 0));
}

export function expertForward(w: ExpertWeights, x: readonly number[]): number[] {
  if (x.length !== HIDDEN) throw new Error(`hidden width ${x.length} != ${HIDDEN}`);
  const h = matVec(w.w1, x).map((v, i) => Math.max(0, v + w.b1[i]!));
  return matVec(w.w2, h).map((v, i) => v + w.b2[i]!);
}

/** Arrival-order independent weighted reduction: always ascending expert id. */
export function orderedReduce(
  pieces: ReadonlyArray<{ expertId: number; gateWeight: number; output: number[] }>,
): number[] {
  const sorted = [...pieces].sort((a, b) => a.expertId - b.expertId);
  const out = Array<number>(HIDDEN).fill(0);
  for (const p of sorted) {
    for (let i = 0; i < HIDDEN; i++) out[i] = out[i]! + p.gateWeight * p.output[i]!;
  }
  return out;
}

export function referenceForward(
  tokens: readonly number[][],
  experts: ReadonlyMap<number, ExpertWeights>,
): ReferenceToken[] {
  return tokens.map((token) => {
    const choices = routeTop2(token);
    const pieces = choices.map((c) => {
      const expert = experts.get(c.expertId);
      if (!expert) throw new Error(`reference missing expert ${c.expertId}`);
      return { expertId: c.expertId, gateWeight: c.weight, output: expertForward(expert, token) };
    });
    return { choices, output: orderedReduce(pieces) };
  });
}

/** 64 vectors cover all sign quadrants, ties, zeros and deterministic noise. */
export function makeCorpus(count = 64): number[][] {
  const anchors: Array<readonly [number, number]> = [[3, 2], [3, -2], [-3, 2], [-3, -2], [0, 0], [2, 2], [-2, -2], [1, -1]];
  return Array.from({ length: count }, (_, i) => {
    const [a, b] = anchors[i % anchors.length]!;
    return [a, b, ...Array.from({ length: 6 }, (__, j) => (((i + 1) * (j + 3)) % 13 - 6) / 6)];
  });
}
