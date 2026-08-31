import { readFileSync } from "node:fs";
import type { PlacementOwner, PlacementPlan } from "./protocol.ts";
import { EXPERT_COUNT } from "./math.ts";
import { MODEL_ID, PROTOCOL_VERSION } from "./protocol.ts";

const HEX64 = /^[0-9a-f]{64}$/;
function canonicalPlanBody(owners: readonly PlacementOwner[], modelId = MODEL_ID): object {
  return {
    schemaVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    modelId,
    owners: [...owners]
      .map((o) => ({ nodeId: o.nodeId, expertIds: [...o.expertIds].sort((a, b) => a - b), fixtureSha256: o.fixtureSha256 }))
      .sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0),
  };
}
export function placementEpoch(owners: readonly PlacementOwner[], modelId = MODEL_ID): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(canonicalPlanBody(owners, modelId))).digest("hex");
}
export function validatePlacementPlan(input: unknown): PlacementPlan {
  if (!input || typeof input !== "object") throw new Error("placement plan must be an object");
  const p = input as Partial<PlacementPlan>;
  if (p.schemaVersion !== 1 || p.protocolVersion !== PROTOCOL_VERSION || p.modelId !== MODEL_ID || !Array.isArray(p.owners)) throw new Error("unsupported placement plan");
  if (p.owners.length < 2) throw new Error("placement requires at least two owners");
  const nodeIds = new Set<string>(); const experts = new Set<number>();
  for (const owner of p.owners) {
    if (!owner || typeof owner.nodeId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(owner.nodeId)) throw new Error("invalid placement nodeId");
    if (nodeIds.has(owner.nodeId)) throw new Error(`duplicate owner ${owner.nodeId}`); nodeIds.add(owner.nodeId);
    if (!Array.isArray(owner.expertIds) || owner.expertIds.length === 0 || !HEX64.test(owner.fixtureSha256)) throw new Error(`invalid owner ${owner.nodeId}`);
    if (owner.expertIds.some((id, i) => i > 0 && owner.expertIds[i - 1]! >= id)) throw new Error(`expertIds must be strictly ascending for ${owner.nodeId}`);
    const local = new Set<number>();
    for (const id of owner.expertIds) {
      if (!Number.isInteger(id) || id < 0 || id >= EXPERT_COUNT || local.has(id)) throw new Error(`invalid expert ${id} for ${owner.nodeId}`);
      if (experts.has(id)) throw new Error(`expert ${id} has multiple owners`); local.add(id); experts.add(id);
    }
  }
  if (experts.size !== EXPERT_COUNT || [...Array(EXPERT_COUNT).keys()].some((id) => !experts.has(id))) throw new Error("placement does not cover every expert exactly once");
  const expected = placementEpoch(p.owners, p.modelId);
  if (!HEX64.test(p.placementEpoch ?? "") || p.placementEpoch !== expected) throw new Error("placement epoch mismatch");
  return JSON.parse(JSON.stringify({ ...canonicalPlanBody(p.owners, p.modelId), placementEpoch: expected })) as PlacementPlan;
}
export function loadPlacementPlan(path: string): PlacementPlan {
  return validatePlacementPlan(JSON.parse(readFileSync(path, "utf8")));
}
