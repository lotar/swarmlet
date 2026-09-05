// Control core + agent client, in-process: enrollment (good/bad code, bad signature), auth,
// hello/heartbeat into the registry, assignment dispatch, and a 10 MB relay between two agents
// through control that lands on a real TCP echo server bit-exact.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server as NetServer } from "node:net";
import { loadControlConfig, type ControlConfig } from "../config.ts";
import { bootControl, directLocalRequest } from "../server.ts";
import { AgentClient, enroll } from "../../node-agent/agent.ts";
import { loadIdentity, type Identity } from "../../node-agent/identity.ts";
import { agentPaths } from "../../node-agent/paths.ts";
import { makeLogger } from "../log.ts";
import { pipe } from "../../node-agent/streams.ts";
import type { Assignment, AssignmentState, Capabilities, Offer } from "../../protocol/types.ts";

const log = makeLogger("test", "warn");
const capsFor = (hostname: string): Capabilities => ({
  os: "linux", arch: "x64", hostname, ramMiB: 16000, ramReserveMiB: 4096, cpuCores: 12,
  gpus: [{ id: "cuda:0", name: "GTX", backend: "cuda", engineName: "CUDA0", totalMiB: 4096 }],
  diskFreeMiB: 100000, privateIps: ["127.0.0.1"], measuredAt: new Date().toISOString(),
});
const offer: Offer = { enabled: true, roles: { worker: true, coordinator: false, replica: false }, gpu: [{ id: "cuda:0", memMiB: 3000 }], ramMiB: 8000, cpuCores: 6, diskMiB: 10000, modelsDir: "/tmp" };

let cfg: ControlConfig;
let ctl: Awaited<ReturnType<typeof bootControl>>;
let base: string;
const api = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${cfg.adminToken}`, "content-type": "application/json", ...(init.headers ?? {}) } });

interface FakeAgent { id: Identity; client: AgentClient; assigned: Assignment[]; allowed: Set<number> }

async function makeAgent(name: string, code: string): Promise<FakeAgent> {
  const paths = agentPaths(mkdtempSync(join(tmpdir(), `swarmlet-agent-${name}-`)));
  const id = await loadIdentity(paths);
  const caps = capsFor(name);
  const res = await enroll(base, code, id, caps);
  expect(res.nodeId).toBe(id.nodeId);
  const assigned: Assignment[] = [];
  const allowed = new Set<number>();
  const states = new Map<string, AssignmentState>();
  const client = new AgentClient(res.agentUrl, id, {
    caps: () => caps, offer: () => offer, models: () => [], metrics: () => ({ ts: new Date().toISOString(), cpuPct: 1 }),
    assignments: () => [...states].map(([aid, state]) => ({ id: aid, state })),
    onAssign: (a) => { assigned.push(a); states.set(a.id, "ready"); client.reportAssignment(a.id, "ready", "fake"); },
    allowedPorts: () => allowed,
  }, log);
  client.start();
  await client.whenConnected();
  return { id, client, assigned, allowed };
}

beforeAll(async () => {
  cfg = loadControlConfig({ dataDir: mkdtempSync(join(tmpdir(), "swarmlet-control-")), port: 0, host: "127.0.0.1", logLevel: "warn" });
  ctl = await bootControl(cfg);
  base = `http://127.0.0.1:${ctl.server.port}`;
  cfg.publicUrl = base; // port 0 was resolved after boot
});

afterAll(() => { ctl.server.stop(true); ctl.reg.close(); });

