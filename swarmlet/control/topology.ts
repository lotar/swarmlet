// Topology autodiscovery: choose the deployment KIND and its nodes from measured phase speeds and
// measured network locality instead of an operator's guess.
//
// Inputs are the registration-time bench entries (Capabilities.bench) and each node's private
// addresses. Every candidate is validated by the ordinary planner, so fit, qualification and model
// inventory rules still decide admission — this module only ranks the plans that admission allows.
//
// Determinism: candidate enumeration is fixed (replica → prefill-decode → split, nodes sorted by
// hostname then id), comparisons use a fixed epsilon, ties break on a fixed key, and the decision is
// hashed. Same inputs, same plan, same hash — no clock and no randomness here; the caller filters
// stale measurements before calling.
import { createHash } from "node:crypto";
import type { DeploymentSpec, ModelProfile } from "../protocol/types.ts";
import type { NodeRow } from "./registry.ts";
import { PlanError, planDeployment, type PlanInput } from "./planner.ts";
import { choosePhasePlan } from "./phase-plan.ts";
import { QWEN35_NATIVE_QUALIFICATIONS, type Qwen35NativeQualification } from "./profiles/qwen35-native.ts";

/** Reference request every estimate is priced against; a deployment is planned once, not per request. */
export const REFERENCE_REQUEST = { promptTokens: 512, outputTokens: 64 };
/** Measured 2026-09-19 (docs/reports/PREFILL_CUDA_DECODE_MAC_20260919.md): authenticated capsule legs on
 *  the home Wi-Fi ran at 0.4–1.2 MiB/s. This constant is the conservative seed; P1 replaces it with
 *  measured per-pair link rates. The relay leg adds hosted-control hops, hence the lower figure. */
export const LAN_MIB_PER_SEC = 1.0;
export const RELAY_MIB_PER_SEC = 0.1;
/** Local-first margin: a relayed plan must beat the best same-LAN plan by this much to be chosen. */
export const RELAY_PENALTY = 1.25;
const EPSILON_MS = 1;

const isPrivateV4 = (ip: string): boolean => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
};
/** /24 of every private address — a LAN hint used to pick who may dial whom, never a decision on its own. */
export const subnetsOf = (node: NodeRow): string[] =>
  [...new Set((node.caps?.privateIps ?? []).filter(isPrivateV4).map((ip) => ip.split(".").slice(0, 3).join(".")))].sort();
export const sameLan = (a: NodeRow, b: NodeRow): boolean => {
  const left = new Set(subnetsOf(a));
  return subnetsOf(b).some((s) => left.has(s));
};

export interface BenchRow { prefillTokPerSec: number; decodeTokPerSec: number }
/** The freshest bench entry for this model and the engine the node runs now. */
export function benchFor(node: NodeRow, modelSha256: string): BenchRow | undefined {
  const engine = node.caps?.engine?.sha256?.["llama-server"];
  const entries = (node.caps?.bench ?? []).filter((b) => b.kind === "llama-server" && b.modelSha256 === modelSha256
    && (!engine || b.engineSha256 === engine) && b.prefillTokPerSec > 0 && b.decodeTokPerSec > 0);
  if (!entries.length) return undefined;
  entries.sort((a, b) => b.ctx - a.ctx || b.measuredAt.localeCompare(a.measuredAt));
  return { prefillTokPerSec: entries[0]!.prefillTokPerSec, decodeTokPerSec: entries[0]!.decodeTokPerSec };
}

export interface TopologyCandidate {
  kind: "replica" | "prefill-decode" | "split";
  nodes: string[];
  estimatedMs: number;
  local: boolean;
  reason: string;
}
export interface TopologyChoice extends TopologyCandidate {
  spec: Partial<DeploymentSpec>;
  planHash: string;
  candidates: TopologyCandidate[];
  reasons: string[];
}
export interface TopologyError { error: string }

export interface TopologyInput {
  spec: DeploymentSpec;
  profile: ModelProfile;
  nodes: NodeRow[];
  usedPorts?: Map<string, Set<number>>;
  qualifications?: readonly Qwen35NativeQualification[];
  reference?: { promptTokens: number; outputTokens: number };
}

const orderNodes = (nodes: NodeRow[]): NodeRow[] => [...nodes].sort((a, b) => a.hostname.localeCompare(b.hostname) || a.id.localeCompare(b.id));
const ms = (tokens: number, perSecond: number): number => (tokens / perSecond) * 1000;
const rttOf = (node: NodeRow): number => node.metrics?.link?.rttMs ?? node.caps?.net?.rttMs ?? 50;
const fmt = (n: number): string => (Math.round(n * 10) / 10).toString();
/** Local-first ranking: a relayed candidate carries the fixed penalty, so it must be that much faster
 *  to be chosen at all. Exported so the margin rule is a unit, not a hidden constant. */
export const scoreCandidate = (c: Pick<TopologyCandidate, "estimatedMs" | "local">): number => c.estimatedMs * (c.local ? 1 : RELAY_PENALTY);

