// Phase-aware placement: pick the prefill node and the decode node independently, by measured speed.
//
// The controller already samples each serving engine (node-agent assignments.ts): `tokPerSec` is the
// predicted-token delta (decode) and `prefillTokPerSec` is the prompt-token delta (prefill). This module
// turns those two measurements plus the state-transfer cost into the placement that minimises the total
// time of one reference request: prefill on the fastest prefill node, transfer once, decode on the
// fastest decode node. A single node that wins both phases is reported as `local`, because paying a
// transfer to split phases that are both fastest in one place cannot help.
//
// Pure and synchronous on purpose: the planner must be able to explain the decision with the numbers it
// used, and the tests must not depend on a live fleet.

export interface PhaseCandidate {
  nodeId: string;
  /** Measured prefill throughput for this model on this node, tokens/s. */
  prefillTokPerSec?: number;
  /** Measured decode throughput for this model on this node, tokens/s. */
  decodeTokPerSec?: number;
}

export interface PhasePlanInput {
  candidates: readonly PhaseCandidate[];
  /** Reference workload the decision optimises for (a deployment is planned once, not per request). */
  promptTokens: number;
  outputTokens: number;
  /** Sequence-state bytes per prompt token the transfer must move (profile boundaryBytes). */
  stateBytesPerToken: number;
  /** Bytes/s between two nodes; 0 (or missing) means the pair cannot transfer state. */
  transferBytesPerSec: (from: string, to: string) => number;
  /** Restrict who may prefill; absent means every candidate. */
  prefillNodeIds?: readonly string[];
  /** Restrict who may decode; absent means every candidate. */
  decodeNodeIds?: readonly string[];
}

export interface PhasePlan {
  prefillNodeId: string;
  decodeNodeId: string;
  /** One node is fastest for both phases; splitting would only add a transfer. */
  local: boolean;
  estimatedMs: number;
  reasons: string[];
}

export interface PhasePlanError { error: string }

const ms = (tokens: number, perSecond: number) => (tokens / perSecond) * 1000;
const one = (n: number) => Math.round(n * 10) / 10;

/** Choose the per-phase placement. Ties break on nodeId so the decision is reproducible. */
export function choosePhasePlan(input: PhasePlanInput): PhasePlan | PhasePlanError {
  const { promptTokens, outputTokens, stateBytesPerToken, transferBytesPerSec } = input;
  // Sorted so both the decision and the explanation are independent of caller order.
  const candidates = [...input.candidates].sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  const mayPrefill = input.prefillNodeIds ? new Set(input.prefillNodeIds) : null;
  const mayDecode = input.decodeNodeIds ? new Set(input.decodeNodeIds) : null;
  if (!candidates.length) return { error: "no node can host this model" };
  if (!(promptTokens > 0) || !(outputTokens > 0) || !(stateBytesPerToken > 0)) return { error: "phase plan needs positive prompt, output and state sizes" };
  const missingPrefill = candidates.filter((c) => !(c.prefillTokPerSec && c.prefillTokPerSec > 0)).map((c) => c.nodeId);
  const missingDecode = candidates.filter((c) => !(c.decodeTokPerSec && c.decodeTokPerSec > 0)).map((c) => c.nodeId);
  if (missingPrefill.length && missingDecode.length) return { error: `no measured phase speeds yet for ${[...new Set([...missingPrefill, ...missingDecode])].join(", ")}; serve one request per node or keep both nodes in one pool first` };
  if (!candidates.some((c) => c.prefillTokPerSec && c.prefillTokPerSec > 0 && c.decodeTokPerSec && c.decodeTokPerSec > 0)) return { error: "no node has both a measured prefill and decode speed" };

  const stateBytes = promptTokens * stateBytesPerToken;
  let best: { prefillNodeId: string; decodeNodeId: string; local: boolean; total: number; prefillMs: number; transferMs: number; decodeMs: number } | undefined;
  for (const prefill of candidates) {
    if (!(prefill.prefillTokPerSec && prefill.prefillTokPerSec > 0)) continue;
    if (mayPrefill && !mayPrefill.has(prefill.nodeId)) continue;
    for (const decode of candidates) {
      if (!(decode.decodeTokPerSec && decode.decodeTokPerSec > 0)) continue;
      if (mayDecode && !mayDecode.has(decode.nodeId)) continue;
      const local = prefill.nodeId === decode.nodeId;
      const rate = local ? Infinity : transferBytesPerSec(prefill.nodeId, decode.nodeId);
      if (!local && !(rate > 0)) continue;
      const prefillMs = ms(promptTokens, prefill.prefillTokPerSec);
      const decodeMs = ms(outputTokens, decode.decodeTokPerSec);
      const transferMs = local ? 0 : ms(stateBytes, rate);
      const total = prefillMs + transferMs + decodeMs;
      if (!best || total < best.total || (total === best.total && `${prefill.nodeId}\0${decode.nodeId}` < `${best.prefillNodeId}\0${best.decodeNodeId}`)) {
        best = { prefillNodeId: prefill.nodeId, decodeNodeId: decode.nodeId, local, total, prefillMs, transferMs, decodeMs };
      }
    }
  }
  if (!best) return { error: "no phase pair can be reached: the best prefill node and the best decode node cannot transfer state between them" };

  const reasons: string[] = [];
  for (const c of candidates) {
    const prefill = c.prefillTokPerSec && c.prefillTokPerSec > 0 ? `${one(c.prefillTokPerSec)} t/s prefill` : "prefill speed unmeasured";
    const decode = c.decodeTokPerSec && c.decodeTokPerSec > 0 ? `${one(c.decodeTokPerSec)} t/s decode` : "decode speed unmeasured";
    reasons.push(`${c.nodeId}: ${prefill}, ${decode}.`);
  }
  reasons.push(`Reference request ${promptTokens} prompt + ${outputTokens} output, state ${one(stateBytes / 1048576)} MiB at ${stateBytesPerToken} bytes/token.`);
  reasons.push(`Chosen ${best.local ? "local" : "split"}: prefill on ${best.prefillNodeId}, decode on ${best.decodeNodeId} = ${one(best.prefillMs)} ms prefill + ${one(best.transferMs)} ms transfer + ${one(best.decodeMs)} ms decode = ${one(best.total)} ms.`);
  return { prefillNodeId: best.prefillNodeId, decodeNodeId: best.decodeNodeId, local: best.local, estimatedMs: one(best.total), reasons };
}
