// Planner: deterministic placement over registry node rows. Fixtures model the real rig (M5 + two Legions);
// every assertion pins a rule of control/planner.ts against the measured envelope in control/profiles.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CTX, PlanError, loadProfiles, planDeployment, planDevices, validateProfile, type PlanInput } from "../planner.ts";
import type { NodeRow } from "../registry.ts";
import type { DeploymentSpec, GpuDevice, ModelFile, Offer } from "../../protocol/types.ts";

const profiles = loadProfiles();
const flash = profiles.get("flash-next-ud-q4kxl")!;
const tiny = profiles.get("qwen35-2b-q8")!;

const M5 = "a1b2c3d4e5f60001", L1 = "a1b2c3d4e5f60002", L2 = "a1b2c3d4e5f60003";
const MODELS = "/Volumes/models/flash-next";
const shard = (i: number): ModelFile => ({ name: `Qwen3.8-Flash-Next-UD-Q4_K_XL-0000${i}-of-00005.gguf`, path: `${MODELS}/Qwen3.8-Flash-Next-UD-Q4_K_XL-0000${i}-of-00005.gguf`, sizeBytes: 20_000_000_000, kind: "gguf" });
const MTP: ModelFile = { name: "Qwen3.8-Flash-Next-MTP-Q8_0.gguf", path: `${MODELS}/Qwen3.8-Flash-Next-MTP-Q8_0.gguf`, sizeBytes: 1_500_000_000, kind: "mtp" };
const TINY: ModelFile = { name: "Qwen3.5-2B-Q8_0.gguf", path: "/Volumes/models/Qwen3.5-2B-Q8_0.gguf", sizeBytes: 2_200_000_000, kind: "gguf" };
const T0 = "2026-09-04T00:00:00.000Z";

interface Fixture {
  id: string; hostname: string; os: "darwin" | "linux"; ramMiB: number; cpuCores: number; gpus: GpuDevice[]; offer: Offer;
  models?: ModelFile[]; rttMs?: number; online?: boolean;
}

function node(f: Fixture): NodeRow {
  const arch = f.os === "darwin" ? "arm64" : "x64";
  return {
    id: f.id, pubJwk: {}, certFp: `fp-${f.id}`, hostname: f.hostname, os: f.os, arch, enrolledAt: T0, lastSeen: T0,
    online: f.online ?? true, agentVersion: "0.1.0",
    caps: {
      os: f.os, arch, hostname: f.hostname, ramMiB: f.ramMiB, ramReserveMiB: f.os === "darwin" ? 12288 : 4096, cpuCores: f.cpuCores, gpus: f.gpus,
      diskFreeMiB: 500_000, privateIps: ["10.0.0.1"], measuredAt: T0, ...(f.rttMs !== undefined ? { net: { rttMs: f.rttMs, measuredAt: T0 } } : {}),
    },
    offer: f.offer, models: f.models ?? [], metrics: null,
  };
}

const metal: GpuDevice = { id: "metal:0", name: "Apple M5 Max", backend: "metal", engineName: "MTL0", totalMiB: 131072 };
const cuda = (name: string): GpuDevice => ({ id: "cuda:0", name, backend: "cuda", engineName: "CUDA0", totalMiB: 4096 });
const m5Offer = (ramMiB = 110000): Offer => ({ enabled: true, roles: { worker: false, coordinator: true, replica: true }, gpu: [{ id: "metal:0", memMiB: ramMiB }], ramMiB, cpuCores: 16, diskMiB: 2_000_000, modelsDir: "/Volumes/models" });
const legionOffer = (memMiB = 3700): Offer => ({ enabled: true, roles: { worker: true, coordinator: false, replica: false }, gpu: [{ id: "cuda:0", memMiB }], ramMiB: 8192, cpuCores: 12, diskMiB: 200_000, modelsDir: "/home/lotar/models" });

