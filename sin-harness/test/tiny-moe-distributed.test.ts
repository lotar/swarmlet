// TRUE per-expert distributed MoE proof — no model, Docker, GPU or dependency.
// Three Bun processes own disjoint expert matrices; coordinator owns router only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TinyMoECoordinator, type OwnerEndpoint } from "../proofs/tiny-moe/coordinator.ts";
import { makeCorpus, referenceForward, type ExpertWeights } from "../proofs/tiny-moe/math.ts";
import type { ExpertFixture, ExpertManifest } from "../proofs/tiny-moe/protocol.ts";
import { ExpertUnavailable } from "../proofs/tiny-moe/protocol.ts";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPT = resolve(ROOT, "proofs/tiny-moe/node.ts");
const FIXTURES = resolve(ROOT, "proofs/tiny-moe/fixtures");
const PORTS = { n1: 9571, n2: 9572, n3: 9573 } as const;
const DELAYS = { n1: 6, n2: 8, n3: 11 } as const; // application-level one-way fiber proxy
const OWNERS: OwnerEndpoint[] = Object.entries(PORTS).map(([nodeId, port]) => ({ nodeId, url: `http://127.0.0.1:${port}` }));
const procs = new Map<string, Bun.Subprocess>();
const tempDirs = new Map<string, string>();
let coordinator: TinyMoECoordinator;
let experts: Map<number, ExpertWeights>;
let baselineTestRssKb = 0;
let baselineDockerRssKb = 0;
let baselineSwapMb = 0;

function rssKb(pid: number): number {
  const r = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  return Number(new TextDecoder().decode(r.stdout).trim()) || 0;
}
function dockerVmRssKb(): number {
  const r = Bun.spawnSync(["ps", "-axo", "rss=,command="], { stdout: "pipe" });
  return new TextDecoder().decode(r.stdout).split("\n")
    .filter((l) => l.includes("com.apple.Virtualization.VirtualMachine"))
    .reduce((sum, l) => sum + (Number(l.trim().split(/\s+/)[0]) || 0), 0);
}
function swapUsedMb(): number {
  const r = Bun.spawnSync(["sysctl", "vm.swapusage"], { stdout: "pipe" });
  const m = new TextDecoder().decode(r.stdout).match(/used = ([\d.]+)M/);
  return Number(m?.[1] ?? 0);
}
async function waitHealthy(nodeId: string): Promise<void> {
  const port = PORTS[nodeId as keyof typeof PORTS];
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)) return;
    await Bun.sleep(20);
  }
  throw new Error(`${nodeId} did not become healthy`);
}
async function startNode(nodeId: "n1" | "n2" | "n3"): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), `sin-tiny-${nodeId}-`));
  tempDirs.set(nodeId, cwd);
  const p = Bun.spawn([
    process.execPath, SCRIPT, "--id", nodeId, "--port", String(PORTS[nodeId]),
    "--fixture", resolve(FIXTURES, `${nodeId}.json`), "--delay-ms", String(DELAYS[nodeId]),
  ], {
    cwd, stdin: "ignore", stdout: "ignore", stderr: "inherit",
    env: { PATH: process.env.PATH ?? "", HOME: cwd, TMPDIR: cwd },
  });
  procs.set(nodeId, p);
  await waitHealthy(nodeId);
}
async function stopNode(nodeId: string): Promise<void> {
  const p = procs.get(nodeId);
  if (p) { p.kill(9); await p.exited.catch(() => {}); procs.delete(nodeId); }
}
async function post(nodeId: string, path: string, body: unknown = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${PORTS[nodeId as keyof typeof PORTS]}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
function assertClose(actual: readonly number[][], expected: readonly number[][], tol = 1e-12): void {
  expect(actual.length).toBe(expected.length);
  for (let t = 0; t < actual.length; t++) for (let i = 0; i < actual[t]!.length; i++) {
    expect(Math.abs(actual[t]![i]! - expected[t]![i]!)).toBeLessThanOrEqual(tol);
  }
}
function hash(v: unknown): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(v)).digest("hex");
}

beforeAll(async () => {
  // Safety baseline BEFORE spawning anything. No Docker command is executed.
  baselineTestRssKb = rssKb(process.pid);
  baselineDockerRssKb = dockerVmRssKb();
  baselineSwapMb = swapUsedMb();
  // Refuse occupied ports rather than touching an existing process.
  for (const port of Object.values(PORTS)) {
    if (await fetch(`http://127.0.0.1:${port}/health`).then(() => true).catch(() => false)) {
      throw new Error(`safety preflight: port ${port} occupied`);
    }
  }
  await startNode("n1"); await startNode("n2"); await startNode("n3");
  coordinator = new TinyMoECoordinator(OWNERS, 2000);
  await coordinator.initialize();
  experts = new Map();
  for (const nodeId of ["n1", "n2", "n3"]) {
    const fixture = await Bun.file(resolve(FIXTURES, `${nodeId}.json`)).json() as ExpertFixture;
    for (const e of fixture.experts) experts.set(e.id, e);
  }
}, 30_000);

afterAll(async () => {
  await Promise.all([...procs.keys()].map(stopNode));
  for (const dir of tempDirs.values()) rmSync(dir, { recursive: true, force: true });
});

