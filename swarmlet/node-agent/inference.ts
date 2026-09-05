// Participant inference gateway: ready local model servers first, otherwise the keyed internet API.
export interface InferenceTarget { model: string; deploymentId: string; url: string }
export interface InferenceDeps {
  local: () => InferenceTarget[];
  remote: () => { url: string; key: string } | null;
  nodeId: () => string;
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const error = (message: string, status: number) => json({ error: { message, type: "invalid_request_error" } }, status);
const paths = new Set(["/v1/chat/completions", "/v1/completions", "/v1/embeddings"]);

export function createNodeInference(deps: InferenceDeps) {
  return async (req: Request, path: string): Promise<Response> => {
    const local = deps.local();
    const remote = deps.remote();
    if (path === "/v1/models") {
      if (req.method !== "GET") return error("GET required", 405);
      const models = new Map(local.map((target) => [target.model, { id: target.model, object: "model", owned_by: "swarmlet", route: "local" }]));
      let meshAvailable = false;
      if (remote) {
        try {
          const res = await fetch(`${remote.url.replace(/\/$/, "")}/v1/models`, {
            headers: { authorization: `Bearer ${remote.key}` }, redirect: "error",
            signal: AbortSignal.any([req.signal, AbortSignal.timeout(5000)]),
          });
          if (res.ok) {
            const body = await res.json() as { data?: Array<{ id: string }> };
            if (Array.isArray(body.data)) {
              meshAvailable = true;
              for (const model of body.data) if (typeof model.id === "string" && !models.has(model.id)) models.set(model.id, { id: model.id, object: "model", owned_by: "swarmlet", route: "mesh" });
            }
          }
        } catch { /* local models remain usable when control cannot be reached */ }
      }
      if (!meshAvailable && !models.size) return error("Mesh unavailable. Connect this node to control and wait for a ready model.", 503);
      return json({ object: "list", data: [...models.values()], mesh_available: meshAvailable });
    }
    if (!paths.has(path)) return error("unsupported inference path", 404);
    if (req.method !== "POST") return error("POST required", 405);
    const text = await req.text();
    let body: { model?: string };
    try {
      body = JSON.parse(text);
      if (!body || typeof body !== "object" || typeof body.model !== "string" || !body.model) return error("model is required (see /v1/models)", 400);
    } catch { return error("body is not JSON", 400); }
    const pinned = req.headers.get("x-swarmlet-deployment");
    const target = local.find((t) => t.model === body.model && (!pinned || t.deploymentId === pinned));
    if (!target && !remote) return error("No local server for this model and the mesh is disconnected.", 503);
    const base = target?.url ?? remote!.url;
    const headers = new Headers({ "content-type": "application/json" });
    // Never pass caller credentials to a model server or trust caller-provided upstream URLs.
    if (!target) headers.set("authorization", `Bearer ${remote!.key}`);
    if (pinned) headers.set("x-swarmlet-deployment", pinned);
    const abort = new AbortController();
    const signal = AbortSignal.any([req.signal, abort.signal, AbortSignal.timeout(30 * 60_000)]);
    try {
      const upstream = await fetch(`${base.replace(/\/$/, "")}${path}`, { method: "POST", body: text, headers, signal, redirect: "error" });
      const out = new Headers({ "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store", "x-swarmlet-route": target ? "local" : "mesh" });
      for (const h of ["x-swarmlet-deployment", "x-swarmlet-node", "retry-after"]) {
        const value = upstream.headers.get(h); if (value) out.set(h, value);
      }
      if (target) { out.set("x-swarmlet-deployment", target.deploymentId); out.set("x-swarmlet-node", deps.nodeId()); }
      if (!upstream.body) return new Response(null, { status: upstream.status, headers: out });
      const reader = upstream.body.getReader();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try { const chunk = await reader.read(); if (chunk.done) controller.close(); else controller.enqueue(chunk.value); }
          catch (e) { controller.error(e); }
        },
        async cancel(reason) { abort.abort(reason); await reader.cancel(reason).catch(() => {}); },
      });
      return new Response(stream, { status: upstream.status, headers: out });
    } catch (e) {
      if (req.signal.aborted) return error("request cancelled", 499);
      return error(`${target ? "Local server" : "Mesh"} unavailable: ${(e as Error).message}`, 502);
    }
  };
}