const m5 = (over: Partial<Fixture> = {}): NodeRow => node({ id: M5, hostname: "m5", os: "darwin", ramMiB: 131072, cpuCores: 16, gpus: [metal], offer: m5Offer(), models: [shard(1), shard(2), shard(3), shard(4), shard(5), MTP, TINY], rttMs: 1, ...over });
const legion1 = (over: Partial<Fixture> = {}): NodeRow => node({ id: L1, hostname: "legion1", os: "linux", ramMiB: 16384, cpuCores: 12, gpus: [cuda("GTX 1650 Ti")], offer: legionOffer(), rttMs: 12, ...over });
const legion2 = (over: Partial<Fixture> = {}): NodeRow => node({ id: L2, hostname: "legion2", os: "linux", ramMiB: 16384, cpuCores: 12, gpus: [cuda("GTX 1650")], offer: legionOffer(), rttMs: 15, ...over });

const rig = (): NodeRow[] => [m5(), legion1(), legion2()];
const spec = (over: Partial<DeploymentSpec> = {}): DeploymentSpec => ({ name: "t", profile: flash.id, kind: "split", ctx: 1536, parallel: 3, chain: 4, ...over });
const input = (over: Partial<PlanInput> = {}): PlanInput => ({ spec: spec(), profile: flash, nodes: rig(), usedPorts: new Map(), ...over });
const plan = (over: Partial<PlanInput> = {}) => planDeployment(input(over));
function refused(over: Partial<PlanInput>): PlanError {
  try { planDeployment(input(over)); } catch (e) { expect(e).toBeInstanceOf(PlanError); return e as PlanError; }
  throw new Error("expected a PlanError");
}
const text = (e: PlanError): string => e.reasons.join("\n");

describe("profiles", () => {
  test("the shipped profiles load with the measured envelope", () => {
    expect([...profiles.keys()].sort()).toEqual(["flash-next-ud-q4kxl", "qwen35-2b-q8", "qwen36-35b-a3b-q4km"]);
    expect(flash).toMatchObject({ modelName: "qwen3.8-flash-next", layers: 48, layerMiB: 1608, coordinatorHostMiB: 32768, boundaryBytes: 81920, workerMarginMiB: 1536 });
    expect(flash.envelope).toEqual([{ workerLayers: 1, maxCtx: 1536, maxParallel: 3, maxChain: 8 }, { workerLayers: 1, maxCtx: 1536, maxParallel: 1, maxChain: 12 }]);
    expect(flash.extraArgs).toEqual(["-ot", "ple_ngram_embd=CPU", "-fa", "on", "--cache-ram", "0", "--ctx-checkpoints", "0"]);
    expect(new RegExp(flash.ggufPattern).test(shard(1).name)).toBe(true);
    expect(new RegExp(flash.ggufPattern).test(shard(2).name)).toBe(false);
    expect(new RegExp(flash.mtpPattern!).test(MTP.name)).toBe(true);
    expect(new RegExp(tiny.ggufPattern).test(TINY.name)).toBe(true);
    expect(tiny.mtpPattern).toBeUndefined();
    const big = profiles.get("qwen36-35b-a3b-q4km")!;
    expect(new RegExp(big.ggufPattern).test("Qwen3.6-35B-A3B-Q4_K_M.gguf")).toBe(true);
    expect(new RegExp(big.ggufPattern).test("Qwen3.6-35B-A3B-UD-IQ2_XXS.gguf")).toBe(false);
    expect(big).toMatchObject({ layers: 40, layerMiB: 512, envelope: [{ workerLayers: 4, maxCtx: 2048, maxParallel: 4, maxChain: 7 }] });
  });

  test("a profile with an unknown key, a bad number, a bad pattern or a mismatched id is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarmlet-profiles-"));
    const file = join(dir, "flash-next-ud-q4kxl.json");
    writeFileSync(file, JSON.stringify({ ...flash, _comment: "not allowed" }));
    expect(() => loadProfiles(dir)).toThrow(/unknown key "_comment"/);
    writeFileSync(file, JSON.stringify({ ...flash, layerMiB: 1.5 }));
    expect(() => loadProfiles(dir)).toThrow(/"layerMiB" must be an integer/);
    writeFileSync(file, JSON.stringify({ ...flash, id: "other" }));
    expect(() => loadProfiles(dir)).toThrow(/must equal the file name/);
    writeFileSync(file, "{ not json");
    expect(() => loadProfiles(dir)).toThrow(/profile .*flash-next-ud-q4kxl\.json/);
    writeFileSync(file, JSON.stringify(flash));
    expect(loadProfiles(dir).get(flash.id)).toEqual(flash);
    expect(() => validateProfile({ ...flash, ggufPattern: "(" })).toThrow(/"ggufPattern" is not a valid RegExp/);
    expect(() => validateProfile({ ...flash, envelope: [] })).toThrow(/"envelope" must be a non-empty array/);
    expect(() => validateProfile({ ...flash, envelope: [{ workerLayers: 48, maxCtx: 1, maxParallel: 1, maxChain: 0 }] })).toThrow(/must be below layers 48/);
    expect(() => validateProfile({ ...flash, envelope: [{ workerLayers: 1, maxCtx: 1, maxParallel: 1, maxChain: 0, note: "x" }] })).toThrow(/envelope\[0\]: unknown key "note"/);
    expect(() => validateProfile({ ...flash, extraArgs: ["-fa", 1] })).toThrow(/"extraArgs" must be an array of strings/);
    expect(() => validateProfile("nope")).toThrow(/must be a JSON object/);
  });
});

