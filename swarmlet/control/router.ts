// OpenAI-compatible router: /v1/models lists served models; /v1/chat/completions, /v1/completions
// and /v1/embeddings are forwarded (streaming passthrough) to a ready deployment serving the
// requested model. Policy: least in-flight, then lowest measured RTT. Transport: a TunnelPool port
// on this host that carries the connection over the node's agent channel to its llama-server.

import type { DeploymentManager } from "./deployments.ts";
import type { Logger } from "./log.ts";
import type { TunnelPool } from "./tunnel.ts";

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const HOP_HEADERS = new Set(["host", "authorization", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"]);

export function createRouter(deps: { deployments: DeploymentManager; tunnels: TunnelPool; log: Logger }) {
  return async (req: Request, path: string): Promise<Response> => {
    const table = deps.deployments.routing();
    if (path === "/v1/models") {
      return json({ object: "list", data: table.map((m) => ({ id: m.modelName, object: "model", owned_by: "swarmlet", ready: m.deployments.length })) });
    }
    if (!["/v1/chat/completions", "/v1/completions", "/v1/embeddings"].includes(path)) return json({ error: { message: `unsupported path ${path}`, type: "invalid_request_error" } }, 404);
    if (req.method !== "POST") return json({ error: { message: "POST required", type: "invalid_request_error" } }, 405);
    const bodyText = await req.text();
    let model: string | undefined;
    try { model = (JSON.parse(bodyText) as { model?: string }).model; } catch { return json({ error: { message: "body is not JSON", type: "invalid_request_error" } }, 400); }
    const candidates = model ? table.find((m) => m.modelName === model)?.deployments ?? [] : (table.length === 1 ? table[0]!.deployments : []);
    if (!candidates.length) return json({ error: { message: model ? `no ready deployment serves model '${model}'` : "specify a model (see /v1/models)", type: "invalid_request_error", available: table.map((m) => m.modelName) } }, 404);
    const pick = [...candidates].sort((a, b) => (a.inflight - b.inflight) || ((a.rttMs ?? 1e9) - (b.rttMs ?? 1e9)))[0]!;
    const local = await deps.tunnels.localPort(pick.nodeId, pick.port);
    const headers = new Headers();
    for (const [k, v] of req.headers) if (!HOP_HEADERS.has(k.toLowerCase())) headers.set(k, v);
    headers.set("content-type", "application/json");
    deps.deployments.trackInflight(pick.id, +1);
    const t0 = Date.now();
    try {
      const upstream = await fetch(`http://127.0.0.1:${local}${path}`, { method: "POST", headers, body: bodyText, signal: AbortSignal.timeout(30 * 60_000) });
      const out = new Headers(upstream.headers);
      out.set("x-swarmlet-deployment", pick.id);
      out.set("x-swarmlet-node", pick.nodeId);
      if (!upstream.body) { deps.deployments.trackInflight(pick.id, -1); return new Response(null, { status: upstream.status, headers: out }); }
      // release the in-flight slot when the body finishes streaming
      const body = upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        flush: () => { deps.deployments.trackInflight(pick.id, -1); deps.log.debug("routed", { path, deployment: pick.id, ms: Date.now() - t0 }); },
      }));
      return new Response(body, { status: upstream.status, headers: out });
    } catch (e) {
      deps.deployments.trackInflight(pick.id, -1);
      deps.log.warn("upstream failed", { deployment: pick.id, err: (e as Error).message });
      return json({ error: { message: `upstream failed: ${(e as Error).message}`, type: "server_error" } }, 502);
    }
  };
}
