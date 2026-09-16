// Planner: deterministic placement over registry node rows. Fixtures model the real rig (M5 + two Legions);
// every assertion pins a rule of control/planner.ts against the measured envelope in control/profiles.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CTX, PlanError, loadProfiles, planDeployment, planDevices, validateProfile, type PlanInput } from "../planner.ts";
import type { NodeRow } from "../registry.ts";
import type { DeploymentSpec, GpuDevice, ModelFile, Offer } from "../../protocol/types.ts";
import type { Qwen35NativeQualification } from "../profiles/qwen35-native.ts";

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
  id: string; hostname: string; os: "darwin" | "linux" | "win32"; ramMiB: number; cpuCores: number; gpus: GpuDevice[]; offer: Offer;
  models?: ModelFile[]; rttMs?: number; online?: boolean;
}

function node(f: Fixture): NodeRow {
  const arch = f.os === "darwin" ? "arm64" : "x64";
  return {
    id: f.id, pubJwk: {}, certFp: `fp-${f.id}`, hostname: f.hostname, os: f.os, arch, enrolledAt: T0, lastSeen: T0,
    online: f.online ?? true, agentVersion: "0.1.0",
    caps: {
      os: f.os, arch, hostname: f.hostname, ramMiB: f.ramMiB, ramReserveMiB: f.os === "darwin" ? 12288 : f.os === "win32" ? 6144 : 4096, cpuCores: f.cpuCores, gpus: f.gpus,
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
const spec = (over: Partial<DeploymentSpec> = {}): DeploymentSpec => ({ name: "t", profile: flash.id, kind: "split", ctx: 1536, parallel: 3, chain: 0, ...over });
const input = (over: Partial<PlanInput> = {}): PlanInput => ({ spec: spec(), profile: flash, nodes: rig(), usedPorts: new Map(), ...over });
const plan = (over: Partial<PlanInput> = {}) => planDeployment(input(over));
function refused(over: Partial<PlanInput>): PlanError {
  try { planDeployment(input(over)); } catch (e) { expect(e).toBeInstanceOf(PlanError); return e as PlanError; }
  throw new Error("expected a PlanError");
}
const text = (e: PlanError): string => e.reasons.join("\n");

describe("profiles", () => {
  test("the shipped profiles load with the measured envelope", () => {
    expect([...profiles.keys()].sort()).toEqual(["flash-next-ud-q4kxl", "qwen35-2b-q8", "qwen36-35b-a3b-q4km", "qwen38-27b-q8"]);
    expect(flash).toMatchObject({ modelName: "qwen3.8-flash-next", layers: 48, layerMiB: 1608, coordinatorHostMiB: 32768, boundaryBytes: 81920, workerMarginMiB: 1536 });
    // The envelope is what the rig can place, not a wish list: one layer per worker, the context the model
      // was measured at, and NO chain - no MTP head is qualified for Flash-Next yet, so a speculative request
      // has to be refused rather than half-served. (The draft-head path is exercised through a chain-capable
      // clone of this profile below, and through the shipped 27B rows, which do allow a chain.)
      expect(flash.envelope).toEqual([{ workerLayers: 1, maxCtx: 262144, maxParallel: 3, maxChain: 0 }, { workerLayers: 1, maxCtx: 262144, maxParallel: 1, maxChain: 0 }]);
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

  test("the 27B profile declares where its weights come from, and the names match what the planner matches on", () => {
    const q = profiles.get("qwen38-27b-q8")!;
    expect(q).toMatchObject({ modelName: "qwen3.8-27b", layers: 64, layerMiB: 389 });
    // A sweep ladder, not a set of measured configurations: these rows exist so a size can be
    // requested and measured (see the 27B sweep in the profile README). Rows measured to FAIL on a
    // 32 GB worker (35, 42) are expected to be pruned once the ladder has served its purpose.
    expect(q.envelope.map((r) => r.workerLayers)).toEqual([5, 6, 8, 10, 12, 15, 20, 25, 30]);
    for (const row of q.envelope) expect(row.maxCtx).toBe(262144);
    // The load-bearing invariant: a downloaded file satisfies exactly the pattern the planner uses
    // to find that model on a node. If this drifts, a node fetches 28 GB the planner then ignores.
    const dl = q.download!.files;
    expect(dl.map(f => f.kind).sort()).toEqual(["gguf", "mtp"]);
    for (const f of dl) {
      const re = new RegExp(f.kind === "gguf" ? q.ggufPattern : q.mtpPattern!);
      expect(re.test(f.name)).toBe(true);
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.bytes).toBeGreaterThan(0);
    }
    // A profile that declares no source simply has no download block (never an empty one).
    expect(profiles.get("qwen35-2b-q8")!.download).toBeUndefined();
  });

  test("a download block that does not line up with the profile patterns is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarmlet-dl-"));
    const file = join(dir, "flash-next-ud-q4kxl.json");
    const good = { name: "Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00005.gguf", kind: "gguf", url: "https://example.invalid/a.gguf", sha256: "a".repeat(64), bytes: 1 };
    writeFileSync(file, JSON.stringify({ ...flash, download: { files: [good] } }));
    expect(loadProfiles(dir).get("flash-next-ud-q4kxl")!.download!.files).toHaveLength(1);
    // A name the planner would never match on that node: refused, not silently accepted.
    writeFileSync(file, JSON.stringify({ ...flash, download: { files: [{ ...good, name: "something-else.gguf" }] } }));
    expect(() => loadProfiles(dir)).toThrow(/does not match ggufPattern/);
    writeFileSync(file, JSON.stringify({ ...flash, download: { files: [{ ...good, url: "http://example.invalid/a.gguf" }] } }));
    expect(() => loadProfiles(dir)).toThrow(/must be https/);
    writeFileSync(file, JSON.stringify({ ...flash, download: { files: [{ ...good, sha256: "XYZ" }] } }));
    expect(() => loadProfiles(dir)).toThrow(/64 lowercase hex/);
    writeFileSync(file, JSON.stringify({ ...flash, download: { files: [{ ...good, kind: "mmproj" }] } }));
    expect(() => loadProfiles(dir)).toThrow(/"kind" must be "gguf" or "mtp"/);
    writeFileSync(file, JSON.stringify({ ...flash, download: { files: [] } }));
    expect(() => loadProfiles(dir)).toThrow(/non-empty array/);
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
  test("Flash-Next at ctx 1536, parallel 3, chain 0: tensor split 1,1,46 over RPC0,RPC1,MTL0", () => {
    const p = plan();
    expect(p.coordinatorNodeId).toBe(M5);
    expect(p.coordinatorDevice).toBe("MTL0");
    expect(p.tensorSplit).toEqual([1, 1, 46]);
    expect(planDevices(p)).toEqual(["RPC0", "RPC1", "MTL0"]);
    expect(p.workers.map((w) => w.nodeId)).toEqual([L1, L2]);
    expect(p.workers[0]).toEqual({ nodeId: L1, device: "CUDA0", layers: 1, port: 50200, peerPort: 50201, threads: 10, memCapMiB: 3700 });
    expect(p.workers[1]).toEqual({ nodeId: L2, device: "CUDA0", layers: 1, port: 50200, peerPort: 50201, threads: 10, memCapMiB: 3700 });
    expect(p.env).toEqual({ GGML_RPC_FORWARD: "1", GGML_RPC_PIPELINE: "1", GGML_SCHED_PIPELINED_COPY: "1", GGML_RPC_GET_PIPELINE: "1", GGML_RPC_WIRE: "off" });
    expect(p.mtpPath).toBeUndefined();   // chain 0: the shipped rows allow no speculative chain
    expect(p.modelPath).toBe(shard(1).path);
    expect(p).toMatchObject({ ctx: 1536, parallel: 3, chain: 0 });
    const why = p.reasons.join("\n");
    expect(why).toMatch(/Coordinator m5: largest RAM offer \(110000 MiB\)/);
    expect(why).toMatch(/RPC0 legion1 \(12 ms\), RPC1 legion2 \(15 ms\)/);
    expect(why).toMatch(/row workerLayers 1 \(maxCtx 262144, maxParallel 3, maxChain 0\) fits/);
    expect(why).toMatch(/keeps 46 of 48 layers on MTL0: 46 × 1608 \+ 32768 MiB host = 106736 MiB of 110000 MiB/);
    expect(why).not.toMatch(/draft head/);          // nothing to draft with: the rows say chain 0
    expect(why).toMatch(/81920 bytes per token/);
  });

  test("chain 10 at parallel 3 is outside every row; the refusal names maxChain and the per-worker ceiling", () => {
    const e = refused({ spec: spec({ chain: 10 }) });
    expect(e.message).toMatch(/maxChain/);
    expect(text(e)).toMatch(/No envelope row of profile flash-next-ud-q4kxl fits ctx 1536, parallel 3, chain 10/);
    expect(text(e)).toMatch(/\(maxCtx 262144, maxParallel 3, maxChain 0\): chain 10 > maxChain 0/);
    expect(text(e)).toMatch(/\(maxCtx 262144, maxParallel 1, maxChain 0\): parallel 3 > maxParallel 1, chain 10 > maxChain 0/);
    expect(text(e)).toMatch(/legion1: 3700 MiB offered on CUDA0 allows at most 1 layer/);
    expect(text(e)).toMatch(/legion2: 3700 MiB offered on CUDA0 allows at most 1 layer/);
    expect(() => plan({ spec: spec({ chain: 10 }) })).toThrow(PlanError);
  });

  test("parallel above every row is refused, and the refusal names maxParallel", () => {
    // The second shipped row (maxParallel 1) is dominated by the first (maxParallel 3) now that both allow the
    // same context and no chain, so the honest thing to assert is the rule they share: a parallel the rows do
    // not allow is refused by name, never clamped.
    const e = refused({ spec: spec({ parallel: 4 }) });
    expect(e.message).toMatch(/maxParallel/);
    expect(text(e)).toMatch(/maxCtx 262144, maxParallel 3, maxChain 0\): parallel 4 > maxParallel 3/);
    expect(text(e)).toMatch(/maxCtx 262144, maxParallel 1, maxChain 0\): parallel 4 > maxParallel 1/);
  });

  test("ctx above the envelope is refused, never clamped", () => {
    const e = refused({ spec: spec({ ctx: 262145 }) });
    expect(text(e)).toMatch(/ctx 262145 > maxCtx 262144/);
  });

  test("a 1000 MiB worker offer is refused with the per-worker reason", () => {
    const e = refused({ nodes: [m5(), legion1({ offer: legionOffer(1000) }), legion2()] });
    expect(text(e)).toMatch(/legion1: 1000 MiB offered on CUDA0 allows at most 0 layer\(s\) of 1608 MiB after the 1536 MiB margin/);
    expect(text(e)).toMatch(/legion1 needs 3144 MiB for 1 layers but offers 1000 MiB on CUDA0/);
    expect(text(e)).toMatch(/legion2: 3700 MiB offered on CUDA0 allows at most 1 layer/);
  });

  test("chain > 0 without the draft head on the coordinator is refused", () => {
    // A chain-capable clone of the shipped profile: the rule under test is the draft head, not today's
    // (chain-free) rows.
    const chainable = { ...flash, envelope: [{ ...flash.envelope[0]!, maxChain: 2 }] };
    const e = refused({ spec: spec({ chain: 2 }), profile: chainable, nodes: [m5({ models: [shard(1), shard(2), shard(3), shard(4), shard(5)] }), legion1(), legion2()] });
    expect(e.message).toMatch(/chain 2 needs a draft head matching .* on m5; none of its 5 model files match/);
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
    const e = refused({ nodes: [m5({ offer: m5Offer(70000) }), legion1(), legion2()] });
    expect(text(e)).toMatch(/Coordinator m5 cannot hold 46 of 48 layers: 46 × 1608 \+ 32768 MiB host = 106736 MiB exceeds the 70000 MiB RAM offered/);
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

// A Windows node is placed by the same rules as a Linux one: GPU offer for worker layers, RAM for the host
// side, CPU when no GPU is offered. Model paths are Windows paths and pass through untouched.
describe("windows node placement (all shipped profiles)", () => {
  const W = "a1b2c3d4e5f60030";
  const WIN_MODELS = "C:\\Users\\lotar\\.swarmlet\\models";
  const winTiny: ModelFile = { name: TINY.name, path: `${WIN_MODELS}\\${TINY.name}`, sizeBytes: TINY.sizeBytes, kind: "gguf" };
  const winOffer = (over: Partial<Offer> = {}): Offer => ({ enabled: true, roles: { worker: true, coordinator: false, replica: false }, gpu: [{ id: "cuda:0", memMiB: 3700 }], ramMiB: 8192, cpuCores: 8, diskMiB: 200_000, modelsDir: WIN_MODELS, ...over });
  const winbox = (over: Partial<Fixture> = {}): NodeRow => node({ id: W, hostname: "laptop-ppn32fp0", os: "win32", ramMiB: 16384, cpuCores: 12, gpus: [cuda("RTX 3050 Laptop")], offer: winOffer(), rttMs: 8, ...over });
  const big = profiles.get("qwen36-35b-a3b-q4km")!;
  const BIG: ModelFile = { name: "Qwen3.6-35B-A3B-Q4_K_M.gguf", path: "/Volumes/models/Qwen3.6-35B-A3B-Q4_K_M.gguf", sizeBytes: 20_400_000_000, kind: "gguf" };

  test("Flash-Next split: the Windows GPU takes one layer next to a Legion, coordinator on the M5", () => {
    const p = plan({ nodes: [m5(), legion1(), winbox()] });
    expect(p.coordinatorNodeId).toBe(M5);
    expect(p.workers.map((w) => w.nodeId).sort()).toEqual([L1, W].sort());
    expect(p.tensorSplit).toEqual([1, 1, 46]);
    expect(p.workers.find((w) => w.nodeId === W)).toMatchObject({ layers: 1, memCapMiB: 3700 });
    expect(p.reasons.join("\n")).toMatch(/1 × 1608 \+ 1536 MiB margin = 3144 MiB per worker/);
  });

  test("Qwen3.5-2B split: the Windows GPU takes 3 layers like a Legion", () => {
    const p = plan({ spec: { name: "rig", profile: tiny.id, kind: "split", ctx: 2048, parallel: 4 }, profile: tiny, nodes: [m5(), legion1(), winbox()] });
    expect(p.tensorSplit).toEqual([3, 3, 18]);
    expect(p.workers.find((w) => w.nodeId === W)).toMatchObject({ layers: 3, memCapMiB: 3700 });
  });

  test("Qwen3.6-35B split: 4 layers fit the Windows GPU offer; a 2 GB offer is refused with the ceiling", () => {
    const coord = m5({ models: [BIG] });
    const p = plan({ spec: { name: "big", profile: big.id, kind: "split", ctx: 2048, parallel: 2, chain: 0 }, profile: big, nodes: [coord, winbox()] });
    expect(p.tensorSplit).toEqual([4, 36]);
    expect(p.workers[0]).toMatchObject({ nodeId: W, layers: 4 });
    const e = refused({ spec: { name: "big", profile: big.id, kind: "split", ctx: 2048, parallel: 2, chain: 0 }, profile: big, nodes: [coord, winbox({ offer: winOffer({ gpu: [{ id: "cuda:0", memMiB: 2048 }] }) })] });
    expect(text(e)).toMatch(/laptop-ppn32fp0: 2048 MiB offered on CUDA0 allows at most 2 layer\(s\) of 512 MiB/);
  });

  test("Qwen3.5-2B replica on Windows: GPU offered puts the layers on CUDA0, none offered runs on the CPU with the RAM offer", () => {
    const replicaRoles = { worker: false, coordinator: false, replica: true };
    const gpu = winbox({ offer: winOffer({ roles: replicaRoles }), models: [winTiny] });
    const p = plan({ spec: { name: "r", profile: tiny.id, kind: "replica" }, profile: tiny, nodes: [gpu] });
    expect(p).toMatchObject({ coordinatorNodeId: W, coordinatorDevice: "CUDA0", workers: [], tensorSplit: [], modelPath: winTiny.path });
    expect(p.reasons.join("\n")).toMatch(/keeps 24 of 24 layers on CUDA0: 24 × 80 = 1920 MiB of 3700 MiB GPU offered/);

    const cpuOnly = winbox({ gpus: [], offer: winOffer({ roles: replicaRoles, gpu: [] }), models: [winTiny] });
    const q = plan({ spec: { name: "r", profile: tiny.id, kind: "replica" }, profile: tiny, nodes: [cpuOnly] });
    expect(q).toMatchObject({ coordinatorNodeId: W, coordinatorDevice: "CPU", modelPath: winTiny.path });
    expect(q.reasons.join("\n")).toMatch(/keeps 24 of 24 layers on CPU \(no GPU offered\): 24 × 80 \+ 1024 MiB host = 2944 MiB of 8192 MiB RAM offered/);

    const tooSmall = winbox({ gpus: [], offer: winOffer({ roles: replicaRoles, gpu: [], ramMiB: 2048 }), models: [winTiny] });
    expect(text(refused({ spec: { name: "r", profile: tiny.id, kind: "replica" }, profile: tiny, nodes: [tooSmall] }))).toMatch(/cannot hold 24 of 24 layers on CPU \(no GPU offered\): 24 × 80 \+ 1024 MiB host = 2944 MiB exceeds the 2048 MiB RAM offered/);
  });

  test("Flash-Next replica on a Windows laptop is refused by memory, never by OS", () => {
    const e = refused({ spec: spec({ kind: "replica", chain: 0 }), nodes: [winbox({ gpus: [], offer: winOffer({ roles: { worker: false, coordinator: false, replica: true }, gpu: [], ramMiB: 12288 }), models: [shard(1), shard(2), shard(3), shard(4), shard(5)] })] });
    expect(text(e)).toMatch(/cannot hold 48 of 48 layers on CPU \(no GPU offered\): 48 × 1608 \+ 32768 MiB host = 109952 MiB exceeds the 12288 MiB RAM offered/);
    expect(text(e)).not.toMatch(/win32|Windows/);
  });

  // Owner rule: the CPU backend is allowed only on nodes without a usable GPU.
  test("CPU-only placement is refused on a node that has a GPU but offers none of it, on every OS the rule applies to", () => {
    const replicaRoles = { worker: false, coordinator: false, replica: true };
    const gpuButNoOffer = winbox({ offer: winOffer({ roles: replicaRoles, gpu: [] }), models: [winTiny] });
    const e = refused({ spec: { name: "r", profile: tiny.id, kind: "replica" }, profile: tiny, nodes: [gpuButNoOffer] });
    expect(text(e)).toMatch(/offers no GPU memory but has RTX 3050 Laptop \(CUDA0, 4096 MiB\); CPU-only placement is allowed only on nodes without a usable GPU/);
    expect(text(e)).not.toMatch(/keeps 24 of 24 layers on CPU/);

    const linuxNoOffer = legion1({ offer: { ...legion1().offer!, roles: replicaRoles, gpu: [] }, models: [TINY] });
    const l = refused({ spec: { name: "r", profile: tiny.id, kind: "replica" }, profile: tiny, nodes: [linuxNoOffer] });
    expect(text(l)).toMatch(/legion1 offers no GPU memory but has GTX 1650 Ti \(CUDA0, 4096 MiB\); CPU-only placement is allowed only on nodes without a usable GPU/);

    // The laptop that actually exists: Intel iGPU the engine cannot drive, so no usable GPU and a CPU replica is fine.
    const igpuOnly = winbox({ ramMiB: 7857, cpuCores: 8, gpus: [], offer: winOffer({ roles: replicaRoles, gpu: [], ramMiB: 3072, cpuCores: 6 }), models: [winTiny] });
    const p = plan({ spec: { name: "r", profile: tiny.id, kind: "replica" }, profile: tiny, nodes: [igpuOnly] });
    expect(p).toMatchObject({ coordinatorNodeId: W, coordinatorDevice: "CPU" });
    expect(p.reasons.join("\n")).toMatch(/keeps 24 of 24 layers on CPU \(no GPU offered\): 24 × 80 \+ 1024 MiB host = 2944 MiB of 3072 MiB RAM offered/);
  });
});

// The 2026-09-15 reap on node 26bc380240373930: a darwin worker admitted against a 18186 MiB GPU offer while
// the node offered 12288 MiB RAM - which is the number its own agent watchdog enforces, because a worker
// assignment's `enforce.ramMiB` defaults to that node's offer. These fixtures carry that node's numbers.
describe("a darwin worker must fit the RAM offer its agent enforces, not only the GPU offer", () => {
  const q = profiles.get("qwen38-27b-q8")!;
  const W = "a1b2c3d4e5f60041", WIDE = "a1b2c3d4e5f60042", LW = "a1b2c3d4e5f60043";
  const Q38: ModelFile = { name: "Qwen3.8-27B-Q8_0.gguf", path: "/Volumes/models/Qwen3.8-27B-Q8_0.gguf", sizeBytes: 28_595_763_552, kind: "gguf" };
  const Q38MTP: ModelFile = { name: "mtp-Qwen3.8-27B-Q8_0.gguf", path: "/Volumes/models/mtp-Qwen3.8-27B-Q8_0.gguf", sizeBytes: 3_164_006_688, kind: "mtp" };
  const m5pro: GpuDevice = { id: "metal:0", name: "Apple M5 Pro", backend: "metal", engineName: "MTL0", totalMiB: 18186 };
  const cuda: GpuDevice = { id: "cuda:0", name: "RTX 4090", backend: "cuda", engineName: "CUDA0", totalMiB: 18186 };
  const workerNode = (id: string, hostname: string, os: "darwin" | "linux", gpu: GpuDevice, ramMiB: number, memMiB: number): NodeRow =>
    node({ id, hostname, os, ramMiB: 24576, cpuCores: 15, gpus: [gpu], rttMs: 5,
      offer: { enabled: true, roles: { worker: true, coordinator: false, replica: false }, gpu: [{ id: gpu.id, memMiB }], ramMiB, cpuCores: 15, diskMiB: 500_000, modelsDir: "/Volumes/models" } });
  // The node that reaped its engine: caps 24576 MiB RAM minus the darwin reserve 12288 = the 12288 MiB offer,
  // under a GPU offer of 18186 MiB. `holder` is the coordinator that holds the 64-layer model.
  const reaper = (memMiB = 18186): NodeRow => workerNode(W, "node-26bc380240373930", "darwin", m5pro, 12288, memMiB);
  const holder = (): NodeRow => m5({ models: [Q38, Q38MTP] });
  const split = (layers: number | undefined, over: Partial<DeploymentSpec> = {}): DeploymentSpec =>
    ({ name: "lever", profile: q.id, kind: "split", coordinatorNodeId: M5, workerNodeIds: [W], ctx: 32768, parallel: 1, chain: 0, ...(layers === undefined ? {} : { workerLayers: [layers] }), ...over });

  test("the 30-layer worker from the incident is refused: 13206 MiB resident, 12288 MiB offered RAM", () => {
    // 30 × 389 + 1536 = 13206 MiB: inside the 18186 MiB GPU offer, outside the RAM the node enforces.
    const e = refused({ spec: split(30), profile: q, nodes: [holder(), reaper()] });
    expect(text(e)).toMatch(/node-26bc380240373930 needs 13206 MiB resident but the node offers only 12288 MiB RAM/);
    expect(text(e)).toMatch(/darwin unified memory: the agent's watchdog stops a worker above its own RAM offer/);
    // The GPU check was never the thing that failed: it had 18186 MiB to spend on those 30 layers.
    expect(text(e)).not.toMatch(/13206 MiB for requested 30 layers but offers 18186 MiB on MTL0/);
  });

  test("a worker that fits both budgets is still admitted, and automatic placement steps down to the largest row that does", () => {
    const p = plan({ spec: split(5), profile: q, nodes: [holder(), reaper()] });
    expect(p.tensorSplit).toEqual([5, 59]);
    expect(p.workers[0]).toEqual({ nodeId: W, device: "MTL0", layers: 5, port: 50200, threads: 10, memCapMiB: 18186 });
    expect(p.reasons.join("\n")).toMatch(/requested 5 layers fit envelope \(maxCtx 262144, maxParallel 16, maxChain 3\) and 3481 MiB fits its 18186 MiB GPU offer and its 12288 MiB RAM offer/);
    // No explicit request: the row ladder climbs to what both budgets hold (25 layers, 11261 MiB) and records
    // why 30 was skipped, instead of admitting a worker the watchdog would stop.
    const auto = plan({ spec: split(undefined), profile: q, nodes: [holder(), reaper()] });
    expect(auto.tensorSplit).toEqual([25, 39]);
    expect(auto.reasons.join("\n")).toMatch(/skipped row workerLayers 30 .*: node-26bc380240373930 needs 13206 MiB resident but the node offers only 12288 MiB RAM/);
    expect(auto.reasons.join("\n")).toMatch(/row workerLayers 25 \(maxCtx 262144, maxParallel 16, maxChain 3\) fits/);
  });

  test("the same 30-layer shape is admitted on a node whose RAM offer holds it", () => {
    const p = plan({ spec: split(30, { workerNodeIds: [WIDE] }), profile: q, nodes: [holder(), workerNode(WIDE, "wide", "darwin", m5pro, 16384, 18186)] });
    expect(p.workers[0]).toMatchObject({ nodeId: WIDE, layers: 30, memCapMiB: 18186 });
    expect(p.tensorSplit).toEqual([30, 34]);
    expect(p.engineTensorSplit).toEqual([30, 35]);
    expect(p.reasons.join("\n")).toMatch(/and 13206 MiB fits its 18186 MiB GPU offer and its 16384 MiB RAM offer/);
  });

  test("the GPU offer is still the gate on every OS, and a linux worker is still judged on it alone", () => {
    // Unified shape the old fit test assumed - GPU offer equal to the RAM offer: the original GPU check still
    // fires on it, so the new RAM check agrees with it instead of replacing it.
    const unified = refused({ spec: split(30), profile: q, nodes: [holder(), reaper(12288)] });
    expect(text(unified)).toMatch(/needs 13206 MiB for requested 30 layers but offers 12288 MiB on MTL0/);
    // A linux worker's layers are device memory, not the host RAM the agent caps: the same 30 layers under a
    // 18186 MiB CUDA offer stay admitted on a node offering 8192 MiB RAM.
    const p = plan({ spec: split(30, { workerNodeIds: [LW] }), profile: q, nodes: [holder(), workerNode(LW, "linux-box", "linux", cuda, 8192, 18186)] });
    expect(p.workers[0]).toEqual({ nodeId: LW, device: "CUDA0", layers: 30, port: 50200, threads: 10, memCapMiB: 18186 });
    expect(p.tensorSplit).toEqual([30, 34]);
  });
});

describe("explicit asymmetric placement", () => {
  const explicit = (over: Partial<DeploymentSpec> = {}): DeploymentSpec => ({ name: "unequal", profile: tiny.id, kind: "split", coordinatorNodeId: M5, workerNodeIds: [L2, L1], workerLayers: [2, 3], ctx: 2048, parallel: 4, ...over });

  test("requested counts preserve node order and exact layer total; legacy selection stays uniform", () => {
    const p = plan({ spec: explicit(), profile: tiny });
    expect(p.tensorSplit).toEqual([2, 3, 19]);
    expect(p.engineTensorSplit).toEqual([2, 3, 20]);
    expect(p.workers.map((w) => [w.nodeId, w.layers])).toEqual([[L2, 2], [L1, 3]]);
    expect(p.tensorSplit.reduce((a, b) => a + b)).toBe(tiny.layers);
    expect(plan({ spec: explicit({ workerLayers: undefined }), profile: tiny }).tensorSplit).toEqual([3, 3, 18]);
    expect(plan({ spec: explicit({ workerLayers: undefined }), profile: tiny }).engineTensorSplit).toBeUndefined();
  });

  test("explicit weights place the requested transformer blocks under the native float32 loader rule", () => {
    for (const counts of [[2, 3], [3, 2], [2, 2], [3, 3]]) {
      const p = plan({ spec: explicit({ workerLayers: counts }), profile: tiny });
      const weights = p.engineTensorSplit!;
      let cumulative = 0;
      const boundaries = weights.map((w) => cumulative = Math.fround(cumulative + w)).map((w) => Math.fround(w / cumulative));
      const devices = Array.from({ length: tiny.layers + 1 }, (_, layer) => boundaries.findIndex((b) => b > Math.fround(layer / (tiny.layers + 1))));
      expect(weights.reduce((a, b) => a + b)).toBe(tiny.layers + 1);
      expect(weights.map((_, i) => devices.slice(0, tiny.layers).filter((d) => d === i).length)).toEqual(p.tensorSplit);
      expect(devices[tiny.layers]).toBe(weights.length - 1);
    }
    expect(text(refused({ spec: explicit({ chain: 1 }), profile: tiny }))).toMatch(/Exact workerLayers with MTP is not qualified/);
  });

  test("each worker checks its own envelope row and memory without silently reducing a request", () => {
    const fits = [m5(), legion1(), legion2({ offer: legionOffer(680) })];
    expect(plan({ spec: explicit(), profile: tiny, nodes: fits }).tensorSplit).toEqual([2, 3, 19]);
    expect(text(refused({ spec: explicit({ workerLayers: [3, 2] }), profile: tiny, nodes: fits }))).toMatch(/legion2 needs 752 MiB/);
    expect(text(refused({ spec: explicit({ workerLayers: [1, 3] }), profile: tiny }))).toMatch(/no envelope row for requested 1 layers/);
    expect(text(refused({ spec: explicit({ ctx: 4097 }), profile: tiny }))).toMatch(/no envelope row.*ctx 4097/);
    const profile = { ...tiny, envelope: [{ workerLayers: 2, maxCtx: 4096, maxParallel: 1, maxChain: 0 }, { workerLayers: 2, maxCtx: 1024, maxParallel: 8, maxChain: 0 }, tiny.envelope[0]!] };
    expect(text(refused({ spec: explicit(), profile }))).toMatch(/no envelope row for requested 2 layers/);
  });

  test("sum leaves coordinator a layer and remaining residency must fit", () => {
    expect(text(refused({ spec: explicit(), profile: { ...tiny, layers: 5 } }))).toMatch(/total 5 must leave the coordinator at least one/);
    expect(text(refused({ spec: explicit(), profile: tiny, nodes: [m5({ offer: m5Offer(2500) }), legion1(), legion2()] }))).toMatch(/cannot hold 19 of 24 layers/);
  });

  test("invalid arrays, count pairs, replica usage and duplicate node IDs are refused", () => {
    for (const values of [[], [2], [2, 0], [2, -1], [2, 1.5], [2, NaN], [2, Infinity], [2, Number.MAX_SAFE_INTEGER + 1]]) {
      expect(() => plan({ spec: explicit({ workerLayers: values }), profile: tiny })).toThrow(PlanError);
    }
    for (const value of [null, "2,3", { 0: 2, 1: 3 }]) {
      expect(text(refused({ spec: explicit({ workerLayers: value as unknown as number[] }), profile: tiny }))).toMatch(/workerLayers must be/);
    }
    expect(text(refused({ spec: explicit({ workerNodeIds: undefined }), profile: tiny }))).toMatch(/requires explicit workerNodeIds/);
    expect(text(refused({ spec: explicit({ workerNodeIds: [L1, L1] }), profile: tiny }))).toMatch(/listed twice/);
    expect(text(refused({ spec: explicit({ workerNodeIds: [L1, M5] }), profile: tiny }))).toMatch(/cannot also be a worker/);
    expect(text(refused({ spec: explicit({ kind: "replica" }), profile: tiny }))).toMatch(/only valid for split/);
  });

  test("explicit coordinator relocation keeps Legion local layers and checks its offer", () => {
    const coord = legion1({ offer: { ...legionOffer(), roles: { worker: true, coordinator: true, replica: true } }, models: [TINY] });
    const s = explicit({ coordinatorNodeId: L1, workerNodeIds: [L2], workerLayers: [2] });
    expect(plan({ spec: s, profile: tiny, nodes: [m5(), coord, legion2()] })).toMatchObject({ coordinatorNodeId: L1, coordinatorDevice: "CUDA0", tensorSplit: [2, 22] });
    expect(text(refused({ spec: s, profile: tiny, nodes: [m5(), { ...coord, offer: { ...coord.offer!, ramMiB: 512 } }, legion2()] }))).toMatch(/host side: 1024 MiB exceeds/);
  });
});

describe("ngram speculative placement", () => {
  test("split and replica retain ngram with no MTP head and maxChain zero", () => {
    for (const kind of ["split", "replica"] as const) {
      const p = plan({ spec: { name: "ngram", profile: tiny.id, kind, speculation: { type: "ngram-simple" } }, profile: tiny });
      expect(p.speculation).toEqual({ type: "ngram-simple" });
      expect(p.chain).toBe(0);
      expect(p.mtpPath).toBeUndefined();
      expect(p.reasons.join("\n")).toMatch(/ngram-simple speculative decoding/);
    }
  });

  test("ngram rejects MTP combination and malformed or unrecognized options", () => {
    // The combination rule only exists when there is a chain to combine with, and the shipped rows allow
      // none - so it is tested on a chain-capable clone of the same profile.
      const chainable = { ...flash, envelope: [{ ...flash.envelope[0]!, maxChain: 1 }] };
      expect(text(refused({ spec: spec({ chain: 1, speculation: { type: "ngram-simple" } }), profile: chainable }))).toMatch(/cannot be combined with an MTP chain/);
    for (const value of [null, "ngram-simple", [], {}, { type: "draft" }, { type: "ngram-simple", draft: 4 }]) {
      expect(text(refused({ spec: spec({ chain: 0, speculation: value as DeploymentSpec["speculation"] }) }))).toMatch(/speculation must be/);
    }
    expect(plan({ spec: spec({ chain: 0 }) }).speculation).toBeUndefined();
  });
});

describe("qualified resident native admission", () => {
  // Synthetic proof records are injected through the internal planner input only.
  // The shipped controller list stays empty until the real rig proof succeeds.
  const sourceSha = "a".repeat(64), engine = "b".repeat(64);
  const binaries: Record<string, string> = { [M5]: "1".repeat(64), [L1]: "2".repeat(64), [L2]: "3".repeat(64) };
  function fixture(mode: "stages" | "prefill-decode" = "stages", count = 3): { spec: DeploymentSpec; profile: typeof tiny; nodes: NodeRow[]; nativeQualifications: Qwen35NativeQualification[] } {
    const ids = mode === "stages" ? (count === 2 ? [L1, M5] : [L1, L2, M5]) : [M5, L1];
    const cuts = count === 2 ? [0, 3, 24] : [0, 3, 6, 24];
    const endpoints = ids.map((id, i) => ({ binarySha256: binaries[id]!, artifact: mode === "stages"
      ? { name: `stage-${cuts[i]}-${cuts[i + 1]}.gguf`, sha256: String(i + 4).repeat(64), start: cuts[i]!, end: cuts[i + 1]! }
      : { name: TINY.name, sha256: sourceSha, start: 0, end: 24 } }));
    const q: Qwen35NativeQualification = { mode, sourceSha256: sourceSha, sourceSizeBytes: 2048 * 1048576, engine, ctx: 1024, workspaceMiB: 512, hostMiB: 1024, endpoints, evidenceSha256: "e".repeat(64) };
    const nodes = rig().map((n) => ({ ...n, caps: { ...n.caps!, engine: { proto: "8.1", sha256: { "mesh-stage-worker": binaries[n.id]! }, stages: { engine } } },
      offer: { ...n.offer!, roles: { worker: true, replica: true, coordinator: true } },
      models: endpoints.flatMap((e, i) => ids[i] === n.id ? [{ name: e.artifact.name, path: `/models/${e.artifact.name}`, sha256: e.artifact.sha256, sizeBytes: 1000, kind: "gguf" as const }] : []) }));
    const base = { name: "native", profile: tiny.id, kind: mode };
    const s: DeploymentSpec = mode === "stages" ? { ...base, stages: endpoints.map((e, i) => ({ nodeId: ids[i]!, modelPath: `/models/${e.artifact.name}`, modelSha256: e.artifact.sha256, start: e.artifact.start, end: e.artifact.end })) }
      : { ...base, prefillNodeId: M5, decodeNodeId: L1, modelSha256: sourceSha };
    return { spec: s, profile: tiny, nodes, nativeQualifications: [q] };
  }

  test("production admission is closed without controller-owned proof records", () => {
    const f = fixture();
    expect(text(refused({ ...f, nativeQualifications: undefined }))).toMatch(/No controller-owned native qualification/);
    expect(text(refused({ ...f, spec: { ...f.spec, nativeQualifications: f.nativeQualifications } as DeploymentSpec }))).toMatch(/does not support field nativeQualifications/);
  });

  test("two and three qualified stages pin every artifact, binary, context and source identity", () => {
    for (const count of [2, 3]) {
      const f = fixture("stages", count);
      const p = plan(f);
      expect(p.nativeExecution).toMatchObject({ mode: "stages", profile: tiny.id, qualificationEvidenceSha256: "e".repeat(64) });
      expect(p.workers).toEqual([]);
      expect(p.tensorSplit).toEqual([]);
      expect(p.ctx).toBe(1024);
      const endpoints = p.nativeExecution!.endpoints;
      expect(endpoints).toHaveLength(count);
      expect(endpoints.map((e) => e.nodeId)).toEqual(f.spec.stages!.map((s) => s.nodeId));
      for (const [i, endpoint] of endpoints.entries()) {
        expect(endpoint.binarySha256).toBe(binaries[endpoint.nodeId]!);
        expect(endpoint.identity).toMatchObject({ schema: 1, source_sha256: sourceSha, engine, ctx: 1024, cache_k: "f32", cache_v: "f32", ubatch: 1, flash_attn: "disabled", stage_start: String(f.spec.stages![i]!.start), stage_end: String(f.spec.stages![i]!.end), stage_total: "24" });
        expect(endpoint.modelPath).toBe(f.spec.stages![i]!.modelPath);
      }
      expect(endpoints.at(-1)!.fitMiB).toBe(3584);
      expect(plan({ ...f, nodes: [...f.nodes].reverse() })).toEqual(p);
    }
  });

  test("P/D pins two full-model contexts and the exact qualified binary pair", () => {
    const p = plan(fixture("prefill-decode"));
    expect(p.nativeExecution!.stateTransferQualification).toEqual({ sourceBinarySha256: binaries[M5]!, targetBinarySha256: binaries[L1]!, evidenceSha256: "e".repeat(64) });
    expect(p.nativeExecution!.endpoints.map((e) => e.identity)).toEqual([0, 1].map(() => ({ schema: 1, engine, model_sha256: sourceSha, source_sha256: sourceSha, ctx: 1024, cache_k: "f32", cache_v: "f32", ubatch: 1, flash_attn: "disabled", stage_start: "", stage_end: "", stage_total: "" })));
  });

  test("native admission rejects unsupported concurrency, sampler/RPC options and forged proof flags", () => {
    const f = fixture();
    for (const extra of [{ ctx: 2048 }, { parallel: 2 }, { chain: 1 }, { transport: "auto" }, { speculation: { type: "ngram-simple" } }, { workerLayers: [3] }, { forwarding: false }, { qualified: true }]) {
      expect(() => plan({ ...f, spec: { ...f.spec, ...extra } as DeploymentSpec })).toThrow(PlanError);
    }
    expect(text(refused({ ...f, spec: { ...f.spec, profile: flash.id } }))).toMatch(/only supports/);
    expect(text(refused({ ...f, spec: { ...f.spec, kind: "split" } }))).toMatch(/Native placement fields require/);
  });

  test("empty, duplicate, gapped, overlapping and partial stage ranges reject before launch", () => {
    const f = fixture();
    for (const stages of [[], [f.spec.stages![0]!], [f.spec.stages![0]!, { ...f.spec.stages![1]!, nodeId: L1 }, f.spec.stages![2]!],
      [f.spec.stages![0]!, { ...f.spec.stages![1]!, start: 4 }, f.spec.stages![2]!], [f.spec.stages![0]!, { ...f.spec.stages![1]!, start: 2 }, f.spec.stages![2]!],
      [f.spec.stages![0]!, f.spec.stages![1]!, { ...f.spec.stages![2]!, end: 23 }]]) {
      expect(() => plan({ ...f, spec: { ...f.spec, stages } })).toThrow(PlanError);
    }
    const pd = fixture("prefill-decode");
    expect(text(refused({ ...pd, spec: { ...pd.spec, decodeNodeId: M5 } }))).toMatch(/distinct explicit/);
  });

  test("a profile row cannot substitute a different artifact, file path, binary, ABI or missing inventory hash", () => {
    for (const change of ["artifact", "path", "binary", "abi", "unhashed"] as const) {
      const f = fixture();
      if (change === "artifact") f.spec.stages![0]!.modelSha256 = "f".repeat(64);
      else if (change === "path") f.spec.stages![0]!.modelPath = "/elsewhere/" + f.nativeQualifications[0]!.endpoints[0]!.artifact.name;
      else {
        const n = f.nodes.find((n) => n.id === L1)!;
        if (change === "binary") n.caps!.engine!.sha256["mesh-stage-worker"] = "f".repeat(64);
        if (change === "abi") n.caps!.engine!.stages!.engine = "other-abi";
        if (change === "unhashed") delete n.models[0]!.sha256;
      }
      expect(text(refused(f))).toMatch(/No controller-owned native qualification/);
    }
  });

  test("native host residency uses its qualified reserve instead of the ordinary coordinator profile", () => {
    const f = fixture();
    f.nativeQualifications[0]!.hostMiB = 2206;
    f.nodes.find(n => n.id === L1)!.offer!.ramMiB = 2205;
    expect(() => plan(f)).toThrow(/needs 2206 MiB host RAM/);
    f.nodes.find(n => n.id === L1)!.offer!.ramMiB = 2206;
    expect(plan(f).nativeExecution!.endpoints).toHaveLength(3);
    const mac = f.nodes.find(n => n.id === M5)!;
    mac.offer!.ramMiB = 4765; // 2048 source + 512 workspace + 2206 host
    expect(() => plan(f)).toThrow(/needs 4766 MiB unified RAM/);
    mac.offer!.ramMiB = 4766;
    expect(plan(f).nativeExecution!.endpoints.find(e => e.nodeId === M5)!.fitMiB).toBe(4766);
  });

  test("native qualification requires an explicit positive integral host reserve", () => {
    for (const hostMiB of [undefined, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const f = fixture();
      Object.assign(f.nativeQualifications[0]!, { hostMiB });
      expect(text(refused(f))).toMatch(/No controller-owned native qualification/);
    }
    const f = fixture();
    expect(text(refused({ ...f, spec: { ...f.spec, hostMiB: 2206 } as DeploymentSpec }))).toMatch(/does not support field hostMiB/);
  });

  test("conservative full-model workspace fit and existing owner roles are enforced on every node", () => {
    for (const change of ["gpu", "host", "cores", "role", "offline", "multiple-gpus"] as const) {
      const f = fixture();
      const n = f.nodes.find((n) => n.id === L1)!;
      if (change === "gpu") n.offer!.gpu[0]!.memMiB = 2559;
      if (change === "host") n.offer!.ramMiB = 1000;
      if (change === "cores") n.offer!.cpuCores = 1;
      if (change === "role") n.offer!.roles.worker = false;
      if (change === "offline") n.online = false;
      if (change === "multiple-gpus") n.caps!.gpus.push({ ...cuda("second"), id: "cuda:1", engineName: "CUDA1" });
      expect(() => plan(f)).toThrow(PlanError);
    }
    const f = fixture();
    f.nodes.find((n) => n.id === M5)!.offer!.ramMiB = 3583;
    expect(text(refused(f))).toMatch(/needs 3584 MiB unified RAM/);
  });

  test("native port allocation skips existing assignments and incomplete trusted records do not admit", () => {
    const f = fixture();
    expect(plan({ ...f, usedPorts: new Map([[L1, new Set([50200, 50210])]]) }).nativeExecution!.endpoints[0]!.port).toBe(50220);
    f.nativeQualifications[0]!.endpoints[0]!.artifact.start = 1;
    expect(text(refused(f))).toMatch(/No controller-owned native qualification/);
    const badAbi = fixture();
    badAbi.nativeQualifications[0]!.engine = "not-a-source-digest";
    for (const n of badAbi.nodes) n.caps!.engine!.stages!.engine = "not-a-source-digest";
    expect(text(refused(badAbi))).toMatch(/No controller-owned native qualification/);
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

  test("replica: requested node validated, memory checked, unqualified MTP refused", () => {
    expect(text(refused({ spec: spec({ kind: "replica", replicaNodeId: L1, chain: 0 }) }))).toMatch(/Requested replica node legion1 does not offer the replica role, holds no model matching/);
    expect(plan({ spec: spec({ kind: "replica", chain: 0, replicaNodeId: M5 }) }).coordinatorNodeId).toBe(M5);
    const e = refused({ spec: spec({ kind: "replica", chain: 0 }), nodes: [m5({ offer: m5Offer(70000) })] });
    expect(text(e)).toMatch(/Replica m5 cannot hold 48 of 48 layers: 48 × 1608 \+ 32768 MiB host = 109952 MiB exceeds the 70000 MiB RAM offered/);
    const chainable = { ...flash, envelope: [{ ...flash.envelope[0]!, maxChain: 2 }] };
    expect(refused({ spec: spec({ kind: "replica", chain: 2 }), profile: chainable }).message).toMatch(/Replica MTP is not qualified/);
    expect(refused({ spec: spec({ kind: "replica", chain: 2 }), profile: chainable, nodes: [m5({ models: [shard(1)] })] }).message).toMatch(/Replica MTP is not qualified/);
    expect(refused({ spec: spec({ kind: "replica", chain: 0 }), nodes: [] }).message).toMatch(/No online node offers the replica role/);
    expect(refused({ spec: spec({ kind: "replica", chain: 0 }), nodes: [m5({ online: false }), legion1()] }).message).toMatch(/No online node offers the replica role/);
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

  test("both Legion pool members can be selected individually and each must hold the complete model", () => {
    const offer = { ...legionOffer(), roles: { worker: true, coordinator: true, replica: true } };
    const nodes = [m5(), legion1({ offer, models: [TINY] }), legion2({ offer, models: [TINY] })];
    for (const id of [L1, L2]) {
      const s: DeploymentSpec = { name: `replica-${id}`, profile: tiny.id, kind: "replica", replicaNodeId: id };
      expect(plan({ spec: s, profile: tiny, nodes })).toMatchObject({ coordinatorNodeId: id, coordinatorDevice: "CUDA0", workers: [], tensorSplit: [] });
      const undersized = nodes.map((n) => n.id === id ? { ...n, offer: { ...offer, gpu: [{ id: "cuda:0", memMiB: 1900 }] } } : n);
      expect(text(refused({ spec: s, profile: tiny, nodes: undersized }))).toMatch(/cannot hold 24 of 24 layers/);
    }
  });
});
