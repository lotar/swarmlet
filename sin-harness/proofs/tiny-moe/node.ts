#!/usr/bin/env bun
// Isolated, plan-pinned expert owner. It binds loopback only; physical peers
// reach it through authenticated SSH local forwarding.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expertForward, HIDDEN, type ExpertWeights } from "./math.ts";
import { loadPlacementPlan } from "./placement.ts";
import {
  PROTOCOL_VERSION, type AccessLogEntry, type DispatchRequest, type DispatchResponse,
  type ExpertFixture, type ExpertManifest,
} from "./protocol.ts";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(name); const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`missing ${name}`); return v;
}
function optionalArg(name: string): string | undefined {
  const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined;
}
const nodeId = arg("--id"); const launchId = arg("--launch-id", "local"); const port = Number(arg("--port"));
if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(launchId)) throw new Error("invalid --launch-id");
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid --port");
const fixturePath = resolve(arg("--fixture")); const plan = loadPlacementPlan(resolve(arg("--placement-plan")));
const delayMs = Number(arg("--delay-ms", "0"));
if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 100) throw new Error("invalid --delay-ms");
const fixtureText = readFileSync(fixturePath, "utf8"); const fixture = JSON.parse(fixtureText) as ExpertFixture;
if (fixture.nodeId !== nodeId) throw new Error(`fixture node ${fixture.nodeId} != ${nodeId}`);
const experts = new Map<number, ExpertWeights>(fixture.experts.map((e) => [e.id, e]));
if (experts.size !== fixture.experts.length) throw new Error("duplicate expert ids in fixture");
const digest = new Bun.CryptoHasher("sha256").update(fixtureText).digest("hex");
const ownerPlan = plan.owners.find((o) => o.nodeId === nodeId);
if (!ownerPlan || ownerPlan.fixtureSha256 !== digest || JSON.stringify(ownerPlan.expertIds) !== JSON.stringify([...experts.keys()].sort((a, b) => a - b))) throw new Error("fixture does not match placement plan");
const adminTokenPath = optionalArg("--admin-token-file");
const adminToken = adminTokenPath ? readFileSync(resolve(adminTokenPath), "utf8").trim() : undefined;
if (adminTokenPath && (!adminToken || adminToken.length < 24)) throw new Error("admin token must contain at least 24 characters");
const manifest: ExpertManifest = {
  nodeId, modelId: plan.modelId, protocolVersion: PROTOCOL_VERSION,
  expertIds: [...experts.keys()].sort((a, b) => a - b), fixtureDigest: digest,
  residentBytes: Buffer.byteLength(fixtureText), placementEpoch: plan.placementEpoch, launchId,
};
const accessLog: AccessLogEntry[] = []; let crashArmed = false;
function authorized(req: Request): boolean { return !!adminToken && req.headers.get("authorization") === `Bearer ${adminToken}`; }
function json(status: number, body: unknown): Response { return Response.json(body, { status }); }
function finiteVector(x: unknown): x is number[] { return Array.isArray(x) && x.length === HIDDEN && x.every(Number.isFinite); }

const server = Bun.serve({
  hostname: "127.0.0.1", port,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") return json(200, { status: "ok", ...manifest });
    if (req.method === "GET" && url.pathname === "/manifest") return json(200, manifest);
    if (url.pathname.startsWith("/admin/")) {
      if (!adminToken) return json(404, { error: "NOT_FOUND" });
      if (!authorized(req)) return json(401, { error: "UNAUTHORIZED" });
      if (req.method === "POST" && url.pathname === "/admin/crash-next") { crashArmed = true; return json(200, { nodeId, armed: true }); }
      if (req.method === "GET" && url.pathname === "/admin/access-log") return json(200, accessLog);
      return json(404, { error: "NOT_FOUND" });
    }
    if (req.method !== "POST" || url.pathname !== "/execute") return json(404, { error: "NOT_FOUND" });
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > 128 * 1024) return json(413, { error: "BODY_TOO_LARGE" });
    let raw: string;
    try { raw = await req.text(); } catch { return json(400, { error: "BAD_REQUEST" }); }
    if (Buffer.byteLength(raw) > 128 * 1024) return json(413, { error: "BODY_TOO_LARGE" });
    let body: DispatchRequest;
    try { body = JSON.parse(raw) as DispatchRequest; } catch { return json(400, { error: "BAD_REQUEST" }); }
    if (!body || body.protocolVersion !== PROTOCOL_VERSION || typeof body.placementEpoch !== "string") return json(400, { error: "BAD_REQUEST" });
    if (body.placementEpoch !== plan.placementEpoch) return json(409, { error: "STALE_PLACEMENT_EPOCH" });
    if (typeof body.requestId !== "string" || !/^[\x20-\x7e]{1,128}$/.test(body.requestId) || !Number.isInteger(body.tokenCount) || body.tokenCount < 1 || body.tokenCount > 64 || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 128) return json(400, { error: "BAD_REQUEST" });
    const seen = new Set<string>(); const foreign = new Set<number>();
    for (const item of body.items) {
      const key = `${item?.tokenIndex}:${item?.expertId}`;
      if (!item || !Number.isInteger(item.tokenIndex) || item.tokenIndex < 0 || item.tokenIndex >= body.tokenCount || !Number.isInteger(item.expertId) || !finiteVector(item.activation) || seen.has(key)) return json(400, { error: "BAD_ASSIGNMENTS" });
      seen.add(key); if (!experts.has(item.expertId)) foreign.add(item.expertId);
    }
    if (foreign.size) return json(409, { error: "NOT_OWNER", expertIds: [...foreign].sort((a, b) => a - b) });
    if (crashArmed) { crashArmed = false; setTimeout(() => process.kill(process.pid, "SIGKILL"), 1); await new Promise(() => {}); }
    if (delayMs) await Bun.sleep(delayMs);
    const pieces = body.items.map((item) => ({ tokenIndex: item.tokenIndex, expertId: item.expertId, output: expertForward(experts.get(item.expertId)!, item.activation) }));
    accessLog.push({ requestId: body.requestId, expertIds: [...new Set(body.items.map((i) => i.expertId))].sort((a, b) => a - b), itemCount: body.items.length });
    if (accessLog.length > 1024) accessLog.splice(0, accessLog.length - 1024);
    const out: DispatchResponse = { protocolVersion: PROTOCOL_VERSION, placementEpoch: plan.placementEpoch, nodeId, requestId: body.requestId, pieces, requestBytes: Buffer.byteLength(raw) };
    return json(200, out);
  },
});
console.log("RESULT_NODE=" + JSON.stringify({ ...manifest, host: "127.0.0.1", port: server.port, delayMs, adminEnabled: !!adminToken }));
let stopping = false;
function stop(): void { if (stopping) return; stopping = true; server.stop(true); process.exit(0); }
process.on("SIGINT", stop); process.on("SIGTERM", stop);
