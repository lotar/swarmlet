#!/usr/bin/env bun
// One-shot physical-owner proof runner. Owners stay loopback-only and should be
// reached through authenticated SSH local forwards.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TinyMoECoordinator, type OwnerEndpoint } from "./coordinator.ts";
import { makeCorpus, referenceForward, type ExpertWeights } from "./math.ts";
import { loadPlacementPlan } from "./placement.ts";
import { ExpertUnavailable, PROTOCOL_VERSION, type ExpertFixture, type PlacementPlan } from "./protocol.ts";

function values(name: string): string[] { const out: string[] = []; for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === name && process.argv[i + 1]) out.push(process.argv[++i]!); return out; }
function value(name: string, fallback?: string): string { const found = values(name); if (found.length > 1) throw new Error(`duplicate ${name}`); if (!found[0] && fallback === undefined) throw new Error(`missing ${name}`); return found[0] ?? fallback!; }
function flag(name: string): boolean { return process.argv.includes(name); }
function mapping(raw: string, kind: string): [string, string] { const i = raw.indexOf("="); if (i < 1 || i === raw.length - 1) throw new Error(`invalid ${kind} mapping`); return [raw.slice(0, i), raw.slice(i + 1)]; }
function endpoint(raw: string): string { const u = new URL(raw); if (u.protocol !== "http:" || (u.hostname !== "127.0.0.1" && u.hostname !== "[::1]" && u.hostname !== "::1") || u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) throw new Error("owner endpoints must be credential-free loopback HTTP URLs"); return raw.replace(/\/$/, ""); }
function hash(v: unknown): string { return new Bun.CryptoHasher("sha256").update(JSON.stringify(v)).digest("hex"); }
function percentile(xs: number[], q: number): number { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * q) - 1)]!; }
function atomicJson(path: string, body: unknown): void { mkdirSync(dirname(path), { recursive: true }); const temp = `${path}.tmp-${process.pid}`; writeFileSync(temp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 }); renameSync(temp, path); }
async function admin(url: string, path: string, token: string, method = "POST"): Promise<Response> { return fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined }); }
function gitCommit(): string { const r = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" }); return new TextDecoder().decode(r.stdout).trim() || "unknown"; }

export interface PhysicalProofOptions { plan: PlacementPlan; owners: OwnerEndpoint[]; evidenceOut: string; adminToken?: string; timeoutMs: number; corpusSize: number; layers: number; crashOwner?: string; expectRestart: boolean; fixtureDir: string; hostEvidence?: unknown }
export async function runPhysicalProof(o: PhysicalProofOptions): Promise<Record<string, unknown>> {
  const fixtureByExpert = new Map<number, ExpertWeights>();
  for (const expected of o.plan.owners) {
    const fixture = JSON.parse(readFileSync(resolve(o.fixtureDir, `${expected.nodeId}.json`), "utf8")) as ExpertFixture;
    for (const expert of fixture.experts) { if (fixtureByExpert.has(expert.id)) throw new Error(`duplicate reference expert ${expert.id}`); fixtureByExpert.set(expert.id, expert); }
  }
  const coordinator = new TinyMoECoordinator(o.owners, o.plan, o.timeoutMs); const manifests = await coordinator.initialize();
  const corpus = makeCorpus(o.corpusSize); const reference = referenceForward(corpus, fixtureByExpert).map((x) => x.output); const distributed = await coordinator.forwardBatch(corpus);
  let maxAbsError = 0; for (let t = 0; t < reference.length; t++) for (let i = 0; i < reference[t]!.length; i++) maxAbsError = Math.max(maxAbsError, Math.abs(reference[t]![i]! - distributed.outputs[t]![i]!));
  if (maxAbsError > 1e-12 || hash(reference) !== hash(distributed.outputs)) throw new Error(`reference parity failed maxAbs=${maxAbsError}`);
  const foreignOwner = o.plan.owners.find((x) => !x.expertIds.includes(0))!; const foreignUrl = o.owners.find((x) => x.nodeId === foreignOwner.nodeId)!.url;
  const foreign = await fetch(`${foreignUrl}/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, placementEpoch: o.plan.placementEpoch, requestId: "foreign-check", tokenCount: 1, items: [{ tokenIndex: 0, expertId: 0, activation: Array(8).fill(0) }] }) });
  if (foreign.status !== 409 || (await foreign.json() as { error?: string }).error !== "NOT_OWNER") throw new Error("foreign expert was not rejected");
  const staleOwner = o.owners[0]!; const stale = await fetch(`${staleOwner.url}/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, placementEpoch: "0".repeat(64), requestId: "stale-check", tokenCount: 1, items: [{ tokenIndex: 0, expertId: o.plan.owners[0]!.expertIds[0], activation: Array(8).fill(0) }] }) });
  if (stale.status !== 409 || (await stale.json() as { error?: string }).error !== "STALE_PLACEMENT_EPOCH") throw new Error("stale epoch was not rejected");
  const benchmarks: Record<string, { p50Ms: number; p95Ms: number; throughput: number }> = {};
  for (const size of [1, 8, Math.min(64, o.corpusSize)]) { const samples: number[] = []; for (let i = 0; i < 5; i++) samples.push((await coordinator.forwardBatch(corpus.slice(0, size))).telemetry.durationMs); const p50 = percentile(samples, .5); benchmarks[`batch${size}`] = { p50Ms: p50, p95Ms: percentile(samples, .95), throughput: size * 1000 / p50 }; }
  const serial = await coordinator.forwardLayers(corpus[0]!, o.layers); let failedClosed = false, restartParity = false, restartObserved = false;
  if (o.crashOwner) {
    if (!o.adminToken) throw new Error("crash proof requires --admin-token-file"); const owner = o.owners.find((x) => x.nodeId === o.crashOwner); if (!owner) throw new Error(`unknown crash owner ${o.crashOwner}`);
    const armed = await admin(owner.url, "/admin/crash-next", o.adminToken); if (!armed.ok) throw new Error(`could not arm crash: HTTP ${armed.status}`);
    try { await coordinator.forwardBatch([corpus[0]!]); } catch (e) { failedClosed = e instanceof ExpertUnavailable; }
    if (!failedClosed) throw new Error("owner crash returned output instead of failing closed");
    if (o.expectRestart) {
      const deadline = performance.now() + 30_000;
      while (performance.now() < deadline) { try { const r = await fetch(`${owner.url}/manifest`, { signal: AbortSignal.timeout(500) }); if (r.ok) { restartObserved = true; break; } } catch {} await Bun.sleep(100); }
      if (!restartObserved) throw new Error("owner supervisor did not restart within 30s"); const restarted = await coordinator.initialize(); const before = manifests.find((m) => m.nodeId === o.crashOwner); const after = restarted.find((m) => m.nodeId === o.crashOwner); if (!before || !after || before.launchId !== after.launchId || before.fixtureDigest !== after.fixtureDigest || before.placementEpoch !== after.placementEpoch) throw new Error("restart identity changed"); const retry = await coordinator.forwardBatch([corpus[0]!]); restartParity = hash(retry.outputs) === hash(reference.slice(0, 1)); if (!restartParity) throw new Error("restart parity failed");
    }
  }
  const result = { schemaVersion: 1, proofId: "tiny-moe-physical-v1", outcome: "pass", timestampUtc: new Date().toISOString(), gitCommit: gitCommit(), protocolVersion: PROTOCOL_VERSION, placementEpoch: o.plan.placementEpoch, manifests, hostEvidence: o.hostEvidence ?? null, parity: { referenceSha256: hash(reference), distributedSha256: hash(distributed.outputs), maxAbsError }, benchmarks, serialBarriers: { layers: o.layers, durationMs: serial.durationMs, rpcCount: serial.rpcCount, ceilingTps: 1000 / serial.durationMs }, assertions: { ownershipExact: true, foreignExpertRejected: true, staleEpochRejected: true, referenceParity: true, failedClosed: o.crashOwner ? failedClosed : null, restartObserved: o.expectRestart ? restartObserved : null, restartParity: o.expectRestart ? restartParity : null }, scope: "tiny deterministic expert protocol over plan-pinned external owners; not model inference, CUDA, or frontier throughput" };
  atomicJson(o.evidenceOut, result); return result;
}

