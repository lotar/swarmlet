// Invariants of the SHIPPED profiles, derived from the profiles themselves.
//
// Why this file exists: the suite used to hardcode envelope numbers, so when the profiles were pruned the
// tests kept asserting the old ladders and the release gate (which runs this suite) could not pass. A test
// that cannot drift silently is worth more than one that pins today's digits. Everything here reads the
// profiles from disk and asks whether what they declare is something the planner can actually deliver.
//
// It is also how the "35B declares maxChain 7 with no draft head" finding stays fixed: the planner refuses
// chain > 0 for a profile without an mtpPattern, so a row that advertises a chain advertises something
// unreachable.
import { expect, test } from "bun:test";
import { loadProfiles, planDeployment, PlanError } from "../planner.ts";
import type { NodeRow } from "../registry.ts";

/** The profile type as the planner sees it; the module does not export it by name. */
type ModelProfile = Parameters<typeof planDeployment>[0]["profile"];

const profiles = loadProfiles();

/** This fixture always sets an offer (a node with none cannot hold anything). */
type Offered = NodeRow & { offer: NonNullable<NodeRow["offer"]> };
const T0 = "2026-09-16T00:00:00.000Z";

/** A file name the given pattern accepts: the shipped patterns are literals (all four are), so unescaping the
 *  regex is enough - and deriving it means the fixture can never disagree with the profile it is testing. */
function nameFor(pattern: string): string {
  return pattern.replace(/^\^/, "").replace(/\$$/, "").split("|")[0]!.replace(/\\(.)/g, "$1");
}

/** A node that holds this profile's weights and is big enough on paper, so a refusal can only be about the
 *  row itself rather than about the hardware the row was written for. */
function holder(profile: ModelProfile, hostMiB: number): Offered {
  const gpu = { id: "metal:0", name: "test", backend: "metal" as const, engineName: "MTL0", totalMiB: hostMiB };
  return {
    id: "1111111111111111", pubJwk: {}, certFp: "fp", hostname: "holder", os: "darwin", arch: "arm64",
    enrolledAt: T0, lastSeen: T0, online: true, agentVersion: "0.1.0",
    caps: { os: "darwin", arch: "arm64", hostname: "holder", ramMiB: 131072, ramReserveMiB: 4096, cpuCores: 16,
      gpus: [gpu], diskFreeMiB: 500_000, privateIps: ["10.0.0.1"], measuredAt: T0 },
    offer: { enabled: true, roles: { worker: true, coordinator: true, replica: true }, gpu: [{ id: "metal:0", memMiB: hostMiB }],
      ramMiB: 131072, cpuCores: 16, diskMiB: 500_000, modelsDir: "/models" },
    models: [
      { name: nameFor(profile.ggufPattern), path: "/models/model.gguf", sizeBytes: 1_000_000_000, kind: "gguf" },
      ...(profile.mtpPattern ? [{ name: nameFor(profile.mtpPattern), path: "/models/mtp.gguf", sizeBytes: 1_000_000_000, kind: "mtp" as const }] : []),
    ],
    metrics: null,
  } as unknown as Offered;
}

test("every shipped profile declares a positive rank, and the ranks order the automatic choice", () => {
  const ranks: number[] = [];
  for (const [id, p] of profiles) {
    expect(typeof p.rank, `${id} declares a rank`).toBe("number");
    ranks.push(p.rank!);
  }
  expect(new Set(ranks).size, "ranks are distinct so the automatic choice is deterministic").toBe(ranks.length);
});

test("a row that advertises a chain has a draft head to chain with", () => {
  for (const [id, p] of profiles) {
    for (const row of p.envelope) {
      if (row.maxChain > 0) {
        // chain > 0 without an mtpPattern is refused by draftHead(), so the row would be unreachable data.
        expect(Boolean(p.mtpPattern), `${id}: row maxChain ${row.maxChain} needs an mtpPattern`).toBe(true);
      }
    }
  }
});

test("every shipped row is placeable as a split, at the row's own context and parallelism", () => {
  // Rows are split rows (workerLayers), so that is the shape a row must be able to deliver. Chain stays 0
  // here on purpose: whether a chain can be served is a separate rule, asserted below by name.
  for (const [id, p] of profiles) {
    for (const row of p.envelope) {
      const hostMiB = p.layers * p.layerMiB + p.coordinatorHostMiB + 4096;
      const workerMiB = row.workerLayers * p.layerMiB + (p.workerMarginMiB ?? 1536);
      const node = holder(p, hostMiB);
      node.offer.gpu = [{ id: "metal:0", memMiB: hostMiB }];
      const worker: Offered = { ...node, id: "2222222222222222", hostname: "worker",
        offer: { ...node.offer, gpu: [{ id: "metal:0", memMiB: workerMiB + 1024 }] } };
      const spec = { name: "t", profile: p.id, kind: "split" as const, ctx: row.maxCtx, parallel: 1, chain: 0, workerNodeIds: [worker.id], workerLayers: [row.workerLayers] };
      try {
        const plan = planDeployment({ spec, profile: p, nodes: [node, worker], usedPorts: new Map() });
        expect(plan.ctx).toBe(row.maxCtx);                       // never silently clamped
        expect(plan.workers[0]!.layers).toBe(row.workerLayers);
      } catch (e) {
        const err = e as PlanError;
        throw new Error(`${id}: row ${JSON.stringify(row)} is advertised but not placeable: ${err.message}\n  ${(err.reasons ?? []).join("\n  ")}`);
      }
    }
  }
});

test("a chain request is refused by name when the draft head is not qualified, never half-served", () => {
  // The shipped controller qualification list is empty until the real rig proof succeeds, so every chain > 0
  // must fail with a reason that says which rule stopped it - not with a planner crash or a silent clamp.
  for (const [id, p] of profiles) {
    for (const row of p.envelope) {
      if (row.maxChain === 0) continue;
      const hostMiB = p.layers * p.layerMiB + p.coordinatorHostMiB + 4096;
      const node = holder(p, hostMiB);
      const spec = { name: "t", profile: p.id, kind: "replica" as const, ctx: row.maxCtx, parallel: 1, chain: row.maxChain };
      let refused: PlanError | null = null;
      try { planDeployment({ spec, profile: p, nodes: [node], usedPorts: new Map() }); }
      catch (e) { refused = e as PlanError; }
      expect(refused, `${id}: a replica with chain ${row.maxChain} must be refused until MTP is qualified`).not.toBeNull();
      expect(refused!.message + (refused!.reasons ?? []).join(" ")).toMatch(/MTP is not qualified|needs a draft head/);
    }
  }
});
