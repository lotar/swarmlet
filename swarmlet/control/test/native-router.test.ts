import { afterEach, expect, test } from "bun:test";
import { createRouter } from "../router.ts";
import type { DeploymentManager } from "../deployments.ts";
import type { TunnelPool } from "../tunnel.ts";
import type { NativeExecutionPlan, NativeStageIdentity } from "../../protocol/types.ts";

const workers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => { for (const server of workers.splice(0)) server.stop(true); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const log = { info() {}, warn() {}, error() {}, debug() {} };

function fixture(normalMember = false) {
  const calls: Array<{ node: number; path: string; op?: string }> = [], normalPaths: string[] = [];
  const counters = { inflight: 0, tokens: 0, releases: 0 };
  const failures: Array<{ lifetime: AbortSignal | undefined; current: boolean }> = [];
  const states = [0, 1].map(() => ({ position: 0, session: "", generated: 0, resetFails: false }));
  let lifetime = new AbortController(), ready = true;
  let resetGate: Promise<void> | undefined;
  const resetEntered = deferred();
  const engine = "a".repeat(64), source = "b".repeat(64), binary = "c".repeat(64);
  const endpoints = states.map((state, i) => {
    const identity: NativeStageIdentity = { schema: 1, engine, model_sha256: String(i + 1).repeat(64), source_sha256: source, ctx: 1024,
      cache_k: "f32", cache_v: "f32", ubatch: 1, flash_attn: "disabled", stage_start: String(i * 12), stage_end: String((i + 1) * 12), stage_total: "24" };
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path !== "/command") { calls.push({ node: i, path }); return Response.json({ error: "raw worker is not OpenAI" }, { status: 404 }); }
      const body = await request.json() as Record<string, any>; calls.push({ node: i, path, op: body.op });
      if (body.op === "status") return Response.json({ identity, binary_sha256: binary, n_embd: 2048, n_vocab: 248320, position: state.position, session: state.session });
      if (body.op === "tokenize" || body.op === "chat_tokens") return Response.json({ tokens: [1, 2, 3] });
      if (body.op === "reset") {
        resetEntered.resolve(); if (resetGate) await resetGate;
        if (state.resetFails) return Response.json({ error: "reset unavailable" }, { status: 503 });
        state.position = 0; state.session = ""; state.generated = 0; return Response.json({ reset: true });
      }
      if (body.op === "eval") {
        if (body.position !== state.position || state.session && body.session !== state.session) return Response.json({ error: "state mismatch" }, { status: 400 });
        const count = body.tokens?.length ?? body.activations.length / 2048;
        state.position += count; state.session = body.session;
        if (i === 0) return Response.json({ position: state.position, activations: Array(count * 2048).fill(0.25) });
        const index = state.generated++;
        return Response.json({ position: state.position, token: 40 + index, pieceBytes: [65 + index], isEog: false });
      }
      return Response.json({ error: "unsupported command" }, { status: 400 });
    } }); workers.push(server);
    return { nodeId: `n${i}`, port: server.port!, identity, binarySha256: binary };
  });
  const normal = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    normalPaths.push(new URL(request.url).pathname);
    return Response.json({ id: "normal-1", choices: [{ text: "normal", index: 0, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  } }); workers.push(normal);
  const nativePlan: NativeExecutionPlan = { mode: "stages", profile: "qwen35-2b-q8", endpoints };
  const manager = {
    routing() { return [{ modelName: "qwen3.5-2b", created: 1, deployments: [
      ...(ready ? [{ id: "native", name: "native-chain", kind: "stages", nodeId: "n0", port: endpoints[0]!.port, nodes: ["n0", "n1"], inflight: counters.inflight, rttMs: 1 }] : []),
      ...(normalMember ? [{ id: "normal", name: "normal", kind: "replica", nodeId: "normal", port: normal.port!, nodes: ["normal"], inflight: 0, rttMs: 100 }] : []),
    ] }]; },
    nativeExecution() { return ready ? { plan: nativePlan, signal: lifetime.signal } : null; },
    nativeExecutionFailed(_id: string, _reason: string, expected: AbortSignal | undefined) {
      failures.push({ lifetime: expected, current: expected === lifetime.signal });
      if (expected === lifetime.signal) { ready = false; lifetime.abort(new Error("native failed")); }
    },
    trackInflight(id: string, amount: number) { if (id === "native") { counters.inflight += amount; if (amount < 0) counters.releases++; } },
    recordTokens(id: string, count: number) { if (id === "native") counters.tokens += count; },
  };
  const route = createRouter({ deployments: manager as unknown as DeploymentManager,
    tunnels: { localPort: async (_node: string, port: number) => port } as TunnelPool, log });
  const request = (body: Record<string, unknown>, headers: HeadersInit = {}, path = "/v1/completions") => route(new Request("http://localhost" + path, {
    method: "POST", headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) }, body: JSON.stringify({ model: "qwen3.5-2b", max_tokens: 2, ...body }),
  }), path);
  return { request, states, calls, normalPaths, counters, failures, resetEntered,
    delayReset(promise: Promise<void>) { resetGate = promise; },
    abort() { lifetime.abort(new Error("deployment stopped")); },
    replaceLifetime() { const old = lifetime; lifetime = new AbortController(); old.abort(new Error("deployment replaced")); return lifetime.signal; },
  };
}