/** Estimated wall time for one reference request on a candidate plan. */
function estimate(input: TopologyInput, kind: TopologyCandidate["kind"], nodes: NodeRow[], modelSha256: string): { estimatedMs?: number; local: boolean; reason?: string } {
  const ref = input.reference ?? REFERENCE_REQUEST;
  const local = kind === "replica" ? true : nodes.length > 1 && nodes.slice(1).every((n, i) => sameLan(nodes[i]!, n));
  if (kind === "replica") {
    const bench = benchFor(nodes[0]!, modelSha256);
    if (!bench) return { local, reason: `no bench for model ${modelSha256.slice(0, 12)} on ${nodes[0]!.hostname}` };
    return { estimatedMs: ms(ref.promptTokens, bench.prefillTokPerSec) + ms(ref.outputTokens, bench.decodeTokPerSec), local };
  }
  if (kind === "prefill-decode") {
    const [a, b] = nodes as [NodeRow, NodeRow];
    const pa = benchFor(a, modelSha256), pb = benchFor(b, modelSha256);
    if (!pa || !pb) return { local, reason: `no bench on ${!pa ? a.hostname : b.hostname}` };
    const rate = local ? LAN_MIB_PER_SEC : RELAY_MIB_PER_SEC;
    const stateMiB = (ref.promptTokens * (input.profile.boundaryBytes ?? 0)) / 1048576;
    const choice = choosePhasePlan({
      candidates: [{ nodeId: a.id, prefillTokPerSec: pa.prefillTokPerSec, decodeTokPerSec: pa.decodeTokPerSec },
        { nodeId: b.id, prefillTokPerSec: pb.prefillTokPerSec, decodeTokPerSec: pb.decodeTokPerSec }],
      promptTokens: ref.promptTokens, outputTokens: ref.outputTokens,
      stateBytesPerToken: input.profile.boundaryBytes ?? 0,
      transferBytesPerSec: () => rate * 1048576,
      prefillNodeIds: [a.id], decodeNodeIds: [b.id],
    });
    if ("error" in choice) return { local, reason: choice.error };
    return { estimatedMs: choice.estimatedMs + (choice.local ? 0 : 0), local };
  }
  // Split: every token crosses each boundary, and prompt batches cross per 64-token step. This is the
  // same shape our Wi-Fi measurements showed (2B split 32/32: prefill 102-216 t/s, decode 4.7-7.1 t/s).
  const benches = nodes.map((n) => benchFor(n, modelSha256));
  if (benches.some((b) => !b)) return { local, reason: `no bench on ${nodes.filter((n, i) => !benches[i]).map((n) => n.hostname).join(", ")}` };
  const prefill = Math.min(...benches.map((b) => b!.prefillTokPerSec));
  const decode = Math.min(...benches.map((b) => b!.decodeTokPerSec));
  const hops = nodes.length - 1;
  const rtt = Math.max(...nodes.map(rttOf));
  const crossings = Math.ceil(ref.promptTokens / 64) + ref.outputTokens;
  return { estimatedMs: ms(ref.promptTokens, prefill) + ms(ref.outputTokens, decode) + hops * crossings * rtt, local };
}

