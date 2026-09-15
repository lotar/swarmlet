import { inferenceStream } from "../protocol/inference-stream.ts";
import type { ModelDownload } from "../protocol/types.ts";
// Participant inference gateway: ready local model servers first, otherwise the keyed internet API.
export interface InferenceTarget { model: string; deploymentId: string; url: string; created: number }
export interface InferenceDeps {
  local: () => InferenceTarget[];
  remote: () => { url: string; key: string } | null;
  nodeId: () => string;
  admit?: () => (() => void) | null;
  /** Called whenever the control catalog is refreshed, so the node can act on it (e.g. fetch weights). */
  onCatalog?: (models: CatalogModel[]) => void;
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const error = (message: string, status: number) => json({ error: { message, type: "invalid_request_error" } }, status);
const paths = new Set(["/v1/chat/completions", "/v1/completions", "/v1/embeddings"]);
/**
 * Names that always mean "whatever this node is serving", so a client does not have to track which model
 * the mesh happens to have placed. The catalog is the source of truth for what exists; an alias is the
 * source of truth for what to call it when you do not care - and on a mesh that re-decides its model as
 * nodes come and go, not caring is the sane default for a local caller.
 */
const ALIASES = ["local", "swarmlet"];
/** llama-server's own observability, at the root, which an operator's health check reads directly. */
const rootPaths = new Set(["/health", "/metrics", "/props", "/slots"]);
interface CatalogModel {
  id: string; created?: number; ready?: number; local_eligible?: boolean; local_reasons?: string[];
  /** Carried through from the profile so a node owner can fetch weights this node lacks. */
  download?: ModelDownload;
}
interface ListedModel extends CatalogModel { object: string; owned_by: string; route: string; selectable?: boolean }

export function createNodeInference(deps: InferenceDeps) {
  let cachedCatalog: CatalogModel[] = [];
  return async (req: Request, path: string): Promise<Response> => {
    const local = deps.local();
    const remote = deps.remote();
    if (path === "/v1/mesh") {
      if (req.method !== "GET") return error("GET required", 405);
      if (!remote) return error("Mesh telemetry unavailable while disconnected", 503);
      const input = new URL(req.url), url = new URL("/v1/mesh", remote.url);
      const model = input.searchParams.get("model");
      if (model) url.searchParams.set("model", model);
      const pinned = input.searchParams.get("deployment") || local.find((t) => t.model === model)?.deploymentId;
      if (pinned) url.searchParams.set("deployment", pinned);
      try {
        const res = await fetch(url, { headers: { authorization: `Bearer ${remote.key}` }, redirect: "error", signal: AbortSignal.any([req.signal, AbortSignal.timeout(5000)]) });
        return json(await res.json(), res.status);
      } catch { return error("Mesh telemetry unavailable", 503); }
    }
    if (path === "/v1/models") {
      if (req.method !== "GET") return error("GET required", 405);
      const fullCatalog = new URL(req.url).searchParams.get("catalog") === "1";
      const models = new Map<string, ListedModel>(local.map((target) => [target.model, { id: target.model, object: "model", created: target.created, owned_by: "swarmlet", route: "local", ...(fullCatalog ? { selectable: true, local_eligible: true, local_reasons: [] } : {}) }]));
      let meshAvailable = false;
      if (remote) {
        try {
          const suffix = fullCatalog ? `?catalog=1&node=${encodeURIComponent(deps.nodeId())}` : "";
          const res = await fetch(`${remote.url.replace(/\/$/, "")}/v1/models${suffix}`, {
            headers: { authorization: `Bearer ${remote.key}` }, redirect: "error",
            signal: AbortSignal.any([req.signal, AbortSignal.timeout(5000)]),
          });
          if (res.ok) {
            const body = await res.json() as { data?: CatalogModel[] };
            if (Array.isArray(body.data)) {
              meshAvailable = true;
              if (fullCatalog) { cachedCatalog = body.data.filter(model => typeof model.id === "string"); deps.onCatalog?.(cachedCatalog); }
              for (const model of body.data) if (typeof model.id === "string" && !models.has(model.id)) {
                const ready = !fullCatalog || (model.ready ?? 0) > 0;
                models.set(model.id, { id: model.id, object: "model", created: Number.isInteger(model.created) ? model.created! : 0, owned_by: "swarmlet", route: ready ? "mesh" : "unavailable", ...(fullCatalog ? { selectable: ready, local_eligible: model.local_eligible === true, local_reasons: model.local_reasons ?? [], download: model.download } : {}) });
              }
            }
          }
        } catch { /* local models remain usable when control cannot be reached */ }
      }
      if (fullCatalog && !meshAvailable) for (const model of cachedCatalog) if (!models.has(model.id)) models.set(model.id, { id: model.id, object: "model", created: model.created ?? 0, owned_by: "swarmlet", route: "unavailable", selectable: false, local_eligible: false, local_reasons: ["Control is disconnected; local availability cannot be checked."], download: model.download });
      // Exactly one local deployment: publish the stable aliases next to it, so a caller that pins
      // "local" keeps working when the mesh replaces the model underneath (same node, same shape).
      if (local.length === 1) for (const alias of ALIASES) if (!models.has(alias)) {
        models.set(alias, { id: alias, object: "model", created: local[0]!.created, owned_by: "swarmlet", route: "local", ...(fullCatalog ? { selectable: true, local_eligible: true, local_reasons: [] } : {}) });
      }
      if (!meshAvailable && !models.size) return error("Mesh unavailable. Connect this node to control and wait for a ready model.", 503);
      return json({ object: "list", data: [...models.values()], mesh_available: meshAvailable });
    }
    // An operator's health check reads the engine directly (space, slots, metrics). On a node whose
    // engine is placed by the mesh, those have to come through here or the check goes blind.
    if (rootPaths.has(path)) {
      if (req.method !== "GET") return error("GET required", 405);
      const target = local.length === 1 ? local[0] : local.find((t) => t.model === req.headers.get("x-swarmlet-model"));
      if (!target) return error(local.length ? "Several models are served here; name one with x-swarmlet-model." : "No local engine to report on.", 503);
      try {
        const upstream = await fetch(`${target.url.replace(/\/$/, "")}${path}`, { redirect: "error", signal: AbortSignal.any([req.signal, AbortSignal.timeout(10_000)]) });
        return new Response(upstream.body, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store", "x-swarmlet-route": "local" } });
      } catch (e) { return error(`Local engine unavailable: ${(e as Error).message}`, 502); }
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
    // An alias is only usable while it is unambiguous: with two models served here, "local" names neither.
    if (ALIASES.includes(body.model) && local.length > 1) {
      return error(`"${body.model}" is ambiguous: this node serves ${local.map((t) => t.model).join(", ")}. Name one, or pin a deployment.`, 400);
    }
    const aliased = ALIASES.includes(body.model) && local.length === 1 ? local[0] : undefined;
    const target = aliased ?? local.find((t) => t.model === body.model && (!pinned || t.deploymentId === pinned));
    if (!target && !remote) return error("No local server for this model and the mesh is disconnected.", 503);
    // The engine checks the name it was given. A caller that asked for the alias gets the real one.
    const forwarded = aliased ? JSON.stringify({ ...body, model: aliased.model }) : text;
    const base = target?.url ?? remote!.url;
    const requestId = req.headers.get("x-request-id")?.match(/^[A-Za-z0-9._:-]{1,128}$/)?.[0] ?? crypto.randomUUID();
    const headers = new Headers({ "content-type": "application/json", "x-request-id": requestId });
    // Never pass caller credentials to a model server or trust caller-provided upstream URLs.
    if (!target) headers.set("authorization", `Bearer ${remote!.key}`);
    if (pinned) headers.set("x-swarmlet-deployment", pinned);
    const abort = new AbortController();
    const signal = AbortSignal.any([req.signal, abort.signal, AbortSignal.timeout(30 * 60_000)]);
    const release = deps.admit ? deps.admit() : () => {};
    if (!release) return error("Node update in progress; retry shortly.", 503);
    try {
      const upstream = await fetch(`${base.replace(/\/$/, "")}${path}`, { method: "POST", body: forwarded, headers, signal, redirect: "error" });
      const out = new Headers({ "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store", "x-swarmlet-route": target ? "local" : "mesh" });
      out.set("x-request-id", requestId);
      for (const h of ["x-request-id", "x-swarmlet-deployment", "x-swarmlet-node", "retry-after"]) {
        const value = upstream.headers.get(h); if (value) out.set(h, value);
      }
      if (target) { out.set("x-swarmlet-deployment", target.deploymentId); out.set("x-swarmlet-node", deps.nodeId()); }
      if (!upstream.body) { release(); return new Response(null, { status: upstream.status, headers: out }); }
      const stream = inferenceStream(upstream, abort, { finish: release });
      return new Response(stream, { status: upstream.status, headers: out });
    } catch (e) {
      release();
      if (req.signal.aborted) return error("request cancelled", 499);
      return error(`${target ? "Local server" : "Mesh"} unavailable: ${(e as Error).message}`, 502);
    }
  };
}
