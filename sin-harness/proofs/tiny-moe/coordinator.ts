// Plan-pinned router + batched fan-out/reduce. This process owns no expert matrices.
import { HIDDEN, orderedReduce, routeTop2, type RouteChoice } from "./math.ts";
import type { DispatchItem, DispatchRequest, DispatchResponse, ExpertManifest, ExpertPiece, PlacementPlan } from "./protocol.ts";
import { ExpertUnavailable, PROTOCOL_VERSION } from "./protocol.ts";
import { validatePlacementPlan } from "./placement.ts";

export interface OwnerEndpoint { nodeId: string; url: string }
export interface ForwardTelemetry { rpcCount: number; bytesOut: number; bytesIn: number; ownerBatchSizes: Record<string, number>; durationMs: number }
export interface ForwardResult { outputs: number[][]; routes: RouteChoice[][]; telemetry: ForwardTelemetry }
function pair(tokenIndex: number, expertId: number): string { return `${tokenIndex}:${expertId}`; }
function finiteOutput(x: unknown): x is number[] { return Array.isArray(x) && x.length === HIDDEN && x.every(Number.isFinite); }

export class TinyMoECoordinator {
  private ownerByExpert = new Map<number, OwnerEndpoint>();
  private manifests = new Map<string, ExpertManifest>(); private seq = 0;
  readonly plan: PlacementPlan;
  constructor(readonly owners: readonly OwnerEndpoint[], plan: PlacementPlan, readonly timeoutMs = 2000) { this.plan = validatePlacementPlan(plan); }

  async initialize(): Promise<ExpertManifest[]> {
    const nextOwners = new Map<number, OwnerEndpoint>(); const nextManifests = new Map<string, ExpertManifest>();
    const configured = new Map(this.owners.map((o) => [o.nodeId, o]));
    if (configured.size !== this.owners.length || configured.size !== this.plan.owners.length) throw new Error("owner endpoint set does not match placement plan");
    for (const expected of this.plan.owners) {
      const owner = configured.get(expected.nodeId); if (!owner) throw new Error(`missing endpoint ${expected.nodeId}`);
      const res = await fetch(`${owner.url}/manifest`, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) throw new Error(`manifest ${owner.nodeId}: HTTP ${res.status}`);
      const m = await res.json() as ExpertManifest;
      if (m.nodeId !== owner.nodeId || m.modelId !== this.plan.modelId || m.protocolVersion !== PROTOCOL_VERSION || m.placementEpoch !== this.plan.placementEpoch || m.fixtureDigest !== expected.fixtureSha256 || JSON.stringify(m.expertIds) !== JSON.stringify(expected.expertIds)) throw new Error(`manifest mismatch ${owner.nodeId}`);
      nextManifests.set(owner.nodeId, m);
      for (const id of m.expertIds) { if (nextOwners.has(id)) throw new Error(`expert ${id} has multiple owners`); nextOwners.set(id, owner); }
    }
    this.ownerByExpert = nextOwners; this.manifests = nextManifests;
    return [...nextManifests.values()];
  }
  ownerOf(expertId: number): OwnerEndpoint | undefined { return this.ownerByExpert.get(expertId); }