/** Rank every topology admission allows and return the local-first winner. */
export function chooseTopology(input: TopologyInput): TopologyChoice | TopologyError {
  const { spec, profile, nodes } = input;
  const modelSha256 = spec.modelSha256 ?? profileModelSha(profile, nodes);
  if (!modelSha256) return { error: `profile ${profile.id} has no model sha to price against` };
  const eligible = orderNodes(nodes.filter((n) => n.online && n.offer?.enabled));
  if (!eligible.length) return { error: "no online node with an enabled offer" };
  const usedPorts = input.usedPorts ?? new Map();
  const qualifications = input.qualifications ?? QWEN35_NATIVE_QUALIFICATIONS;
  const ref = input.reference ?? REFERENCE_REQUEST;
  const candidates: TopologyCandidate[] = [];
  const rejected: string[] = [];

  const consider = (kind: TopologyCandidate["kind"], picked: NodeRow[]): void => {
    const est = estimate(input, kind, picked, modelSha256);
    const label = `${kind} [${picked.map((n) => n.hostname).join(" → ")}]`;
    if (est.estimatedMs === undefined) { rejected.push(`${label}: ${est.reason}`); return; }
    // Admission: the ordinary planner still owns fit, qualification, inventory and role rules.
    // The trial spec is built key by key: a native spec that carries even an `undefined` key for
    // another kind is refused, so nothing from the request may leak in except the common fields.
    const trial: DeploymentSpec = { name: spec.name, profile: profile.id, kind, ctx: spec.ctx ?? 1024, parallel: spec.parallel ?? 1, chain: spec.chain ?? 0, transport: spec.transport };
    if (kind === "replica") trial.replicaNodeId = picked[0]!.id;
    if (kind === "prefill-decode") { trial.prefillNodeId = picked[0]!.id; trial.decodeNodeId = picked[1]!.id; trial.modelSha256 = modelSha256; }
    if (kind === "split") { trial.coordinatorNodeId = picked[0]!.id; trial.workerNodeIds = picked.slice(1).map((n) => n.id); }
    try {
      planDeployment({ spec: trial, profile, nodes: input.nodes, usedPorts, nativeQualifications: qualifications } as PlanInput);
    } catch (e) {
      if (e instanceof PlanError) { rejected.push(`${label}: ${e.reasons[0] ?? e.message}`); return; }
      throw e;
    }
    candidates.push({
      kind, nodes: picked.map((n) => n.id), estimatedMs: est.estimatedMs, local: est.local,
      reason: `${label}: ${fmt(est.estimatedMs)} ms for ${ref.promptTokens}+${ref.outputTokens} (${est.local ? "same LAN" : "relayed"})`,
    });
  };

  for (const n of eligible) consider("replica", [n]);
  const qualifiedPairs = qualificationPairs(eligible, qualifications, modelSha256);
  for (const [a, b] of qualifiedPairs) { consider("prefill-decode", [a, b]); consider("prefill-decode", [b, a]); }
  for (const group of lanGroups(eligible)) {
    if (group.length < 2) continue;
    for (const coordinator of group) consider("split", [coordinator, ...group.filter((n) => n.id !== coordinator.id)]);
  }
  if (!candidates.length) return { error: `no topology can be priced and admitted for ${profile.id}: ${rejected.slice(0, 4).join("; ")}` };

  candidates.sort((a, b) => {
    const [sa, sb] = [scoreCandidate(a), scoreCandidate(b)];
    if (Math.abs(sa - sb) > EPSILON_MS) return sa - sb;
    return a.kind.localeCompare(b.kind) || a.nodes.join(",").localeCompare(b.nodes.join(","));
  });
  const best = candidates[0]!;
  const specPatch: Partial<DeploymentSpec> = {
    name: spec.name, profile: profile.id, kind: best.kind, ctx: spec.ctx ?? 1024, parallel: spec.parallel ?? 1, chain: spec.chain ?? 0, transport: spec.transport,
  };
  if (best.kind === "replica") specPatch.replicaNodeId = best.nodes[0];
  if (best.kind === "prefill-decode") { specPatch.prefillNodeId = best.nodes[0]; specPatch.decodeNodeId = best.nodes[1]; specPatch.modelSha256 = modelSha256; }
  if (best.kind === "split") { specPatch.coordinatorNodeId = best.nodes[0]; specPatch.workerNodeIds = best.nodes.slice(1); }
  const reasons = [
    `topology: ${candidates.length} admitted candidate(s) for ${profile.id}; reference ${ref.promptTokens} prompt + ${ref.outputTokens} output.`,
    ...candidates.map((c) => `${c.reason}${c.local ? "" : ` → score ×${RELAY_PENALTY} (relayed)`}`),
    ...(rejected.length ? [`rejected: ${rejected.slice(0, 4).join("; ")}`] : []),
    `chosen ${best.kind} [${best.nodes.join(" → ")}]: ${fmt(best.estimatedMs)} ms, ${best.local ? "stays on the LAN" : "relayed"}.`,
  ];
  const planHash = createHash("sha256").update(JSON.stringify({ modelSha256, ref, chosen: best, candidates })).digest("hex");
  return { ...best, spec: specPatch, planHash, candidates, reasons };
}

/** Model sha for a profile when the spec does not pin one: the node inventory is the source of truth. */
function profileModelSha(profile: ModelProfile, nodes: NodeRow[]): string | undefined {
  const re = new RegExp(profile.ggufPattern);
  for (const node of nodes) for (const model of node.models) if (model.kind === "gguf" && re.test(model.name) && model.sha256) return model.sha256;
  return undefined;
}

/** Nodes that can legally hold a native prefill or decode endpoint for this model, per qualification. */
function qualificationPairs(nodes: NodeRow[], qualifications: readonly Qwen35NativeQualification[], modelSha256: string): Array<[NodeRow, NodeRow]> {
  const pairs: Array<[NodeRow, NodeRow]> = [];
  for (const q of qualifications) {
    if (q.mode !== "prefill-decode" || q.sourceSha256 !== modelSha256) continue;
    const fits = (n: NodeRow, entry: Qwen35NativeQualification["endpoints"][number]): boolean => {
      const artifact = entry.artifact;
      if (!(n.offer?.roles.replica)) return false;
      if (n.caps?.engine?.stages?.engine !== q.engine) return false;
      if (n.caps.engine.sha256["mesh-stage-worker"] !== entry.binarySha256) return false;
      return n.models.some((m) => m.kind === "gguf" && m.name === artifact.name && m.sha256 === artifact.sha256);
    };
    for (const a of nodes) for (const b of nodes) if (a.id !== b.id && fits(a, q.endpoints[0]!) && fits(b, q.endpoints[1]!)) pairs.push([a, b]);
  }
  return pairs;
}

/** Same-LAN groups, largest first, each sorted deterministically. */
function lanGroups(nodes: NodeRow[]): NodeRow[][] {
  const groups: NodeRow[][] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    const group = [node, ...nodes.filter((other) => other.id !== node.id && !seen.has(other.id) && sameLan(node, other))];
    for (const n of group) seen.add(n.id);
    groups.push(orderNodes(group));
  }
  return groups;
}
