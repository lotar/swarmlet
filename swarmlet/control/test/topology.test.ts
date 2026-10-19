// Topology autodiscovery: the chooser must price candidates from measured bench + measured locality,
// keep every planner admission rule, stay deterministic, and prefer the LAN unless the relay wins by
// the documented margin.
import { describe, expect, test } from "bun:test";
import { chooseTopology, sameLan, scoreCandidate, subnetsOf, LAN_MIB_PER_SEC, RELAY_MIB_PER_SEC, RELAY_PENALTY, type TopologyInput } from "../topology.ts";
import { loadProfiles } from "../planner.ts";
import type { NodeRow } from "../registry.ts";
import type { BenchResult, Capabilities, ModelFile, Offer } from "../../protocol/types.ts";
import type { Qwen35NativeQualification } from "../profiles/qwen35-native.ts";

const T0 = "2026-09-19T00:00:00.000Z";
const profiles = loadProfiles();
const tiny = profiles.get("qwen35-2b-q8")!;
const ENGINE = "e".repeat(64);
const A = "a1b2c3d4e5f60001", B = "a1b2c3d4e5f60002";
const BIN: Record<string, string> = { [A]: "1".repeat(64), [B]: "2".repeat(64) };
const MODEL: ModelFile = { name: "Qwen3.5-2B-Q8_0.gguf", path: "/models/Qwen3.5-2B-Q8_0.gguf", sizeBytes: 2_012_012_800, sha256: "a".repeat(64), kind: "gguf" };
const LSH = "9".repeat(64);

const bench = (prefill: number, decode: number): BenchResult => ({
  modelSha256: MODEL.sha256!, engine: ENGINE, engineSha256: LSH, kind: "llama-server", ctx: 1024, parallel: 1,
  promptTokens: 512, genTokens: 32, prefillTokPerSec: prefill, decodeTokPerSec: decode, measuredAt: T0,
});

function node(id: string, hostname: string, ip: string, rates: { prefill: number; decode: number } | null): NodeRow {
  const caps: Capabilities = {
    allocationVersion: 1, os: "darwin", arch: "arm64", hostname, ramMiB: 65536, ramReserveMiB: 12288, cpuCores: 10,
    gpus: [{ id: "metal:0", name: "Apple M", backend: "metal", engineName: "MTL0", totalMiB: 65536 }],
    diskFreeMiB: 100000, privateIps: [ip], measuredAt: T0,
    engine: { proto: "8.1", sha256: { "llama-server": LSH, "mesh-stage-worker": BIN[id]! }, stages: { engine: ENGINE } },
    ...(rates ? { bench: [bench(rates.prefill, rates.decode)] } : {}),
  };
  const offer: Offer = { enabled: true, roles: { worker: true, coordinator: true, replica: true }, gpu: [{ id: "metal:0", memMiB: 65536 }], ramMiB: 60000, cpuCores: 10, diskMiB: 100000, modelsDir: "/models" };
  return { id, pubJwk: {}, certFp: `fp-${id}`, hostname, os: "darwin", arch: "arm64", enrolledAt: T0, lastSeen: T0, online: true, agentVersion: "0.1.0", caps, offer, models: [MODEL], metrics: null };
}

const qualification: Qwen35NativeQualification = {
  mode: "prefill-decode", sourceSha256: MODEL.sha256!, sourceSizeBytes: 2048 * 1048576, engine: ENGINE, ctx: 1024,
  workspaceMiB: 512, hostMiB: 1024, evidenceSha256: "f".repeat(64),
  endpoints: [{ binarySha256: BIN[A]!, artifact: { name: MODEL.name, sha256: MODEL.sha256!, start: 0, end: 24 } },
             { binarySha256: BIN[B]!, artifact: { name: MODEL.name, sha256: MODEL.sha256!, start: 0, end: 24 } }],
};

