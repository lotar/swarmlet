// HTTP + WebSocket server for the control plane. Routes:
//   GET  /health                      liveness
//   POST /enroll                      node enrollment (join code)
//   GET  /agent                       WebSocket upgrade for node agents
//   GET/POST /probe/*                 bandwidth / RTT / public-ip probes used by agents
//   *    /api/*                       admin JSON API (Bearer admin token or cookie)
//   *    /v1/*                        OpenAI-compatible router (Bearer API key)   [router.ts]
//   GET  /                            web UI                                      [ui/ui.ts]

import type { Server } from "bun";
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
import { TunnelPool } from "./tunnel.ts";
import { serveUi } from "./ui/ui.ts";

export interface ControlDeps {
  cfg: ControlConfig;
  reg: Registry;
  channel: AgentChannel;
  log: Logger;
  deployments: DeploymentManager;
  profiles: Map<string, import("../protocol/types.ts").ModelProfile>;
  router: (req: Request, path: string) => Promise<Response>;
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

function adminOk(req: Request, cfg: ControlConfig, remoteIp?: string | null): boolean {
  if (bearer(req) === cfg.adminToken) return true;
  if (cfg.adminTrustLoopback && (remoteIp === "127.0.0.1" || remoteIp === "::1" || remoteIp === "::ffff:127.0.0.1")) return true;
  const cookie = req.headers.get("cookie") ?? "";
  return cookie.split(/;\s*/).some((c) => c === `swarmlet_admin=${cfg.adminToken}`);
}

const PROBE_MAX = 32 * 1024 * 1024;

export function createControlServer(deps: ControlDeps): Server<ConnData> {
  const { cfg, reg, channel, log, deployments } = deps;
  const publicJwk = () => readPublicJwk(`${cfg.dataDir}/keys`);

  const api = async (req: Request, path: string): Promise<Response> => {
    const url = new URL(req.url);
    const seg = path.split("/").filter(Boolean); // ["api", ...]
    const m = req.method;
    if (seg[1] === "nodes" && m === "GET" && seg.length === 2) {
      const live = deployments.liveTokPerSecByNode();
      return json({ nodes: reg.listNodes().map((n) => ({ ...n, pubJwk: undefined, online: channel.isOnline(n.id), routedTokPerSec: live.get(n.id) ?? 0 })) });
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
    if (seg[1] === "profiles" && m === "GET") return json({ profiles: [...deps.profiles.values()].map((p) => ({ id: p.id, name: p.name, modelName: p.modelName, layers: p.layers, envelope: p.envelope })) });
    if (seg[1] === "routing" && m === "GET") { const models = deployments.routing(); return json({ models, totals: { inflight: models.reduce((n, mm) => n + mm.deployments.reduce((k, d) => k + d.inflight, 0), 0) } }); }
    if (seg[1] === "deployments") {
      const d = deployments;
      if (m === "GET" && seg.length === 2) return json({ deployments: reg.listDeployments() });
      if (m === "POST" && seg.length === 2) { const spec = (await req.json()) as DeploymentSpec; try { return json(await d.create(spec), 201); } catch (e) { return json({ error: (e as Error).message }, 400); } }
      if (m === "POST" && seg[2] === "plan-preview") { try { return json(await d.planPreview((await req.json()) as DeploymentSpec)); } catch (e) { return json({ error: (e as Error).message }, 400); } }
      if (seg[2] && m === "GET" && seg.length === 3) { const dep = reg.getDeployment(seg[2]); return dep ? json({ ...dep, assignments: reg.listAssignments(dep.id) }) : json({ error: "not found" }, 404); }
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
        if (path === "/health") return json({ status: "ok", nodes: channel.onlineNodeIds().length });
        if (path === "/enroll" && req.method === "POST") {
          const out = await handleEnroll(reg, await req.json().catch(() => null));
          if (!out.ok) return json({ error: out.error }, out.status);
          return json({ ok: true, nodeId: out.nodeId, controlPubJwk: await publicJwk(), agentUrl: cfg.publicUrl.replace(/^http/, "ws") + "/agent" });
        }
        if (path === "/agent") {
          if (srv.upgrade(req, { data: channel.newConnData() })) return undefined as unknown as Response;
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
            if (!adminOk(req, cfg, srv.requestIP(req)?.address)) return json({ error: { message: "invalid api key", type: "auth" } }, 401);
          }
          return deps.router(req, path);
        }
        if (path.startsWith("/api/")) {
          if (!adminOk(req, cfg, srv.requestIP(req)?.address)) return json({ error: "admin token required" }, 401);
          return api(req, path);
        }
        if (path === "/login" && req.method === "POST") {
          const body = await req.formData().catch(() => null);
          const token = body?.get("token");
          if (token !== cfg.adminToken) return new Response("bad token", { status: 401 });
          return new Response(null, { status: 303, headers: { location: "/", "set-cookie": `swarmlet_admin=${cfg.adminToken}; Path=/; HttpOnly; SameSite=Strict` } });
        }
        if (path === "/logout") return new Response(null, { status: 303, headers: { location: "/", "set-cookie": "swarmlet_admin=; Path=/; Max-Age=0" } });
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
      message: (ws, msg) => { void channel.message(ws, msg as string | Buffer); },
      close: (ws) => channel.close(ws),
    },
  });
  return server;
}

/** Boot a complete control plane (registry, channel, planner profiles, deployments, router, UI). */
export async function bootControl(cfg: ControlConfig, opts: { profilesDir?: string } = {}): Promise<{
  server: Server<ConnData>; reg: Registry; channel: AgentChannel; log: Logger; deployments: DeploymentManager; tunnels: TunnelPool;
}> {
  const log = makeLogger("control", cfg.logLevel);
  await ensureKeys(`${cfg.dataDir}/keys`);
  const reg = new Registry(`${cfg.dataDir}/control.sqlite`);
  const hooks: ChannelHooks = {};
  const channel = new AgentChannel(reg, log, hooks);
  const profiles = loadProfiles(opts.profilesDir);
  const deployments = new DeploymentManager({ reg, channel, profiles, log });
  hooks.onAssignmentState = (nodeId, id, state, detail) => deployments.onAssignmentState(nodeId, id, state, detail);
  hooks.onHello = (nodeId, hello) => deployments.onHello(nodeId, hello.assignments);
  hooks.onOffline = (nodeId) => { tunnels.close(nodeId); deployments.onOffline(nodeId); };
  const tunnels = new TunnelPool(channel, log);
  const router = createRouter({ deployments, tunnels, log });
  const server = createControlServer({ cfg, reg, channel, log, deployments, profiles, router });
  log.info(`control listening on http://${cfg.host}:${server.port} (data ${cfg.dataDir}, ${profiles.size} profiles)`);
  return { server, reg, channel, log, deployments, tunnels };
}