describe("tiny true-expert distributed MoE", () => {
  test("disjoint ownership manifests; foreign experts are rejected", async () => {
    const manifests = await Promise.all(OWNERS.map(async (o) => await (await fetch(`${o.url}/manifest`)).json() as ExpertManifest));
    const seen = new Set<number>();
    for (const m of manifests) {
      expect(m.residentBytes).toBeLessThan(4096);
      expect(m.fixtureDigest).toHaveLength(64);
      for (const id of m.expertIds) { expect(seen.has(id)).toBe(false); seen.add(id); }
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
    const foreign = await post("n2", "/execute", {
      requestId: "foreign", items: [{ tokenIndex: 0, expertId: 0, activation: Array(8).fill(0), gateWeight: 1 }],
    });
    expect(foreign.status).toBe(409);
    expect((await foreign.json() as { error: string }).error).toBe("NOT_OWNER");
  });

  test("top-2 routes to true owners and matches monolithic reference", async () => {
    const corpus = makeCorpus(64);
    const ref = referenceForward(corpus, experts);
    const distributed = await coordinator.forwardBatch(corpus);
    expect(distributed.routes.map((r) => r.map((x) => x.expertId)))
      .toEqual(ref.map((r) => r.choices.map((x) => x.expertId)));
    assertClose(distributed.outputs, ref.map((x) => x.output));
    expect(hash(distributed.outputs)).toBe(hash(ref.map((x) => x.output)));
    const selected = new Set(distributed.routes.flat().map((x) => x.expertId));
    expect([...selected].sort()).toEqual([0, 1, 2, 3]);
    expect(distributed.routes.some((r) => coordinator.ownerOf(r[0]!.expertId)?.nodeId !== coordinator.ownerOf(r[1]!.expertId)?.nodeId)).toBe(true);
    for (const o of OWNERS) {
      const manifest = await (await fetch(`${o.url}/manifest`)).json() as ExpertManifest;
      const logs = await (await fetch(`${o.url}/access-log`)).json() as Array<{ expertIds: number[] }>;
      expect(logs.flatMap((x) => x.expertIds).every((id) => manifest.expertIds.includes(id))).toBe(true);
    }
    console.log(`[tiny-moe] parity hash=${hash(distributed.outputs).slice(0, 16)} rpc=${distributed.telemetry.rpcCount} bytes=${distributed.telemetry.bytesOut + distributed.telemetry.bytesIn}`);
  });

  test("batching collapses per-token calls into one RPC per owner", async () => {
    const corpus = makeCorpus(64);
    await coordinator.forwardBatch(corpus.slice(0, 8)); // warmup
    let unbatchedRpc = 0;
    for (const token of corpus.slice(0, 8)) unbatchedRpc += (await coordinator.forwardBatch([token])).telemetry.rpcCount;
    const batched = await coordinator.forwardBatch(corpus.slice(0, 8));
    expect(batched.telemetry.rpcCount).toBeLessThan(unbatchedRpc);
    for (const size of [1, 8, 32, 64]) {
      const samples: number[] = [];
      let lastBytes = 0;
      for (let i = 0; i < 5; i++) {
        const r = await coordinator.forwardBatch(corpus.slice(0, size));
        samples.push(r.telemetry.durationMs); lastBytes = r.telemetry.bytesOut + r.telemetry.bytesIn;
      }
      samples.sort((a, b) => a - b);
      const median = samples[Math.floor(samples.length / 2)]!;
      const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
      console.log(`[tiny-moe bench] batch=${size} median=${median.toFixed(2)}ms p95=${p95.toFixed(2)}ms throughput=${(size * 1000 / median).toFixed(1)}tok/s bytes=${lastBytes}`);
    }
    // All three delayed owners participate in this corpus; max configured delay=11ms.
    expect(batched.telemetry.durationMs).toBeGreaterThanOrEqual(8);
  });

  test("92 serial MoE barriers expose K3-style WAN latency amplification", async () => {
    const r = await coordinator.forwardLayers(makeCorpus(1)[0]!, 92);
    expect(r.rpcCount).toBeGreaterThanOrEqual(92);
    expect(r.durationMs).toBeGreaterThan(400);
    console.log(`[tiny-moe 92-layer] ${r.durationMs.toFixed(1)}ms/token network+tiny-compute ceiling=${(1000 / r.durationMs).toFixed(3)}tok/s rpc=${r.rpcCount}`);
  }, 10_000);

  test("owner loss fails closed; exact restart restores parity", async () => {
    const token = makeCorpus(1)[0]!; // routes to experts 0(n1)+1(n2)
    const ref = referenceForward([token], experts)[0]!.output;
    expect((await post("n2", "/arm-crash")).ok).toBe(true);
    let produced = false;
    try { await coordinator.forwardBatch([token]); produced = true; }
    catch (e) { expect(e).toBeInstanceOf(ExpertUnavailable); }
    expect(produced).toBe(false); // no partial output, no foreign-owner fallback
    await stopNode("n2");
    await startNode("n2");
    await coordinator.initialize();
    const retry = await coordinator.forwardBatch([token]);
    assertClose(retry.outputs, [ref]);
  }, 10_000);

  test("hard memory envelope: proof <1GB RSS; Docker increment <1GB", () => {
    const proofRssKb = rssKb(process.pid) + [...procs.values()].reduce((s, p) => s + rssKb(p.pid), 0);
    const incrementalKb = Math.max(0, proofRssKb - baselineTestRssKb);
    const dockerDeltaKb = Math.max(0, dockerVmRssKb() - baselineDockerRssKb);
    const swapDeltaMb = Math.max(0, swapUsedMb() - baselineSwapMb);
    console.log(`[tiny-moe memory] proofDelta=${(incrementalKb / 1024).toFixed(1)}MiB dockerDelta=${(dockerDeltaKb / 1024).toFixed(1)}MiB swapDelta=${swapDeltaMb.toFixed(1)}MiB`);
    expect(incrementalKb).toBeLessThan(1024 * 1024);
    expect(dockerDeltaKb).toBeLessThan(1024 * 1024);
    expect(swapDeltaMb).toBeLessThan(512);
  });
});