describe("split placement on the real rig", () => {
  test("Flash-Next at ctx 1536, parallel 3, chain 4: tensor split 1,1,46 over RPC0,RPC1,MTL0", () => {
    const p = plan();
    expect(p.coordinatorNodeId).toBe(M5);
    expect(p.coordinatorDevice).toBe("MTL0");
    expect(p.tensorSplit).toEqual([1, 1, 46]);
    expect(planDevices(p)).toEqual(["RPC0", "RPC1", "MTL0"]);
    expect(p.workers.map((w) => w.nodeId)).toEqual([L1, L2]);
    expect(p.workers[0]).toEqual({ nodeId: L1, device: "CUDA0", layers: 1, port: 50200, peerPort: 50201, threads: 10, memCapMiB: 3700 });
    expect(p.workers[1]).toEqual({ nodeId: L2, device: "CUDA0", layers: 1, port: 50200, peerPort: 50201, threads: 10, memCapMiB: 3700 });
    expect(p.env).toEqual({ GGML_RPC_FORWARD: "1", GGML_RPC_PIPELINE: "1", GGML_SCHED_PIPELINED_COPY: "1", GGML_RPC_GET_PIPELINE: "1", GGML_RPC_WIRE: "off" });
    expect(p.mtpPath).toBe(MTP.path);
    expect(p.modelPath).toBe(shard(1).path);
    expect(p).toMatchObject({ ctx: 1536, parallel: 3, chain: 4 });
    const why = p.reasons.join("\n");
    expect(why).toMatch(/Coordinator m5: largest RAM offer \(110000 MiB\)/);
    expect(why).toMatch(/RPC0 legion1 \(12 ms\), RPC1 legion2 \(15 ms\)/);
    expect(why).toMatch(/row workerLayers 1 \(maxCtx 1536, maxParallel 3, maxChain 8\) fits/);
    expect(why).toMatch(/keeps 46 of 48 layers on MTL0: 46 × 1608 \+ 32768 MiB host = 106736 MiB of 110000 MiB/);
    expect(why).toMatch(/draft head Qwen3\.8-Flash-Next-MTP-Q8_0\.gguf on m5/);
    expect(why).toMatch(/81920 bytes per token/);
  });

  test("chain 10 at parallel 3 is outside every row; the refusal names maxChain and the per-worker ceiling", () => {
    const e = refused({ spec: spec({ chain: 10 }) });
    expect(e.message).toMatch(/maxChain/);
    expect(text(e)).toMatch(/No envelope row of profile flash-next-ud-q4kxl fits ctx 1536, parallel 3, chain 10/);
    expect(text(e)).toMatch(/\(maxCtx 1536, maxParallel 3, maxChain 8\): chain 10 > maxChain 8/);
    expect(text(e)).toMatch(/\(maxCtx 1536, maxParallel 1, maxChain 12\): parallel 3 > maxParallel 1/);
    expect(text(e)).toMatch(/legion1: 3700 MiB offered on CUDA0 allows at most 1 layer/);
    expect(text(e)).toMatch(/legion2: 3700 MiB offered on CUDA0 allows at most 1 layer/);
    expect(() => plan({ spec: spec({ chain: 10 }) })).toThrow(PlanError);
  });

  test("parallel 1 chain 12 fits the second row", () => {
    const p = plan({ spec: spec({ parallel: 1, chain: 12 }) });
    expect(p.tensorSplit).toEqual([1, 1, 46]);
    expect(p).toMatchObject({ parallel: 1, chain: 12, mtpPath: MTP.path });
    expect(p.reasons.join("\n")).toMatch(/maxChain 12\) fits ctx 1536, parallel 1, chain 12/);
  });

  test("ctx above the envelope is refused, never clamped", () => {
    const e = refused({ spec: spec({ ctx: 2048 }) });
    expect(text(e)).toMatch(/ctx 2048 > maxCtx 1536/);
  });

  test("a 1000 MiB worker offer is refused with the per-worker reason", () => {
    const e = refused({ nodes: [m5(), legion1({ offer: legionOffer(1000) }), legion2()] });
    expect(text(e)).toMatch(/legion1: 1000 MiB offered on CUDA0 allows at most 0 layer\(s\) of 1608 MiB after the 1536 MiB margin/);
    expect(text(e)).toMatch(/legion1 needs 3144 MiB for 1 layers but offers 1000 MiB on CUDA0/);
    expect(text(e)).toMatch(/legion2: 3700 MiB offered on CUDA0 allows at most 1 layer/);
  });

  test("chain > 0 without the draft head on the coordinator is refused", () => {
    const e = refused({ nodes: [m5({ models: [shard(1), shard(2), shard(3), shard(4), shard(5)] }), legion1(), legion2()] });
    expect(e.message).toMatch(/chain 4 needs a draft head matching .* on m5; none of its 5 model files match/);
    const p = plan({ spec: spec({ chain: 0 }), nodes: [m5({ models: [shard(1)] }), legion1(), legion2()] });
    expect(p.mtpPath).toBeUndefined();
    expect(p.chain).toBe(0);
  });

  test("used ports move a worker to the next free step (rpc and peer port both checked)", () => {
    const p = plan({ usedPorts: new Map([[L1, new Set([50200])], [L2, new Set([50201])]]) });
    expect(p.workers.map((w) => [w.port, w.peerPort])).toEqual([[50210, 50211], [50210, 50211]]);
    expect(plan({ usedPorts: new Map([[L1, new Set([50200, 50210, 50221])]]) }).workers[0]!.port).toBe(50230);
  });

  test("same input, same plan; the order of the node rows does not matter", () => {
    const a = plan();
    expect(plan()).toEqual(a);
    expect(plan({ nodes: rig().reverse() })).toEqual(a);
    expect(JSON.stringify(plan())).toBe(JSON.stringify(a));
  });

  test("workers follow RTT then hostname; an unmeasured RTT sorts last", () => {
    expect(plan({ nodes: [m5(), legion1({ rttMs: 40 }), legion2()] }).workers.map((w) => w.nodeId)).toEqual([L2, L1]);
    expect(plan({ nodes: [m5(), legion1({ rttMs: undefined }), legion2()] }).workers.map((w) => w.nodeId)).toEqual([L2, L1]);
    expect(plan({ nodes: [m5(), legion1({ rttMs: 15 }), legion2()] }).workers.map((w) => w.nodeId)).toEqual([L1, L2]);
  });

  test("explicit worker ids keep their order and are validated one by one", () => {
    const p = plan({ spec: spec({ workerNodeIds: [L2, L1] }) });
    expect(p.workers.map((w) => w.nodeId)).toEqual([L2, L1]);
    expect(p.reasons.join("\n")).toMatch(/RPC0 legion2, RPC1 legion1/);
    const e = refused({ spec: spec({ workerNodeIds: [L1, "ffffffffffffffff", M5, L1] }) });
    expect(text(e)).toMatch(/Requested worker node ffffffffffffffff is not enrolled/);
    expect(text(e)).toMatch(/m5 is the coordinator and cannot also be a worker/);
    expect(text(e)).toMatch(/is listed twice/);
    expect(e.reasons).toHaveLength(3);
    const bad = refused({ spec: spec({ workerNodeIds: [L1, L2] }), nodes: [m5(), legion1({ online: false }), legion2({ offer: { ...legionOffer(), enabled: false } })] });
    expect(text(bad)).toMatch(/Requested worker node legion1 is offline/);
    expect(text(bad)).toMatch(/Requested worker node legion2 has its offer disabled/);
    const noGpu = refused({ spec: spec({ workerNodeIds: [L1] }), nodes: [m5(), legion1({ offer: { ...legionOffer(), gpu: [] } })] });
    expect(text(noGpu)).toMatch(/legion1 offers no GPU memory/);
  });

  test("offline or disabled nodes are skipped; one worker means no forwarding and no peer port", () => {
    const p = plan({ nodes: [m5(), legion1(), legion2({ online: false })] });
    expect(p.tensorSplit).toEqual([1, 47]);
    expect(p.workers).toHaveLength(1);
    expect(p.workers[0]!.peerPort).toBeUndefined();
    expect(p.env.GGML_RPC_FORWARD).toBe("0");
    expect(plan({ nodes: [m5(), legion1(), legion2({ offer: { ...legionOffer(), enabled: false } })] }).workers).toHaveLength(1);
    const none = refused({ nodes: [m5(), legion1({ online: false }), legion2({ online: false })] });
    expect(none.message).toMatch(/A split needs at least one worker; use kind replica/);
  });

  test("spec toggles: forwarding, batched GETs, wire", () => {
    const p = plan({ spec: spec({ forwarding: false, batchedGets: false, wire: "q8" }) });
    expect(p.env).toEqual({ GGML_RPC_FORWARD: "0", GGML_RPC_PIPELINE: "1", GGML_SCHED_PIPELINED_COPY: "1", GGML_RPC_GET_PIPELINE: "0", GGML_RPC_WIRE: "q8" });
    expect(p.workers.every((w) => w.peerPort === undefined)).toBe(true);
    expect(p.reasons.join("\n")).toMatch(/Wire compression q8 by request/);
    expect(plan({ spec: spec({ wire: "f16" }) }).env.GGML_RPC_WIRE).toBe("f16");
    expect(refused({ spec: spec({ wire: "f32" as "f16" }) }).message).toMatch(/wire must be off, f16 or q8/);
  });

  test("the coordinator must hold the remaining layers plus the host-side residency", () => {
    const e = refused({ nodes: [m5({ offer: m5Offer(100000) }), legion1(), legion2()] });
    expect(text(e)).toMatch(/Coordinator m5 cannot hold 46 of 48 layers: 46 × 1608 \+ 32768 MiB host = 106736 MiB exceeds the 100000 MiB RAM offered/);
  });

  test("coordinator choice: a requested id is validated, the default is the largest RAM offer holding the model", () => {
    const e = refused({ spec: spec({ coordinatorNodeId: L1 }) });
    expect(text(e)).toMatch(/Requested coordinator node legion1 does not offer the coordinator role, holds no model matching/);
    expect(refused({ spec: spec({ coordinatorNodeId: "0000000000000000" }) }).message).toMatch(/coordinator node 0000000000000000 is not enrolled/);
    const big = m5({ id: "a1b2c3d4e5f60009", hostname: "m5-big", offer: m5Offer(120000) });
    expect(plan({ nodes: [m5(), big, legion1(), legion2()] }).coordinatorNodeId).toBe(big.id);
    expect(plan({ nodes: [big, m5(), legion1(), legion2()] }).coordinatorNodeId).toBe(big.id);
    expect(plan({ spec: spec({ coordinatorNodeId: M5 }), nodes: [m5(), big, legion1(), legion2()] }).coordinatorNodeId).toBe(M5);
    expect(refused({ nodes: [legion1(), legion2()] }).message).toMatch(/No online node offers the coordinator role/);
  });

  test("defaults: ctx 1536, parallel 1, chain 0; bad numbers are refused", () => {
    const p = plan({ spec: { name: "d", profile: flash.id, kind: "split" } });
    expect(p).toMatchObject({ ctx: DEFAULT_CTX, parallel: 1, chain: 0 });
    expect(p.mtpPath).toBeUndefined();
    expect(p.reasons[0]).toMatch(/ctx 1536 \(default\), parallel 1 \(default\), chain 0 \(default\)/);
    expect(refused({ spec: spec({ ctx: 0 }) }).message).toMatch(/ctx must be a positive integer/);
    expect(refused({ spec: spec({ parallel: 1.5 }) }).message).toMatch(/parallel must be a positive integer/);
    expect(refused({ spec: spec({ chain: -1 }) }).message).toMatch(/chain must be an integer >= 0/);
  });

  test("the 2B rig profile puts 3 layers per 4 GB worker at ctx 2048, parallel 4", () => {
    const p = plan({ spec: { name: "rig", profile: tiny.id, kind: "split", ctx: 2048, parallel: 4 }, profile: tiny });
    expect(p.tensorSplit).toEqual([3, 3, 18]);
    expect(p.modelPath).toBe(TINY.path);
    expect(p.workers[0]).toMatchObject({ layers: 3, memCapMiB: 3700, threads: 10 });
    expect(refused({ spec: { name: "rig", profile: tiny.id, kind: "split", chain: 1 }, profile: tiny }).message).toMatch(/profile qwen35-2b-q8 has no mtpPattern/);
  });

  test("a row that leaves the coordinator no layer is skipped for the next one", () => {
    const eight = Array.from({ length: 8 }, (_, i) => legion1({ id: `a1b2c3d4e5f6001${i}`, hostname: `w${i}`, rttMs: 10 + i }));
    const p = plan({ spec: { name: "rig", profile: tiny.id, kind: "split", ctx: 2048 }, profile: tiny, nodes: [m5(), ...eight] });
    expect(p.tensorSplit).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 8]);
    expect(planDevices(p)).toEqual(["RPC0", "RPC1", "RPC2", "RPC3", "RPC4", "RPC5", "RPC6", "RPC7", "MTL0"]);
    expect(p.reasons.join("\n")).toMatch(/8 workers × 3 layers leave the coordinator none of the 24 layers/);
  });

  test("a linux coordinator checks layers against its GPU offer and the host part against RAM", () => {
    const coord = legion1({ id: "a1b2c3d4e5f60020", hostname: "legion0", offer: { ...legionOffer(), roles: { worker: false, coordinator: true, replica: false } }, models: [TINY] });
    const p = plan({ spec: { name: "rig", profile: tiny.id, kind: "split" }, profile: tiny, nodes: [coord, legion1(), legion2()] });
    expect(p.coordinatorNodeId).toBe(coord.id);
    expect(p.coordinatorDevice).toBe("CUDA0");
    expect(p.tensorSplit).toEqual([3, 3, 18]);
    expect(p.reasons.join("\n")).toMatch(/keeps 18 of 24 layers on CUDA0: 18 × 80 = 1440 MiB of 3700 MiB GPU offered/);
    const e = refused({ spec: { name: "rig", profile: tiny.id, kind: "split" }, profile: tiny, nodes: [{ ...coord, offer: { ...coord.offer!, gpu: [{ id: "cuda:0", memMiB: 1000 }], ramMiB: 512 } }, legion1(), legion2()] });
    expect(text(e)).toMatch(/cannot hold 18 of 24 layers: 18 × 80 = 1440 MiB exceeds the 1000 MiB GPU offered on CUDA0/);
    expect(text(e)).toMatch(/host side: 1024 MiB exceeds the 512 MiB RAM offered/);
  });
});

