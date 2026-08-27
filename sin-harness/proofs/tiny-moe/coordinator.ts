// Router + batched fan-out/reduce. This process owns NO expert matrices.
import { orderedReduce, routeTop2, type RouteChoice } from "./math.ts";
import type {
  DispatchItem, DispatchRequest, DispatchResponse, ExpertManifest, ExpertPiece,
} from "./protocol.ts";
import { ExpertUnavailable } from "./protocol.ts";

export interface OwnerEndpoint { nodeId: string; url: string }
export interface ForwardTelemetry {
  rpcCount: number;
  bytesOut: number;
  bytesIn: number;
  ownerBatchSizes: Record<string, number>;
  durationMs: number;
}
export interface ForwardResult {
  outputs: number[][];
  routes: RouteChoice[][];
  telemetry: ForwardTelemetry;
}

export class TinyMoECoordinator {
  private ownerByExpert = new Map<number, OwnerEndpoint>();
  private manifests = new Map<string, ExpertManifest>();
  private seq = 0;
  constructor(
    readonly owners: readonly OwnerEndpoint[],
    readonly timeoutMs = 2000,
  ) {}

  async initialize(): Promise<ExpertManifest[]> {
    this.ownerByExpert.clear();
    this.manifests.clear();
    for (const owner of this.owners) {
      const res = await fetch(`${owner.url}/manifest`, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) throw new Error(`manifest ${owner.nodeId}: HTTP ${res.status}`);
      const m = await res.json() as ExpertManifest;
      if (m.nodeId !== owner.nodeId) throw new Error(`manifest identity mismatch ${m.nodeId}`);
      this.manifests.set(owner.nodeId, m);
      for (const id of m.expertIds) {
        if (this.ownerByExpert.has(id)) throw new Error(`expert ${id} has multiple primary owners`);
        this.ownerByExpert.set(id, owner);
      }
    }
    return [...this.manifests.values()];
  }

  ownerOf(expertId: number): OwnerEndpoint | undefined { return this.ownerByExpert.get(expertId); }

  async forwardBatch(tokens: readonly number[][]): Promise<ForwardResult> {
    const t0 = performance.now();
    const requestId = `tiny-${process.pid}-${++this.seq}`;
    const routes = tokens.map(routeTop2);
    const groups = new Map<string, { owner: OwnerEndpoint; items: DispatchItem[] }>();
    routes.forEach((choices, tokenIndex) => {
      for (const c of choices) {
        const owner = this.ownerByExpert.get(c.expertId);
        if (!owner) throw new ExpertUnavailable([c.expertId], `no owner for expert ${c.expertId}`);
        const g = groups.get(owner.nodeId) ?? { owner, items: [] };
        g.items.push({ tokenIndex, expertId: c.expertId, activation: [...tokens[tokenIndex]!], gateWeight: c.weight });
        groups.set(owner.nodeId, g);
      }
    });

    let bytesOut = 0;
    let bytesIn = 0;
    const ownerBatchSizes: Record<string, number> = {};
    const calls = [...groups.values()].map(async ({ owner, items }) => {
      const body: DispatchRequest = { requestId, items };
      const raw = JSON.stringify(body);
      bytesOut += Buffer.byteLength(raw);
      ownerBatchSizes[owner.nodeId] = items.length;
      try {
        const res = await fetch(`${owner.url}/execute`, {
          method: "POST", headers: { "content-type": "application/json" }, body: raw,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const text = await res.text();
        bytesIn += Buffer.byteLength(text);
        if (!res.ok) {
          let ids = [...new Set(items.map((x) => x.expertId))];
          try { ids = (JSON.parse(text).expertIds as number[]) ?? ids; } catch {}
          throw new ExpertUnavailable(ids, `${owner.nodeId} HTTP ${res.status}`);
        }
        const out = JSON.parse(text) as DispatchResponse;
        if (out.requestId !== requestId || out.nodeId !== owner.nodeId) throw new Error(`bad response identity from ${owner.nodeId}`);
        return out.pieces;
      } catch (e) {
        if (e instanceof ExpertUnavailable) throw e;
        throw new ExpertUnavailable(
          [...new Set(items.map((x) => x.expertId))],
          `${owner.nodeId} unavailable: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    });

    const responses = await Promise.all(calls); // any failed owner => NO output
    const byToken = Array.from({ length: tokens.length }, () => [] as ExpertPiece[]);
    for (const pieces of responses) for (const p of pieces) byToken[p.tokenIndex]!.push(p);
    const outputs = byToken.map((pieces, tokenIndex) => {
      if (pieces.length !== routes[tokenIndex]!.length) {
        throw new ExpertUnavailable(routes[tokenIndex]!.map((x) => x.expertId), `incomplete token ${tokenIndex}`);
      }
      return orderedReduce(pieces);
    });
    return {
      outputs, routes,
      telemetry: { rpcCount: groups.size, bytesOut, bytesIn, ownerBatchSizes, durationMs: performance.now() - t0 },
    };
  }

  /** Serial layers expose the same barrier structure as a transformer MoE. */
  async forwardLayers(token: number[], layers: number): Promise<{ output: number[]; durationMs: number; rpcCount: number }> {
    const t0 = performance.now();
    let x = [...token];
    let rpcCount = 0;
    for (let layer = 0; layer < layers; layer++) {
      const r = await this.forwardBatch([x]);
      // Stand-in for transformer RMS normalization: bound repeated tiny-layer
      // activations so the 92-barrier transport test cannot overflow.
      const raw = r.outputs[0]!;
      const scale = Math.max(1, Math.max(...raw.map((v) => Math.abs(v))) / 3);
      x = raw.map((v) => v / scale);
      rpcCount += r.telemetry.rpcCount;
    }
    return { output: x, durationMs: performance.now() - t0, rpcCount };
  }
}