async function main(): Promise<void> {
  const planPath = resolve(value("--plan")); const plan = loadPlacementPlan(planPath); const owners = values("--owner").map((x) => mapping(x, "owner")).map(([nodeId, url]) => ({ nodeId, url: endpoint(url) }));
  const tokenPath = values("--admin-token-file")[0]; const hostEvidencePath = values("--host-evidence")[0];
  const result = await runPhysicalProof({ plan, owners, evidenceOut: resolve(value("--evidence-out", "data/two-node/result.json")), adminToken: tokenPath ? readFileSync(resolve(tokenPath), "utf8").trim() : undefined, timeoutMs: Number(value("--timeout-ms", "2000")), corpusSize: Number(value("--corpus-size", "64")), layers: Number(value("--layers", "92")), crashOwner: values("--crash-owner")[0], expectRestart: flag("--expect-restart"), fixtureDir: dirname(planPath), hostEvidence: hostEvidencePath ? JSON.parse(readFileSync(resolve(hostEvidencePath), "utf8")) : undefined });
  console.log("RESULT_JSON=" + JSON.stringify({ outcome: result.outcome, evidence: resolve(value("--evidence-out", "data/two-node/result.json")), placementEpoch: plan.placementEpoch }));
}
if (import.meta.main) main().catch((e) => { console.error(`PROOF_FAILED: ${e instanceof Error ? e.message : String(e)}`); process.exit(4); });
