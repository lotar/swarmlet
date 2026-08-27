#!/usr/bin/env bun
// One isolated expert owner. It loads ONLY its assigned fixture and rejects
// foreign expert IDs. No router, no model skeleton, no knowledge of peers.
import { resolve } from "node:path";
import { expertForward, type ExpertWeights } from "./math.ts";
import type {
  AccessLogEntry, DispatchRequest, DispatchResponse, ExpertFixture, ExpertManifest,
} from "./protocol.ts";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`missing ${name}`);
  return v;
}
const nodeId = arg("--id");
const port = Number(arg("--port"));
const fixturePath = resolve(arg("--fixture"));
const delayMs = Number(arg("--delay-ms", "0"));
const fixtureText = await Bun.file(fixturePath).text();
const fixture = JSON.parse(fixtureText) as ExpertFixture;
if (fixture.nodeId !== nodeId) throw new Error(`fixture node ${fixture.nodeId} != ${nodeId}`);
const experts = new Map<number, ExpertWeights>(fixture.experts.map((e) => [e.id, e]));
if (experts.size !== fixture.experts.length) throw new Error("duplicate expert ids in fixture");
const digest = new Bun.CryptoHasher("sha256").update(fixtureText).digest("hex");
const manifest: ExpertManifest = {
  nodeId, expertIds: [...experts.keys()].sort((a, b) => a - b),
  fixtureDigest: digest, residentBytes: Buffer.byteLength(fixtureText),
};
const accessLog: AccessLogEntry[] = [];
let crashArmed = false;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", nodeId });
    }
    if (req.method === "GET" && url.pathname === "/manifest") return Response.json(manifest);
    if (req.method === "GET" && url.pathname === "/access-log") return Response.json(accessLog);
    if (req.method === "POST" && url.pathname === "/arm-crash") {
      crashArmed = true;
      return Response.json({ nodeId, armed: true });
    }
    if (req.method === "POST" && url.pathname === "/shutdown") {
      setTimeout(() => process.exit(0), 5);
      return Response.json({ nodeId, stopping: true });
    }
    if (req.method === "POST" && url.pathname === "/execute") {
      const raw = await req.text();
      const body = JSON.parse(raw) as DispatchRequest;
      if (!body.requestId || !Array.isArray(body.items)) {
        return Response.json({ error: "BAD_REQUEST" }, { status: 400 });
      }
      const foreign = [...new Set(body.items.map((i) => i.expertId).filter((id) => !experts.has(id)))];
      if (foreign.length) {
        return Response.json({ error: "NOT_OWNER", expertIds: foreign }, { status: 409 });
      }
      if (crashArmed) {
        // Owner loss after dispatch reception: no partial result may escape.
        process.kill(process.pid, "SIGKILL");
        await new Promise(() => {});
      }
      if (delayMs > 0) await Bun.sleep(delayMs);
      const pieces = body.items.map((item) => ({
        tokenIndex: item.tokenIndex,
        expertId: item.expertId,
        gateWeight: item.gateWeight,
        output: expertForward(experts.get(item.expertId)!, item.activation),
      }));
      accessLog.push({
        requestId: body.requestId,
        expertIds: [...new Set(body.items.map((i) => i.expertId))].sort((a, b) => a - b),
        itemCount: body.items.length,
      });
      if (accessLog.length > 1024) accessLog.splice(0, accessLog.length - 1024);
      const out: DispatchResponse = { nodeId, requestId: body.requestId, pieces, requestBytes: raw.length };
      return Response.json(out);
    }
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  },
});
console.log(`[tiny-moe ${nodeId}] experts=${manifest.expertIds.join(",")} :${server.port} delay=${delayMs}ms`);
