// HTTP + WebSocket server for the control plane. Routes:
//   GET  /health                      liveness
//   POST /enroll                      node enrollment (join code)
//   GET  /agent                       WebSocket upgrade for node agents
//   GET/POST /probe/*                 bandwidth / RTT / public-ip probes used by agents
//   *    /api/*                       admin JSON API (Bearer admin token or cookie)
//   *    /v1/*                        OpenAI-compatible router (Bearer API key)   [router.ts]
//   GET  /                            web UI                                      [ui/ui.ts]

import type { Server } from "bun";
import { isIP } from "node:net";
import { validateOffer } from "../protocol/validate.ts";
import { ensureKeys, readPublicJwk } from "../protocol/sign.ts";
import type { DeploymentSpec } from "../protocol/types.ts";
import { AgentChannel, type ChannelHooks, type ConnData } from "./channel.ts";
import type { ControlConfig } from "./config.ts";
import { DeploymentManager } from "./deployments.ts";
import { handleEnroll } from "./enroll.ts";
import { makeLogger, type Logger } from "./log.ts";
import { loadProfiles } from "./planner.ts";
import { Registry } from "./registry.ts";
import { createRouter } from "./router.ts";
import { TelemetryStore } from "./telemetry.ts";
import { telemetryResponse } from "./telemetry-response.ts";
import { TunnelPool } from "./tunnel.ts";
import { serveUi } from "./ui/ui.ts";
import { processingSnapshot } from "./processing.ts";
import { modelCatalog } from "./catalog.ts";
import { authenticatedReleaseRead, serveRelease } from "./releases.ts";
import { createUpdateLeaseHandler } from "./update-lease.ts";

export interface ControlDeps {
  cfg: ControlConfig;
  reg: Registry;
  channel: AgentChannel;
  log: Logger;
  deployments: DeploymentManager;
  telemetry?: TelemetryStore;
  profiles: Map<string, import("../protocol/types.ts").ModelProfile>;
  router: (req: Request, path: string, observation?: { failed: boolean }) => Promise<Response>;
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

function adminOk(req: Request, cfg: ControlConfig, remoteIp?: string | null): boolean {
  if (bearer(req) === cfg.adminToken) return true;
  if (cfg.adminTrustLoopback && directLocalRequest(req, remoteIp) && (remoteIp === "127.0.0.1" || remoteIp === "::1" || remoteIp === "::ffff:127.0.0.1")) return true;
  const cookie = req.headers.get("cookie") ?? "";
  return cookie.split(/;\s*/).some((c) => c === `swarmlet_admin=${cfg.adminToken}`);
}

const PROBE_MAX = 32 * 1024 * 1024;

function privateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "").replace(/^::ffff:/, "");
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 127 || a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
  }
  return isIP(ip) === 6 && (ip === "::1" || /^(fc|fd|fe[89ab])/.test(ip));
}

/** Only direct LAN/loopback requests may reach the web/admin surface.
 * Cloudflared connects from loopback, so socket address alone is insufficient.
 * Forwarding headers can only remove access; they never establish local trust. */