describe("control core", () => {
  let a!: FakeAgent, b!: FakeAgent;

  test("public web, API and diagnostics are closed even with valid admin credentials", async () => {
    for (const path of ["/", "/index.html", "/app.js", "/style.css", "/login", "/logout", "/health", "/probe/ip", "/probe/down", "/probe/up", "/enroll", "/api/nodes", "/api/stream", "/agent"]) {
      for (const method of ["GET", "POST"]) {
        const res = await api(path, { method, headers: { "cf-ray": "public-edge", "x-forwarded-for": "127.0.0.1" } });
        expect(res.status).toBe(404);
        expect(await res.text()).toBe("not found");
      }
    }
    const publicHost = await api("/", { headers: { host: "example.trycloudflare.com" } });
    expect(publicHost.status).toBe(404);
    expect((await api("/")).status).toBe(200);
    expect((await api("/api/nodes")).status).toBe(200);
  });

  test("public inference requires an API key, never an admin token or cookie", async () => {
    const credentials: Record<string, string>[] = [{}, { authorization: "Bearer wrong" }, { authorization: `Bearer ${cfg.adminToken}` }, { cookie: `swarmlet_admin=${cfg.adminToken}` }];
    for (const headers of credentials) {
      const response = await fetch(base + "/v1/models", { headers: { ...headers, "cf-ray": "public-edge" } });
      expect(response.status).toBe(401);
    }
    const key = ctl.reg.createApiKey("public-test");
    const response = await fetch(base + "/v1/models", { headers: { authorization: `Bearer ${key}`, "cf-ray": "public-edge" } });
    expect(response.status).toBe(200);
    expect((await response.json() as { object: string }).object).toBe("list");
    expect((await fetch(base + "/api/nodes", { headers: { authorization: `Bearer ${key}`, "cf-ray": "public-edge" } })).status).toBe(404);
  });

  test("local access requires both a private peer and local Host; forwarding never grants access", () => {
    const req = (host: string, headers: HeadersInit = {}) => new Request(`http://${host}/api/nodes`, { headers });
    for (const [host, peer] of [["127.0.0.1", "127.0.0.1"], ["192.168.1.53", "192.168.1.20"], ["localhost", "::1"], ["[::1]", "::ffff:127.0.0.1"], ["10.1.1.2", "172.16.1.2"]]) {
      expect(directLocalRequest(req(host!), peer)).toBe(true);
    }
    for (const peer of ["203.0.113.1", "172.32.1.1", "192.169.1.1", "", null]) expect(directLocalRequest(req("127.0.0.1"), peer)).toBe(false);
    expect(directLocalRequest(req("public.example"), "127.0.0.1")).toBe(false);
    for (const h of ["cf-ray", "cf-connecting-ip", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]) {
      expect(directLocalRequest(req("localhost", { [h]: "" }), "127.0.0.1")).toBe(false);
    }
  });

  test("public agent WebSocket still requires a registered signed identity", async () => {
    // Bun supports client headers; the shared DOM constructor type does not expose them.
    const Socket = WebSocket as unknown as { new(url: string, options: { headers: Record<string, string> }): WebSocket };
    const ws = new Socket(base.replace("http:", "ws:") + "/agent", { headers: { "cf-ray": "public-edge" } });
    const outcome = await new Promise<{ challenge: string; code: number }>((resolve, reject) => {
      let challenge = "";
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.t === "challenge") {
          challenge = msg.nonce;
          ws.send(JSON.stringify({ t: "pong", ts: new Date().toISOString() }));
        }
      };
      ws.onclose = (ev) => resolve({ challenge, code: ev.code });
      ws.onerror = () => reject(new Error("agent websocket failed"));
    });
    expect(outcome.challenge.length).toBeGreaterThan(0);
    expect(outcome.code).toBe(1008);
  });

  test("live tabs leave API capacity and release their stream slots on disconnect", async () => {
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    const aborts: AbortController[] = [];
    try {
      for (let i = 0; i < 4; i++) {
        const abort = new AbortController(); aborts.push(abort);
        const res = await api("/api/stream", { signal: abort.signal });
        expect(res.status).toBe(200);
        const reader = res.body!.getReader(); readers.push(reader);
        expect(new TextDecoder().decode((await reader.read()).value)).toContain('"t":"snapshot"');
      }
      const denied = await api("/api/stream");
      expect(denied.status).toBe(503);
      expect(await denied.json()).toEqual({ error: "live stream limit; polling remains available" });
      expect((await api("/api/nodes")).status).toBe(200);
      aborts.shift()!.abort();
      await readers.shift()!.cancel();
      let replacement: Response | undefined;
      for (let i = 0; i < 50; i++) {
        replacement = await api("/api/stream");
        if (replacement.status === 200) break;
        await replacement.text();
        await Bun.sleep(20);
      }
      expect(replacement!.status).toBe(200);
      readers.push(replacement!.body!.getReader());
      // Cancellation must release exactly one slot, even if abort and cancel both fire.
      const stillFull = await api("/api/stream");
      expect(stillFull.status).toBe(503);
      await stillFull.text();
    } finally {
      aborts.forEach((abort) => abort.abort());
      await Promise.all(readers.map((reader) => reader.cancel()));
    }
  });

  test("enrollment refuses unknown, expired and reused codes, and bad signatures", async () => {
    const paths = agentPaths(mkdtempSync(join(tmpdir(), "swarmlet-agent-x-")));
    const id = await loadIdentity(paths);
    await expect(enroll(base, "NOPE00", id, capsFor("x"))).rejects.toThrow(/unknown join code/);
    const expired = ctl.reg.createJoinCode(-1);
    await expect(enroll(base, expired.code, id, capsFor("x"))).rejects.toThrow(/expired/);
    const { code } = (await (await api("/api/join-codes", { method: "POST" })).json()) as { code: string };
    // tampered signature: sign, then change a field
    const bodyRes = await fetch(`${base}/enroll`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, nodeId: id.nodeId, pubJwk: id.pubJwk, certFp: id.certFp, hostname: "x", caps: capsFor("x"), signature: "AAAA" }) });
    expect(bodyRes.status).toBe(401);
    await enroll(base, code, id, capsFor("x"));
    const other = await loadIdentity(agentPaths(mkdtempSync(join(tmpdir(), "swarmlet-agent-y-"))));
    await expect(enroll(base, code, other, capsFor("y"))).rejects.toThrow(/already used/);
  });

  test("two agents enroll, authenticate, and appear online with offer and capabilities", async () => {
    const c1 = (await (await api("/api/join-codes", { method: "POST" })).json()) as { code: string };
    const c2 = (await (await api("/api/join-codes", { method: "POST" })).json()) as { code: string };
    a = await makeAgent("alpha", c1.code);
    b = await makeAgent("beta", c2.code);
    const nodes = ((await (await api("/api/nodes")).json()) as { nodes: Array<{ id: string; online: boolean; hostname: string; offer: Offer | null; caps: Capabilities | null }> }).nodes;
    const na = nodes.find((n) => n.id === a.id.nodeId)!;
    expect(na.online).toBe(true);
    expect(na.hostname).toBe("alpha");
    expect(na.offer?.ramMiB).toBe(8000);
    expect(na.caps?.gpus[0]?.engineName).toBe("CUDA0");
    expect(a.client.inferenceKey).toBe(ctl.reg.nodeApiKey(a.id.nodeId));
    expect(ctl.reg.hasApiKey(a.client.inferenceKey!)).toBe(true);
    expect(a.client.inferenceKey).not.toBe(b.client.inferenceKey);
  });

  test("assignments are dispatched and state changes flow back", async () => {
    const stop: Assignment = { kind: "stop", id: "as-1", deploymentId: "dep-1" };
    expect(ctl.channel.assign(a.id.nodeId, stop)).toBe(true);
    for (let i = 0; i < 50 && ctl.reg.getAssignment("as-1")?.state !== "ready"; i++) await Bun.sleep(20);
    expect(a.assigned[0]?.id).toBe("as-1");
    expect(ctl.reg.getAssignment("as-1")?.state).toBe("ready");
    expect(ctl.reg.getAssignment("as-1")?.detail).toBe("fake");
  });

  test("10 MB relay alpha -> control -> beta -> local TCP echo comes back bit-exact", async () => {
    // beta hosts a TCP echo server on an allowed port
    const echo: NetServer = createServer((sock) => sock.pipe(sock));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    const port = (echo.address() as { port: number }).port;
    b.allowed.add(port);
    // alpha opens a relay towards beta's port and pumps data through a local socket pair for realism
    const payload = new Uint8Array(10 * 1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + (i >> 10)) & 0xff;
    const stream = a.client.openRelay(b.id.nodeId, port)!;
    expect(stream).not.toBeNull();
    const chunks: Uint8Array[] = []; let got = 0;
    const done = new Promise<void>((resolve) => {
      stream.onData((c) => { chunks.push(c.slice()); got += c.length; if (got >= payload.length) { stream.close("done"); resolve(); } });
      stream.onEnd(() => resolve());
    });
    for (let off = 0; off < payload.length; off += 65536) stream.write(payload.subarray(off, off + 65536));
    await done;
    const back = new Uint8Array(got); let o = 0; for (const c of chunks) { back.set(c, o); o += c.length; }
    expect(got).toBe(payload.length);
    expect(Buffer.compare(Buffer.from(back), Buffer.from(payload))).toBe(0);
    echo.close();
  });

  test("relay to a non-allowed port or an offline node is rejected", async () => {
    const s1 = a.client.openRelay(b.id.nodeId, 1)!;
    const r1 = await new Promise<string | undefined>((r) => s1.onEnd(r));
    expect(r1).toBeDefined();
    const s2 = a.client.openRelay("0000000000000000", 50200)!;
    const r2 = await new Promise<string | undefined>((r) => s2.onEnd(r));
    expect(r2).toBe("rejected");
  });

  test("control-initiated data stream reaches an allowed local port (router path)", async () => {
    const echo: NetServer = createServer((sock) => sock.pipe(sock));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    const port = (echo.address() as { port: number }).port;
    a.allowed.add(port);
    const s = ctl.channel.openStream(a.id.nodeId, { kind: "http", port })!;
    const got = new Promise<string>((r) => s.onData((c) => r(new TextDecoder().decode(c))));
    s.write(new TextEncoder().encode("hello over mux"));
    expect(await got).toBe("hello over mux");
    s.close();
    echo.close();
    void pipe;
  });

  test("disconnect marks the node offline", async () => {
    b.client.stop();
    for (let i = 0; i < 50 && ctl.channel.isOnline(b.id.nodeId); i++) await Bun.sleep(20);
    expect(ctl.channel.isOnline(b.id.nodeId)).toBe(false);
    expect(ctl.reg.getNode(b.id.nodeId)?.online).toBe(false);
    a.client.stop();
  });
});