function input(a: { prefill: number; decode: number } | null, b: { prefill: number; decode: number } | null, bIp = "192.168.1.11"): TopologyInput {
  return {
    spec: { name: "auto", profile: tiny.id, kind: "replica", ctx: 1024, parallel: 1, chain: 0, transport: "relay", autoTopology: true },
    profile: tiny, nodes: [node(A, "alpha", "192.168.1.10", a), node(B, "beta", bIp, b)],
    usedPorts: new Map(), qualifications: [qualification],
  };
}

describe("topology autodiscovery", () => {
  test("one node fastest at both phases and co-located → replica there", () => {
    const choice = chooseTopology(input({ prefill: 200, decode: 50 }, { prefill: 20, decode: 10 }));
    expect("error" in choice).toBe(false);
    if ("error" in choice) return;
    expect(choice.kind).toBe("replica");
    expect(choice.nodes).toEqual([A]);
    expect(choice.local).toBe(true);
  });

  test("a faster worker-only node is a worker, never a replica host", () => {
    const a = node(A, "alpha", "192.168.1.10", { prefill: 50, decode: 10 });
    const b = node(B, "beta", "192.168.1.11", { prefill: 2000, decode: 500 });
    b.offer = { ...b.offer!, roles: { worker: true, coordinator: false, replica: false } };
    const choice = chooseTopology({ ...input(null, null), nodes: [a, b] });
    expect("error" in choice).toBe(false);
    if ("error" in choice) return;
    // The replica must be the node that offers the role, and no candidate may die on a spurious field.
    expect(choice.kind).toBe("replica");
    expect(choice.nodes).toEqual([A]);
    expect(choice.reasons.join("\n")).not.toMatch(/does not support field/);
  });

  test("local-first scoring is the documented margin", () => {
    expect(scoreCandidate({ estimatedMs: 100, local: true })).toBe(100);
    expect(scoreCandidate({ estimatedMs: 100, local: false })).toBe(100 * RELAY_PENALTY);
    // The relayed plan must be 25 % faster before it outranks an equal LAN plan.
    expect(scoreCandidate({ estimatedMs: 79, local: false })).toBeLessThan(scoreCandidate({ estimatedMs: 100, local: true }));
    expect(scoreCandidate({ estimatedMs: 81, local: false })).toBeGreaterThan(scoreCandidate({ estimatedMs: 100, local: true }));
  });

  test("missing measurements exclude candidates instead of guessing", () => {
    const choice = chooseTopology(input(null, null));
    expect("error" in choice).toBe(true);
    if ("error" in choice) expect(choice.error).toMatch(/no topology can be priced|no bench/);
  });

  test("same inputs produce the same plan hash", () => {
    const first = chooseTopology(input({ prefill: 200, decode: 0.5 }, { prefill: 20, decode: 80 }));
    const second = chooseTopology(input({ prefill: 200, decode: 0.5 }, { prefill: 20, decode: 80 }));
    if ("error" in first || "error" in second) throw new Error("expected plans");
    expect(first.planHash).toBe(second.planHash);
    expect(first.reasons.at(-1)).toMatch(/chosen/);
  });

  test("LAN grouping is private /24 only; CGNAT and public addresses never count", () => {
    const a = node(A, "alpha", "192.168.1.10", null);
    const b = node(B, "beta", "192.168.1.11", null);
    const c = node(B, "beta", "100.70.1.11", null);
    const d = node(B, "beta", "8.8.8.8", null);
    expect(subnetsOf(a)).toEqual(["192.168.1"]);
    expect(sameLan(a, b)).toBe(true);
    expect(sameLan(a, c)).toBe(false);
    expect(sameLan(a, d)).toBe(false);
  });

  test("the transfer constants are the measured ones", () => {
    expect(LAN_MIB_PER_SEC).toBe(1.0);
    expect(RELAY_MIB_PER_SEC).toBe(0.1);
    expect(RELAY_PENALTY).toBe(1.25);
  });
});