describe("replica placement", () => {
  test("replica kind plans the whole model on the M5 with an empty tensor split", () => {
    const p = plan({ spec: spec({ kind: "replica", chain: 0, parallel: 2 }) });
    expect(p).toMatchObject({ coordinatorNodeId: M5, coordinatorDevice: "MTL0", workers: [], tensorSplit: [], ctx: 1536, parallel: 2, chain: 0, modelPath: shard(1).path });
    expect(p.mtpPath).toBeUndefined();
    expect(planDevices(p)).toEqual(["MTL0"]);
    expect(p.env.GGML_RPC_FORWARD).toBe("0");
    expect(p.reasons.join("\n")).toMatch(/Replica m5 keeps 48 of 48 layers on MTL0: 48 × 1608 \+ 32768 MiB host = 109952 MiB of 110000 MiB/);
    expect(plan({ spec: spec({ kind: "replica", chain: 0 }) })).toEqual(plan({ spec: spec({ kind: "replica", chain: 0 }), nodes: rig().reverse() }));
  });

  test("replica: requested node validated, memory checked, draft head required for chain > 0", () => {
    expect(text(refused({ spec: spec({ kind: "replica", replicaNodeId: L1 }) }))).toMatch(/Requested replica node legion1 does not offer the replica role, holds no model matching/);
    expect(plan({ spec: spec({ kind: "replica", chain: 0, replicaNodeId: M5 }) }).coordinatorNodeId).toBe(M5);
    const e = refused({ spec: spec({ kind: "replica", chain: 0 }), nodes: [m5({ offer: m5Offer(100000) })] });
    expect(text(e)).toMatch(/Replica m5 cannot hold 48 of 48 layers: 48 × 1608 \+ 32768 MiB host = 109952 MiB exceeds the 100000 MiB RAM offered/);
    expect(plan({ spec: spec({ kind: "replica", chain: 4 }) })).toMatchObject({ chain: 4, mtpPath: MTP.path });
    expect(refused({ spec: spec({ kind: "replica", chain: 4 }), nodes: [m5({ models: [shard(1)] })] }).message).toMatch(/needs a draft head matching/);
    expect(refused({ spec: spec({ kind: "replica" }), nodes: [] }).message).toMatch(/No online node offers the replica role/);
    expect(refused({ spec: spec({ kind: "replica" }), nodes: [m5({ online: false }), legion1()] }).message).toMatch(/No online node offers the replica role/);
  });

  test("a linux replica keeps the layers on its GPU offer", () => {
    const leg = legion1({ offer: { ...legionOffer(), roles: { worker: true, coordinator: false, replica: true } }, models: [TINY] });
    const p = plan({ spec: { name: "r", profile: tiny.id, kind: "replica" }, profile: tiny, nodes: [leg, legion2()] });
    expect(p).toMatchObject({ coordinatorNodeId: L1, coordinatorDevice: "CUDA0", tensorSplit: [], modelPath: TINY.path });
    expect(p.reasons.join("\n")).toMatch(/keeps 24 of 24 layers on CUDA0: 24 × 80 = 1920 MiB of 3700 MiB GPU offered/);
  });

  test("kind external is not planned", () => {
    expect(refused({ spec: spec({ kind: "external" }) }).message).toMatch(/kind "external" is not placed by the planner/);
  });
});
