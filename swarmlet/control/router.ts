// OpenAI-compatible router: /v1/models lists served models; /v1/chat/completions, /v1/completions
// and /v1/embeddings are forwarded (streaming passthrough) to a ready deployment serving the
// requested model. Policy: least in-flight, then lowest measured RTT. Transport: a TunnelPool port
// on this host that carries the connection over the node's agent channel to its llama-server.

import { inferenceStream } from "../protocol/inference-stream.ts";
import type { DeploymentManager } from "./deployments.ts";
import type { Logger } from "./log.ts";
import type { TunnelPool } from "./tunnel.ts";
import { StageExecutor } from "./stage-execution.ts";
import { createNativeResponse, parseNativeRequest } from "./stage-router.ts";

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const HOP_HEADERS = new Set(["host", "authorization", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"]);

/** Counts completion tokens in a passing response body: streamed SSE deltas count one per content or
 *  reasoning piece (llama-server emits one delta per token); a non-streamed JSON reply counts
 *  usage.completion_tokens at the end. Nothing is buffered beyond the current partial line. */
class TokenCounter {
  private decoder = new TextDecoder();
  private rest = "";
  private tail = "";
  constructor(private readonly emit: (n: number) => void, private readonly streamed: boolean) {}
  feed(chunk: Uint8Array): void {
    const text = this.decoder.decode(chunk, { stream: true });
    if (!this.streamed) { this.tail = (this.tail + text).slice(-4096); return; }
    this.rest += text;
    let nl: number;
    let n = 0;
    while ((nl = this.rest.indexOf("\n")) >= 0) {
      const line = this.rest.slice(0, nl).trim();
      this.rest = this.rest.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const choices = (JSON.parse(data) as { choices?: Array<{ text?: string; delta?: { content?: string; reasoning_content?: string } }> }).choices;
        for (const c of choices ?? []) if (c.text || c.delta?.content || c.delta?.reasoning_content) n++;
      } catch { /* partial */ }
    }
    if (n) this.emit(n);
  }
  finish(): void {
    if (this.streamed) return;
    const m = this.tail.match(/"completion_tokens"\s*:\s*(\d+)/);
    if (m) this.emit(Number(m[1]));
  }
}

export function createRouter(deps: { deployments: DeploymentManager; tunnels: TunnelPool; log: Logger }) {
  const nativeLifetimes = new Map<string, AbortSignal>();
  const nativeReady = new Map<string, AbortSignal>();
  const native = new StageExecutor({
    localPort: (nodeId, port) => deps.tunnels.localPort(nodeId, port),
    onUnsafeCleanup: async (id, failures) => {
      const lifetime = nativeLifetimes.get(id);
      if (lifetime) await deps.deployments.nativeExecutionFailed(id, `native cleanup failed: ${failures.map(f => `${f.nodeId} ${f.operation}: ${f.error}`).join("; ")}`, lifetime);
    },
  });
  const isNative = (kind: string) => kind === "stages" || kind === "prefill-decode";
  return async (req: Request, path: string): Promise<Response> => {
    let table = deps.deployments.routing();
    if (path === "/v1/models") {
      return json({ object: "list", data: table.map((m) => ({ id: m.modelName, object: "model", created: m.created, owned_by: "swarmlet", ready: m.deployments.length })) });
    }
    if (!["/v1/chat/completions", "/v1/completions", "/v1/embeddings"].includes(path)) return json({ error: { message: `unsupported path ${path}`, type: "invalid_request_error" } }, 404);
    if (req.method !== "POST") return json({ error: { message: "POST required", type: "invalid_request_error" } }, 405);
    const bodyText = await req.text();
    let model: string | undefined;
    let parsedBody: unknown;
    try { parsedBody = JSON.parse(bodyText); model = (parsedBody as { model?: string }).model; } catch { return json({ error: { message: "body is not JSON", type: "invalid_request_error" } }, 400); }
    table = deps.deployments.routing(); // body reads can overlap another request acquiring its native lease
    let candidates = model ? table.find((m) => m.modelName === model)?.deployments ?? [] : (table.length === 1 ? table[0]!.deployments : []);
    if (!candidates.length) return json({ error: { message: model ? `no ready deployment serves model '${model}'` : "specify a model (see /v1/models)", type: "invalid_request_error", available: table.map((m) => m.modelName) } }, 404);
    // a client may pin a deployment (header x-swarmlet-deployment, id or name); otherwise least in-flight, then lowest rtt
    const pinned = req.headers.get("x-swarmlet-deployment");
    // Native workers implement a bounded greedy contract. Other pool members may serve broader requests.
    if (candidates.some(c => isNative(c.kind))) {
      try { parseNativeRequest(parsedBody, path); }
      catch (error) {
        if (pinned && candidates.some(c => isNative(c.kind) && (c.id === pinned || c.name === pinned))) return json({ error: { message: (error as Error).message, type: "invalid_request_error" } }, 400);
        candidates = candidates.filter(c => !isNative(c.kind));
        if (!candidates.length) return json({ error: { message: (error as Error).message, type: "invalid_request_error" } }, 400);
      }
    }
    let pick = pinned ? candidates.find((c) => c.id === pinned || c.name === pinned) : undefined;
    if (pinned && !pick) return json({ error: { message: `deployment '${pinned}' is not ready for model '${model}'`, type: "invalid_request_error", candidates: candidates.map((c) => c.id) } }, 409);
    if (!pick) pick = candidates.filter(c => !isNative(c.kind) || !native.isBusy(c.id)).sort((a, b) => (a.inflight - b.inflight) || ((a.rttMs ?? 1e9) - (b.rttMs ?? 1e9)))[0];
    if (!pick || isNative(pick.kind) && native.isBusy(pick.id)) return json({ error: { message: "native deployment is busy; retry after the active request finishes", type: "server_error" } }, 429);
    const nativeExecution = isNative(pick.kind) ? deps.deployments.nativeExecution(pick.id) : null;
    if (isNative(pick.kind) && !nativeExecution) return json({ error: { message: "native deployment is no longer ready", type: "server_error" } }, 503);
    if (nativeExecution && nativeReady.get(pick.id) !== nativeExecution.signal) {
      native.acknowledgeRecovery(pick.id);
      nativeReady.set(pick.id, nativeExecution.signal);
    }
    const requestId = req.headers.get("x-request-id")?.match(/^[A-Za-z0-9._:-]{1,128}$/)?.[0] ?? crypto.randomUUID();
    const headers = new Headers();
    for (const [k, v] of req.headers) if (!HOP_HEADERS.has(k.toLowerCase())) headers.set(k, v);
    headers.set("content-type", "application/json");
    headers.set("x-request-id", requestId);
    deps.deployments.trackInflight(pick.id, +1);
    const t0 = Date.now();
    const abort = new AbortController();
    const signal = AbortSignal.any([req.signal, abort.signal, AbortSignal.timeout(30 * 60_000), ...(nativeExecution ? [nativeExecution.signal] : [])]);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal.removeEventListener("abort", release);
      deps.deployments.trackInflight(pick.id, -1);
    };
    // Native cancellation still owns the resident contexts until reset/cleanup is acknowledged.
    if (!nativeExecution) {
      signal.addEventListener("abort", release, { once: true });
      if (signal.aborted) release();
    }
    try {
      if (nativeExecution) {
        const id = pick.id;
        nativeLifetimes.set(id, nativeExecution.signal);
        const out = new Headers({ "x-request-id": requestId, "x-swarmlet-deployment": id, "x-swarmlet-node": pick.nodeId });
        return await createNativeResponse({ executor: native, plan: { ...nativeExecution.plan, deploymentId: id }, request: req,
          body: parsedBody, path, headers: out, signal,
          onFinish: () => { release(); if (nativeLifetimes.get(id) === nativeExecution.signal) nativeLifetimes.delete(id); },
          onTokens: n => deps.deployments.recordTokens(id, n),
          onError: error => deps.log.warn("native execution failed", { requestId, deployment: id, err: String(error) }),
        });
      }
      const local = await deps.tunnels.localPort(pick.nodeId, pick.port);
      const upstream = await fetch(`http://127.0.0.1:${local}${path}`, { method: "POST", headers, body: bodyText, signal });
      const out = new Headers(upstream.headers);
      // fetch decodes upstream compression, and stream validation may append an error event.
      // Neither the upstream encoding nor its byte count describes the forwarded body.
      out.delete("content-encoding");
      out.delete("content-length");
      out.set("x-request-id", requestId);
      out.set("x-swarmlet-deployment", pick.id);
      out.set("x-swarmlet-node", pick.nodeId);
      if (!upstream.body) { release(); return new Response(null, { status: upstream.status, headers: out }); }
      // Explicit SSE detection survives a first network chunk as small as "d". These are stream
      // delta estimates; non-streamed responses contribute their reported completion-token usage.
      const counter = new TokenCounter((n) => deps.deployments.recordTokens(pick.id, n), /text\/event-stream/i.test(upstream.headers.get("content-type") ?? ""));
      const body = inferenceStream(upstream, abort, {
        chunk: (value) => counter.feed(value),
        finish: () => { counter.finish(); release(); },
        failure: (message) => deps.log.warn("upstream stream failed", { requestId, path, deployment: pick.id, ms: Date.now() - t0, err: message }),
      });
      return new Response(body, { status: upstream.status, headers: out });
    } catch (e) {
      release();
      deps.log.warn("upstream failed", { requestId, deployment: pick.id, err: (e as Error).message });
      const response = json({ error: { message: `upstream failed: ${(e as Error).message}`, type: "server_error", request_id: requestId } }, req.signal.aborted ? 499 : 502);
      response.headers.set("x-request-id", requestId);
      return response;
    }
  };
}