test("actual router uses native commands, preserves headers and releases after a nonstream completion", async () => {
  const f = fixture();
  const response = await f.request({ prompt: "hi" }, { "x-request-id": "native-request" });
  expect(response.status).toBe(200);
  expect(response.headers.get("x-request-id")).toBe("native-request");
  expect(response.headers.get("x-swarmlet-deployment")).toBe("native");
  expect(response.headers.get("x-swarmlet-node")).toBe("n0");
  expect(await response.json()).toMatchObject({ choices: [{ text: "AB" }], usage: { completion_tokens: 2 } });
  expect(f.calls.every(c => c.path === "/command")).toBe(true);
  expect(f.calls.some(c => c.op === "eval")).toBe(true);
  expect(f.counters).toEqual({ inflight: 0, tokens: 2, releases: 1 });
});

test("actual router streams chat tokens and only finishes after native resets", async () => {
  const f = fixture();
  const response = await f.request({ messages: [{ role: "user", content: "hi" }], stream: true }, {}, "/v1/chat/completions");
  expect(response.headers.get("x-swarmlet-deployment")).toBe("native");
  const text = await response.text();
  expect(text).toContain('"role":"assistant"'); expect(text).toContain('"content":"A"'); expect(text).toContain("[DONE]");
  expect(f.calls.some(c => c.op === "chat_tokens")).toBe(true);
  expect(f.calls.every(c => c.path === "/command")).toBe(true);
  expect(f.states.every(s => s.position === 0 && s.session === "")).toBe(true);
  expect(f.counters).toEqual({ inflight: 0, tokens: 2, releases: 1 });
});

test("unsupported native requests select a normal pool member unless explicitly pinned", async () => {
  const f = fixture(true);
  const response = await f.request({ prompt: "hi", temperature: 0.7 });
  expect(response.status).toBe(200); expect(response.headers.get("x-swarmlet-deployment")).toBe("normal");
  await response.text(); expect(f.normalPaths).toEqual(["/v1/completions"]); expect(f.calls).toEqual([]);
  const pinned = await f.request({ prompt: "hi", temperature: 0.7 }, { "x-swarmlet-deployment": "native" });
  expect(pinned.status).toBe(400); expect(f.calls).toEqual([]);
  const only = fixture(); expect((await only.request({ prompt: "hi", top_p: 1 })).status).toBe(400);
});

test("native busy admission returns 429 before a second inflight claim", async () => {
  const f = fixture();
  const first = await f.request({ prompt: "hi", stream: true });
  const second = await f.request({ prompt: "again" });
  expect(second.status).toBe(429); expect(f.counters.inflight).toBe(1);
  await first.body!.cancel(new Error("test cancelled"));
  expect(f.counters.inflight).toBe(0); expect(f.counters.releases).toBe(1);
});

test("deployment cancellation retains inflight ownership until paused native resets finish", async () => {
  const f = fixture(); const reset = deferred(); f.delayReset(reset.promise);
  const reader = (await f.request({ prompt: "hi", stream: true, max_tokens: 3 })).body!.getReader();
  await reader.read(); f.abort(); await f.resetEntered.promise;
  expect(f.counters.inflight).toBe(1);
  reset.resolve();
  let text = ""; for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); }
  expect(text).toContain("error"); expect(text).not.toContain("[DONE]");
  expect(f.counters.inflight).toBe(0); expect(f.counters.releases).toBe(1);
});

test("a paused chat reader cannot hold native state after deployment cancellation", async () => {
  const f = fixture();
  const response = await f.request({ messages: [{ role: "user", content: "hi" }], stream: true }, {}, "/v1/chat/completions");
  const deadline = Date.now() + 2000;
  while (!f.calls.some(c => c.node === 1 && c.op === "eval")) {
    if (Date.now() > deadline) throw new Error("native eval did not start");
    await Bun.sleep(1);
  }
  f.abort(); await f.resetEntered.promise;
  while (f.counters.inflight !== 0) {
    if (Date.now() > deadline) throw new Error("paused reader retained native inflight ownership");
    await Bun.sleep(1);
  }
  expect(f.states.every(s => s.position === 0)).toBe(true);
  const text = await response.text();
  expect(text).toContain("error"); expect(text).not.toContain('"content":"A"'); expect(text).not.toContain("[DONE]");
});

test("a failed old lifetime cannot withdraw its replacement and fresh readiness clears the cleanup latch", async () => {
  const f = fixture(); const reset = deferred(); f.delayReset(reset.promise);
  const reader = (await f.request({ prompt: "hi", stream: true, max_tokens: 3 })).body!.getReader();
  await reader.read(); f.states[1]!.resetFails = true; const fresh = f.replaceLifetime();
  await f.resetEntered.promise; reset.resolve();
  for (;;) { if ((await reader.read()).done) break; }
  expect(f.failures).toHaveLength(1); expect(f.failures[0]!.current).toBe(false); expect(fresh.aborted).toBe(false);
  for (const state of f.states) { state.resetFails = false; state.position = 0; state.session = ""; state.generated = 0; }
  const next = await f.request({ prompt: "new generation" });
  expect(next.status).toBe(200); expect(await next.json()).toMatchObject({ choices: [{ text: "AB" }] });
  expect(f.counters.inflight).toBe(0);
});