export function directLocalRequest(req: Request, remoteIp: string | null | undefined): boolean {
  if (["cf-ray", "cf-connecting-ip", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"].some((h) => req.headers.has(h))) return false;
  const host = new URL(req.url).hostname;
  return !!remoteIp && privateAddress(remoteIp) && (host === "localhost" || privateAddress(host));
}

export function createControlServer(deps: ControlDeps): Server<ConnData> {
  const { cfg, reg, channel, log, deployments } = deps;
  const publicJwk = () => readPublicJwk(`${cfg.dataDir}/keys`);
  let updateSigningKey: Promise<CryptoKey> | undefined;
  const updateLease = createUpdateLeaseHandler(reg, deployments, () => updateSigningKey ??= Bun.file(`${cfg.dataDir}/keys/private.jwk.json`).json()
    .then(jwk => crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"])));

  const nodesSnapshot = () => {
    const live = deployments.liveTokPerSecByNode();
    return reg.listNodes().map((n) => { const r = channel.relayRate(n.id); return { ...n, pubJwk: undefined, online: channel.isOnline(n.id), via: channel.via(n.id), link: channel.link(n.id), routedTokPerSec: live.get(n.id) ?? 0, relayInBps: r.inBps, relayOutBps: r.outBps }; });
  };

  // HTTP/1.1 browsers share six connections across tabs. Reserve two for ordinary
  // API/chat requests, including tabs still running an older UI without visibility cleanup.
  const streamsByClient = new Map<string, number>();
  const api = async (req: Request, path: string, client: string): Promise<Response> => {
    const url = new URL(req.url);
    const seg = path.split("/").filter(Boolean); // ["api", ...]
    const m = req.method;
    if (seg[1] === 'telemetry' && seg.length === 2 && m === 'GET') {
      if (!deps.telemetry) return json({ error: 'Telemetry unavailable' }, 503);
      const ranges: Record<string, number> = { '1h': 3600000, '6h': 21600000, '24h': 86400000, '72h': 259200000 };
      const range = url.searchParams.get('range') ?? '1h';
      if (!ranges[range]) return json({ error: 'Choose 1h, 6h, 24h or 72h' }, 400);
      try { return json(deps.telemetry.query({ rangeMs: ranges[range], source: url.searchParams.get('node') || undefined })); }
      catch { return json({ error: 'Telemetry could not be read. Check the selected node and storage availability.' }, 400); }
    }
    if (seg[1] === 'fleet') {
      if (m === 'GET' && seg.length === 2) return json(deployments.fleetSnapshot());
      if (m === 'POST' && seg[2] === 'preview' && seg.length === 3) {
        try { return json(await deployments.previewAllocation(await req.json())); } catch (e) { return json({ error: (e as Error).message }, 400); }
      }
      if (seg[2] && m === 'GET' && seg.length === 3) { const run = reg.fleetRun(seg[2]); return run ? json(run) : json({ error: 'Allocation not found' }, 404); }
      if (seg[2] && seg[3] === 'apply' && m === 'POST' && seg.length === 4) {
        try { return json(deployments.applyAllocation(seg[2]), 202); } catch (e) { return json({ error: (e as Error).message }, 409); }
      }
    }
    if (seg[1] === "nodes" && m === "GET" && seg.length === 2) return json({ nodes: nodesSnapshot() });
    if (seg[1] === "stream" && m === "GET") {
      if ((streamsByClient.get(client) ?? 0) >= 4) {
        return new Response(JSON.stringify({ error: "live stream limit; polling remains available" }), {
          status: 503, headers: { "content-type": "application/json", "retry-after": "5", "cache-control": "no-store" },
        });
      }
      streamsByClient.set(client, (streamsByClient.get(client) ?? 0) + 1);
      // server-sent events: a nodes + routing snapshot every second while the browser listens
      const enc = new TextEncoder();
      let timer: ReturnType<typeof setInterval> | null = null;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (timer) clearInterval(timer);
        req.signal.removeEventListener("abort", release);
        const count = (streamsByClient.get(client) ?? 1) - 1;
        if (count > 0) streamsByClient.set(client, count); else streamsByClient.delete(client);
      };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (req.signal.aborted) { release(); controller.close(); return; }
          req.signal.addEventListener("abort", release, { once: true });
          const push = () => {
            if (released) return;
            try { controller.enqueue(enc.encode(`data: ${JSON.stringify({ t: "snapshot", ts: new Date().toISOString(), nodes: nodesSnapshot(), routing: deployments.routing(), relayStreams: channel.openRelayStreams })}\n\n`)); }
            catch { release(); }
          };
          push();
          if (!released) timer = setInterval(push, 1000);
        },
        cancel() { release(); },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
    }
    if (seg[1] === "nodes" && seg[2] && m === "GET" && seg.length === 3) { const n = reg.getNode(seg[2]); return n ? json({ ...n, online: channel.isOnline(n.id) }) : json({ error: "not found" }, 404); }
    if (seg[1] === "nodes" && seg[2] && seg[3] === "offer" && m === "PUT") {
      const n = reg.getNode(seg[2]); if (!n?.caps) return json({ error: "node or capabilities unknown" }, 404);
      const v = validateOffer(await req.json(), n.caps); if (!v.ok) return json({ errors: v.errors }, 400);
      return json({ ok: true, warnings: v.warnings, note: "offers are changed on the node; this only validates" });
    }
    if (seg[1] === "join-codes" && m === "POST") return json(reg.createJoinCode());
    if (seg[1] === "events" && m === "GET") return json({ events: reg.listEvents(Number(url.searchParams.get("limit") ?? 200)) });
    if (seg[1] === "api-keys" && m === "GET") return json({ keys: reg.listApiKeys() });
    if (seg[1] === "api-keys" && m === "POST") { const b = (await req.json().catch(() => ({}))) as { name?: string }; return json({ key: reg.createApiKey(b.name ?? "default") }); }
    if (seg[1] === "assignments" && seg[2] && seg[3] === "logs" && m === "GET") return json({ lines: channel.recentLogs(seg[2]) });
    if (seg[1] === "assignments" && m === "GET") return json({ assignments: reg.listAssignments(url.searchParams.get("deployment") ?? undefined) });
    if (seg[1] === "profiles" && m === "GET") return json({ profiles: [...deps.profiles.values()].map((p) => ({ id: p.id, name: p.name, modelName: p.modelName, layers: p.layers, layerMiB: p.layerMiB, boundaryBytes: p.boundaryBytes, coordinatorHostMiB: p.coordinatorHostMiB, envelope: p.envelope })) });
    if (seg[1] === "routing" && m === "GET") { const models = deployments.routing(); return json({ models, totals: { inflight: models.reduce((n, mm) => n + mm.deployments.reduce((k, d) => k + d.inflight, 0), 0) } }); }
    if (seg[1] === "deployments") {
      const d = deployments;
      if (m === "GET" && seg.length === 2) return json({ deployments: reg.listDeployments() });
      if (m === "POST" && seg.length === 2) { const spec = (await req.json()) as DeploymentSpec; try { return json(await d.create(spec), 201); } catch (e) { return json({ error: (e as Error).message }, 400); } }
      if (m === "POST" && seg[2] === "plan-preview") { try { return json(await d.planPreview((await req.json()) as DeploymentSpec, url.searchParams.get('replaces') ?? undefined)); } catch (e) { return json({ error: (e as Error).message }, 400); } }
      if (seg[2] && m === "GET" && seg.length === 3) { const dep = reg.getDeployment(seg[2]); return dep ? json({ ...dep, assignments: reg.listAssignments(dep.id) }) : json({ error: "not found" }, 404); }
      if (seg[2] && seg[3] === "distribution" && seg.length === 4 && m === "PUT") {
        try { return json(d.saveDistribution(seg[2], await req.json())); } catch (e) { return json({ error: (e as Error).message }, 400); }
      }
      if (seg[2] && seg[3] === "distribution" && seg[4] === "apply" && seg.length === 5 && m === "POST") {
        try { return json(d.applyDistribution(seg[2]), 202); } catch (e) { return json({ error: (e as Error).message }, 400); }
      }
      if (seg[2] && seg[3] === "start" && m === "POST") {
        // start runs in the background: the UI polls state; errors land in deployment.error
        const id = seg[2];
        try { reg.getDeployment(id) ?? (() => { throw new Error("not found"); })(); } catch (e) { return json({ error: (e as Error).message }, 404); }
        void d.start(id).catch((e: Error) => log.warn("start failed", { id, err: e.message }));
        return json({ ok: true, started: id });
      }
      if (seg[2] && seg[3] === "stop" && m === "POST") { try { await d.stop(seg[2]); return json({ ok: true }); } catch (e) { return json({ error: (e as Error).message }, 400); } }
      if (seg[2] && m === "DELETE" && seg.length === 3) { try { await d.remove(seg[2]); return json({ ok: true }); } catch (e) { return json({ error: (e as Error).message }, 400); } }
    }
    if (seg[1] === "whoami") return json({ admin: true, publicUrl: cfg.publicUrl });
    return json({ error: "no such route" }, 404);
  };

  const server = Bun.serve<ConnData>({
    hostname: cfg.host,
    port: cfg.port,
    idleTimeout: 255,
    maxRequestBodySize: 64 * 1024 * 1024,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;
      try {
        // Public web is an explicit deployment choice. Otherwise only signed agent transport
        // and API-key inference cross this boundary; other routes remain private.
        const agentUpgrade = path === "/agent" && req.method === "GET" && req.headers.get("upgrade")?.toLowerCase() === "websocket";
        const localRequest = directLocalRequest(req, srv.requestIP(req)?.address);
        const signedUpdatePath = path.startsWith("/releases/") || path === "/node-update-lease";
        if (!cfg.publicWeb && !localRequest && !agentUpgrade && !path.startsWith("/v1/") && !signedUpdatePath) {
          return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
        }
        if (path === "/health") return json({ status: "ok", nodes: channel.onlineNodeIds().length });
        if (path.startsWith("/releases/")) {
          if (!await authenticatedReleaseRead(req, reg)) return new Response("not found", { status: 404 });
          return serveRelease(cfg.dataDir, req);
        }
        if (path === "/node-update-lease") return updateLease(req);
        if (path === "/enroll" && req.method === "POST") {
          const out = await handleEnroll(reg, await req.json().catch(() => null), localRequest && cfg.lanAutoEnroll === true);
          if (!out.ok) return json({ error: out.error }, out.status);
          // the agent connects back through whatever path it enrolled on (LAN address, or a tunnel hostname)
          const fwdProto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
          const fwdHost = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(cfg.publicUrl).host;
          const agentUrl = `${fwdProto === "https" ? "wss" : "ws"}://${fwdHost}/agent`;
          return json({ ok: true, nodeId: out.nodeId, controlPubJwk: await publicJwk(), agentUrl });
        }
        if (path === "/agent") {
          // remember how this agent reached us: LAN address, or a tunnel hostname behind the Cloudflare edge
          const via = {
            host: req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host,
            proto: req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", ""),
            edge: req.headers.has("cf-ray") || req.headers.has("cf-connecting-ip"),
          };
          if (srv.upgrade(req, { data: channel.newConnData(via) })) return undefined as unknown as Response;
          return new Response("expected websocket", { status: 426 });
        }
        if (path === "/probe/down") {
          const n = Math.min(PROBE_MAX, Math.max(0, Number(url.searchParams.get("bytes") ?? 8_000_000)));
          return new Response(new Uint8Array(n), { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
        }
        if (path === "/probe/up" && req.method === "POST") { const buf = await req.arrayBuffer(); return json({ bytes: buf.byteLength }); }
        if (path === "/probe/ip") return json({ ip: req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? srv.requestIP(req)?.address ?? null });
        if (path.startsWith("/v1/")) {
          const key = bearer(req);
          if (!key || !reg.hasApiKey(key)) {
            if ((!localRequest && !cfg.publicWeb) || !adminOk(req, cfg, srv.requestIP(req)?.address)) return json({ error: { message: "invalid api key", type: "auth" } }, 401);
          }
          if (path === "/v1/models" && url.searchParams.get("catalog") === "1") {
            if (req.method !== "GET") return json({ error: { message: "GET required" } }, 405);
            const node = reg.getNode(url.searchParams.get("node") ?? "");
            return json(modelCatalog(deps.profiles.values(), deployments.routing(), node ? { ...node, online: channel.isOnline(node.id) } : null));
          }
          if (path === "/v1/mesh") {
            if (req.method !== "GET") return json({ error: { message: "GET required" } }, 405);
            const snapshot = processingSnapshot(deps, url);
            return snapshot ? json(snapshot) : json({ error: { message: "No deployment available for this model" } }, 404);
          }
          const started = performance.now();
          const observation = { failed: false };
          const response = await deps.router(req, path, observation);
          return deps.telemetry ? telemetryResponse(req, response, started, deps.telemetry, observation) : response;
        }
        if (path.startsWith("/api/")) {
          if (!adminOk(req, cfg, srv.requestIP(req)?.address)) return json({ error: "admin token required" }, 401);
          return api(req, path, srv.requestIP(req)?.address ?? "unknown");
        }
        if (path === "/login" && req.method === "POST") {
          const body = await req.formData().catch(() => null);
          const token = body?.get("token");
          if (token !== cfg.adminToken) return new Response("bad token", { status: 401 });
          return new Response(null, { status: 303, headers: { location: "/", "set-cookie": `swarmlet_admin=${cfg.adminToken}; Path=/; HttpOnly; SameSite=Strict${cfg.publicUrl.startsWith("https:") ? "; Secure" : ""}` } });
        }
        if (path === "/logout") return new Response(null, { status: 303, headers: { location: "/", "set-cookie": `swarmlet_admin=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${cfg.publicUrl.startsWith("https:") ? "; Secure" : ""}` } });
        const ui = serveUi(req, path);
        if (ui) return ui;
        return new Response("not found", { status: 404 });
      } catch (e) {
        log.error("request failed", { path, err: (e as Error).message });
        return json({ error: "internal error" }, 500);
      }
    },
    websocket: {
      maxPayloadLength: 16 * 1024 * 1024,
      open: (ws) => channel.open(ws),
      drain: (ws) => channel.drain(ws),
      message: (ws, msg) => { void channel.message(ws, msg as string | Buffer).catch((e) => {
        log.warn("agent message failed", { nodeId: ws.data.nodeId, err: String(e) });
        ws.close(1011, "message processing failed");
      }); },
      close: (ws) => channel.close(ws),
    },
  });
  return server;
}

/** Boot a complete control plane (registry, channel, planner profiles, deployments, router, UI). */
export async function bootControl(cfg: ControlConfig, opts: { profilesDir?: string } = {}): Promise<{
  server: Server<ConnData>; reg: Registry; channel: AgentChannel; log: Logger; deployments: DeploymentManager; tunnels: TunnelPool; telemetry?: TelemetryStore;
}> {
  const log = makeLogger("control", cfg.logLevel);
  await ensureKeys(`${cfg.dataDir}/keys`);
  const reg = new Registry(`${cfg.dataDir}/control.sqlite`);
  let telemetry: TelemetryStore | undefined;
  try { telemetry = new TelemetryStore(`${cfg.dataDir}/telemetry`); }
  catch { log.warn("telemetry storage unavailable; control and inference remain available"); }
  const hooks: ChannelHooks = {};
  const channel = new AgentChannel(reg, log, hooks);
  const profiles = loadProfiles(opts.profilesDir);
  const deployments = new DeploymentManager({ reg, channel, profiles, log });
  deployments.restore();
  hooks.onAssignmentState = (nodeId, id, state, detail) => deployments.onAssignmentState(nodeId, id, state, detail);
  hooks.onMetrics = (nodeId, metrics) => { const node = reg.getNode(nodeId); if (node) telemetry?.sample(node, metrics, channel.relayRate(nodeId)); };
  hooks.onHello = (nodeId, hello) => { telemetry?.connection(nodeId, true); deployments.onHello(nodeId, hello.assignments); deployments.onNodeOnline(nodeId); };
  // A connection that went quiet and then answered again keeps its socket (channel.sweep), so no hello is
  // sent: give the deployment layer the same signal a reconnect would have produced.
  hooks.onNodeOnline = (nodeId) => { deployments.onNodeOnline(nodeId); };
  hooks.onOffline = (nodeId) => { telemetry?.connection(nodeId, false); tunnels.close(nodeId); deployments.onOffline(nodeId); };
  const tunnels = new TunnelPool(channel, log);
  const router = createRouter({ deployments, tunnels, log });
  const server = createControlServer({ cfg, reg, channel, log, deployments, profiles, router, telemetry });
  log.info(`control listening on http://${cfg.host}:${server.port} (data ${cfg.dataDir}, ${profiles.size} profiles)`);
  return { server, reg, channel, log, deployments, tunnels, telemetry };
}