  async forwardBatch(tokens: readonly number[][]): Promise<ForwardResult> {
    if (tokens.length < 1 || tokens.length > 64) throw new Error("batch must contain 1..64 tokens");
    if (tokens.some((token) => token.length !== HIDDEN || !token.every(Number.isFinite))) throw new Error(`tokens must be finite width-${HIDDEN} vectors`);
    const t0 = performance.now(); const requestId = `tiny-${process.pid}-${++this.seq}`; const routes = tokens.map(routeTop2);
    const groups = new Map<string, { owner: OwnerEndpoint; items: DispatchItem[]; expected: Map<string, RouteChoice> }>();
    routes.forEach((choices, tokenIndex) => {
      for (const choice of choices) {
        const owner = this.ownerByExpert.get(choice.expertId); if (!owner) throw new ExpertUnavailable([choice.expertId], `no owner for expert ${choice.expertId}`);
        const group = groups.get(owner.nodeId) ?? { owner, items: [] as DispatchItem[], expected: new Map<string, RouteChoice>() };
        group.items.push({ tokenIndex, expertId: choice.expertId, activation: [...tokens[tokenIndex]!] }); group.expected.set(pair(tokenIndex, choice.expertId), choice); groups.set(owner.nodeId, group);
      }
    });
    let bytesOut = 0, bytesIn = 0; const ownerBatchSizes: Record<string, number> = {};
    const calls = [...groups.values()].map(async ({ owner, items, expected }) => {
      const body: DispatchRequest = { protocolVersion: PROTOCOL_VERSION, placementEpoch: this.plan.placementEpoch, requestId, tokenCount: tokens.length, items };
      const raw = JSON.stringify(body); bytesOut += Buffer.byteLength(raw); ownerBatchSizes[owner.nodeId] = items.length;
      try {
        const res = await fetch(`${owner.url}/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: raw, signal: AbortSignal.timeout(this.timeoutMs) });
        const text = await res.text(); bytesIn += Buffer.byteLength(text);
        if (!res.ok) { let ids = [...new Set(items.map((x) => x.expertId))]; try { ids = (JSON.parse(text).expertIds as number[]) ?? ids; } catch {} throw new ExpertUnavailable(ids, `${owner.nodeId} HTTP ${res.status}`); }
        const out = JSON.parse(text) as DispatchResponse;
        if (out.requestId !== requestId || out.nodeId !== owner.nodeId || out.protocolVersion !== PROTOCOL_VERSION || out.placementEpoch !== this.plan.placementEpoch || !Array.isArray(out.pieces)) throw new Error(`bad response identity from ${owner.nodeId}`);
        const seen = new Set<string>(); const weighted: Array<ExpertPiece & { gateWeight: number }> = [];
        for (const piece of out.pieces) {
          if (!piece || !Number.isInteger(piece.tokenIndex) || !Number.isInteger(piece.expertId)) throw new Error(`invalid response piece from ${owner.nodeId}`);
          const key = pair(piece.tokenIndex, piece.expertId); const choice = expected.get(key);
          if (!choice || seen.has(key) || !finiteOutput(piece.output)) throw new Error(`invalid response piece from ${owner.nodeId}`);
          seen.add(key); weighted.push({ ...piece, gateWeight: choice.weight });
        }
        if (seen.size !== expected.size || [...expected.keys()].some((key) => !seen.has(key))) throw new Error(`incomplete response from ${owner.nodeId}`);
        return weighted;
      } catch (e) {
        if (e instanceof ExpertUnavailable) throw e;
        throw new ExpertUnavailable([...new Set(items.map((x) => x.expertId))], `${owner.nodeId} unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    const responses = await Promise.all(calls); const byToken = Array.from({ length: tokens.length }, () => [] as Array<ExpertPiece & { gateWeight: number }>);
    for (const pieces of responses) for (const p of pieces) byToken[p.tokenIndex]!.push(p);
    const outputs = byToken.map((pieces, tokenIndex) => {
      if (pieces.length !== routes[tokenIndex]!.length) throw new ExpertUnavailable(routes[tokenIndex]!.map((x) => x.expertId), `incomplete token ${tokenIndex}`);
      return orderedReduce(pieces);
    });
    return { outputs, routes, telemetry: { rpcCount: groups.size, bytesOut, bytesIn, ownerBatchSizes, durationMs: performance.now() - t0 } };
  }
  async forwardLayers(token: number[], layers: number): Promise<{ output: number[]; durationMs: number; rpcCount: number }> {
    const t0 = performance.now(); let x = [...token], rpcCount = 0;
    for (let layer = 0; layer < layers; layer++) { const r = await this.forwardBatch([x]); const raw = r.outputs[0]!; const scale = Math.max(1, Math.max(...raw.map((v) => Math.abs(v))) / 3); x = raw.map((v) => v / scale); rpcCount += r.telemetry.rpcCount; }
    return { output: x, durationMs: performance.now() - t0, rpcCount };
  }
}
