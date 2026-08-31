import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runPhysicalProof } from "../proofs/tiny-moe/physical.ts";
import { TinyMoECoordinator } from "../proofs/tiny-moe/coordinator.ts";
import { makeCorpus } from "../proofs/tiny-moe/math.ts";
import { ExpertUnavailable } from "../proofs/tiny-moe/protocol.ts";
import { loadPlacementPlan, validatePlacementPlan } from "../proofs/tiny-moe/placement.ts";

const ROOT = resolve(import.meta.dir, ".."); const FIXTURES = resolve(ROOT, "proofs/tiny-moe/fixtures/two-node");
const PLAN = resolve(FIXTURES, "plan.json"); const PORTS = { n1: 9671, n2: 9672 } as const;
const work = mkdtempSync(join(tmpdir(), "swarmlet-physical-test-")); const tokenPath = join(work, "admin-token"); const token = "test-" + "a".repeat(59);
const supervisors: Bun.Subprocess[] = [];
async function wait(url: string): Promise<void> { for (let i = 0; i < 100; i++) { if (await fetch(`${url}/health`).then((r) => r.ok).catch(() => false)) return; await Bun.sleep(25); } throw new Error(`${url} did not become healthy`); }
function start(nodeId: "n1" | "n2"): Bun.Subprocess {
  const p = Bun.spawn([process.execPath, resolve(ROOT, "proofs/tiny-moe/supervisor.ts"), "--pid-file", join(work, `${nodeId}.pid`), "--", "--id", nodeId, "--port", String(PORTS[nodeId]), "--fixture", resolve(FIXTURES, `${nodeId}.json`), "--placement-plan", PLAN, "--admin-token-file", tokenPath], { stdin: "ignore", stdout: "ignore", stderr: "inherit" }); supervisors.push(p); return p;
}
beforeAll(async () => { writeFileSync(tokenPath, token, { mode: 0o600 }); start("n1"); start("n2"); await Promise.all([wait("http://127.0.0.1:9671"), wait("http://127.0.0.1:9672")]); });
afterAll(async () => { for (const p of supervisors) p.kill("SIGTERM"); await Promise.all(supervisors.map((p) => p.exited.catch(() => -1))); rmSync(work, { recursive: true, force: true }); });

describe("physical-owner proof runner over external endpoints", () => {
  test("rejects non-canonical unsorted placement ownership", () => {
    const bad = JSON.parse(readFileSync(PLAN, "utf8")); bad.owners[0].expertIds.reverse(); expect(() => validatePlacementPlan(bad)).toThrow("strictly ascending");
  });

  test("bounds malformed data and protects test administration", async () => {
    const base = "http://127.0.0.1:9671"; const plan = loadPlacementPlan(PLAN);
    expect((await fetch(`${base}/admin/access-log`)).status).toBe(401);
    expect((await fetch(`${base}/execute`, { method: "POST", body: "{" })).status).toBe(400);
    const duplicate = { protocolVersion: 2, placementEpoch: plan.placementEpoch, requestId: "duplicate", tokenCount: 1, items: [{ tokenIndex: 0, expertId: 0, activation: Array(8).fill(0) }, { tokenIndex: 0, expertId: 0, activation: Array(8).fill(0) }] };
    expect((await fetch(`${base}/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(duplicate) })).status).toBe(400);
    expect((await fetch(`${base}/execute`, { method: "POST", headers: { "content-length": String(129 * 1024) }, body: "x".repeat(129 * 1024) })).status).toBe(413);
  });

  test("rejects duplicate or incomplete owner response pieces", async () => {
    const plan = loadPlacementPlan(PLAN); const expected = plan.owners.find((o) => o.nodeId === "n2")!;
    const malicious = Bun.serve({ hostname: "127.0.0.1", port: 9673, async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/manifest") return Response.json({ nodeId: "n2", modelId: plan.modelId, protocolVersion: 2, expertIds: expected.expertIds, fixtureDigest: expected.fixtureSha256, residentBytes: 1, placementEpoch: plan.placementEpoch });
      const body = await req.json() as { requestId: string; items: Array<{ tokenIndex: number; expertId: number }> }; const item = body.items[0]!;
      return Response.json({ protocolVersion: 2, placementEpoch: plan.placementEpoch, nodeId: "n2", requestId: body.requestId, pieces: [{ ...item, output: Array(8).fill(0) }, { ...item, output: Array(8).fill(0) }], requestBytes: 1 });
    } });
    try {
      const coordinator = new TinyMoECoordinator([{ nodeId: "n1", url: "http://127.0.0.1:9671" }, { nodeId: "n2", url: "http://127.0.0.1:9673" }], plan, 1000); await coordinator.initialize();
      await expect(coordinator.forwardBatch([makeCorpus(1)[0]!])).rejects.toBeInstanceOf(ExpertUnavailable);
    } finally { malicious.stop(true); }
  });

  test("exact parity, strict ownership, fail-closed crash and supervised restart", async () => {
    const out = join(work, "result.json"); const result = await runPhysicalProof({ plan: loadPlacementPlan(PLAN), owners: [{ nodeId: "n1", url: "http://127.0.0.1:9671" }, { nodeId: "n2", url: "http://127.0.0.1:9672" }], evidenceOut: out, adminToken: token, timeoutMs: 2000, corpusSize: 64, layers: 12, crashOwner: "n2", expectRestart: true, fixtureDir: FIXTURES });
    expect(result.outcome).toBe("pass"); expect((result.parity as { maxAbsError: number }).maxAbsError).toBe(0);
    expect((result.assertions as Record<string, unknown>).failedClosed).toBe(true); expect((result.assertions as Record<string, unknown>).restartParity).toBe(true);
    expect(JSON.parse(readFileSync(out, "utf8")).placementEpoch).toBe(loadPlacementPlan(PLAN).placementEpoch);
  }, 20_000);
});
