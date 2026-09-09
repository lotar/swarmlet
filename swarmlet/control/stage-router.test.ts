import { expect, test } from "bun:test";
import { createNativeResponse, parseNativeRequest, type NativeResponseOptions } from "./stage-router.ts";
import type { StageExecutionPlan, StageGenerationResult } from "./stage-execution.ts";

const plan = { deploymentId: "d", mode: "stages", profile: "qwen35-2b-q8", endpoints: [] } as StageExecutionPlan;
const result: StageGenerationResult = { text: "hi!", tokenIds: [1, 2], finishReason: "length", promptTokens: 3, completionTokens: 2 };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
function fixture(body: unknown, path = "/v1/completions", generate?: NativeResponseOptions["executor"]["generate"]) {
  const events: string[] = [], errors: unknown[] = []; let count = 0, finishes = 0;
  const options: NativeResponseOptions = {
    executor: { generate: generate ?? (async (_plan, _request, token) => {
      events.push("generate"); await token?.({ tokenId: 1, text: "hi" }); await token?.({ tokenId: 2, text: "!" }); events.push("cleanup"); return result;
    }) }, plan, body, path,
    request: new Request("http://localhost" + path, { method: "POST" }),
    headers: { "x-swarmlet-deployment": "d", "x-request-id": "request-1", "content-length": "999", "content-encoding": "gzip" },
    signal: new AbortController().signal,
    onFinish() { finishes++; events.push("finish"); }, onTokens(n) { count += n; }, onError(e) { errors.push(e); },
  };
  return { options, events, errors, count: () => count, finishes: () => finishes };
}
const frames = (text: string) => text.trim().split("\n\n").map(line => line.slice("data: ".length)).filter(line => line !== "[DONE]").map(line => JSON.parse(line));

test("strict native request parser accepts the documented greedy surface", () => {
  expect(parseNativeRequest({ model: "qwen3.5-2b", prompt: "hello" }, "/v1/completions")).toEqual({ prompt: "hello", maxTokens: 64, temperature: 0 });
  expect(parseNativeRequest({ messages: [{ role: "system", content: "plain" }, { role: "user", content: "hello" }], max_tokens: 128, temperature: 0, n: 1, stream: true, stream_options: { include_usage: true } }, "/v1/chat/completions")).toMatchObject({ maxTokens: 128, temperature: 0 });
});

test("unsupported options, formats and endpoints are rejected rather than ignored", () => {
  const base = { prompt: "hello" };
  for (const extra of [{ temperature: 0.1 }, { n: 2 }, { stop: null }, { seed: 0 }, { top_p: 1 }, { max_tokens: 0 }, { max_tokens: 129 }, { max_tokens: 1.2 }, { max_tokens: null }, { stream: "true" }, { stream_options: { include_usage: true } }, { stream: true, stream_options: { include_usage: true, extra: 1 } }]) {
    expect(() => parseNativeRequest({ ...base, ...extra }, "/v1/completions")).toThrow();
  }
  expect(() => parseNativeRequest({ prompt: [1, 2] }, "/v1/completions")).toThrow();
  expect(() => parseNativeRequest(base, "/v1/embeddings")).toThrow("does not support");
  for (const message of [{ role: "tool", content: "x" }, { role: ["user"], content: "x" }, { role: "user", content: [{ type: "text", text: "x" }] }, { role: "assistant", content: "x", tool_calls: [] }]) {
    expect(() => parseNativeRequest({ messages: [message] }, "/v1/chat/completions")).toThrow();
  }
});

test("non-streamed completion starts the lease synchronously and reports usage after cleanup", async () => {
  const f = fixture({ prompt: "hello", model: "qwen3.5-2b", max_tokens: 2 });
  const pending = createNativeResponse(f.options);
  expect(f.events).toEqual(["generate"]);
  const response = await pending, body = await response.json();
  expect(response.status).toBe(200);
  expect(response.headers.get("x-request-id")).toBe("request-1");
  expect(response.headers.get("content-length")).toBeNull();
  expect(response.headers.get("content-encoding")).toBeNull();
  expect(body).toMatchObject({ object: "text_completion", model: "qwen3.5-2b", choices: [{ index: 0, text: "hi!", finish_reason: "length", logprobs: null }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
  expect(f.events).toEqual(["generate", "cleanup", "finish"]);
  expect(f.count()).toBe(2); expect(f.finishes()).toBe(1);
});

test("non-streamed chat uses assistant message shape", async () => {
  const f = fixture({ messages: [{ role: "user", content: "hello" }] }, "/v1/chat/completions");
  const response = await createNativeResponse(f.options);
  expect(await response.json()).toMatchObject({ object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hi!" }, finish_reason: "length" }] });
  expect(f.finishes()).toBe(1);
});

test("SSE emits OpenAI chat deltas, optional usage and DONE only after cleanup", async () => {
  const cleaned = deferred(); let entered = false;
  const f = fixture({ messages: [{ role: "user", content: "hi" }], stream: true, stream_options: { include_usage: true } }, "/v1/chat/completions", async (_plan, _request, token) => {
    entered = true; await token?.({ tokenId: 1, text: "hi!" }); await cleaned.promise; return result;
  });
  const pending = createNativeResponse(f.options); expect(entered).toBe(true);
  const response = await pending; expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body!.getReader(); const decoder = new TextDecoder();
  let text = decoder.decode((await reader.read()).value);
  text += decoder.decode((await reader.read()).value);
  expect(text).toContain('"role":"assistant"'); expect(text).not.toContain("[DONE]"); expect(f.finishes()).toBe(0);
  cleaned.resolve();
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value); }
  const data = frames(text);
  expect(data[0].choices[0].delta).toEqual({ role: "assistant", content: "" });
  expect(data[1].choices[0].delta).toEqual({ content: "hi!" });
  expect(data.at(-1)).toMatchObject({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
  expect(text.endsWith("data: [DONE]\n\n")).toBe(true); expect(f.finishes()).toBe(1); expect(f.count()).toBe(1);
});

test("SSE failure is explicit and never emits a success terminator", async () => {
  const f = fixture({ prompt: "hi", stream: true }, "/v1/completions", async (_plan, _request, token) => {
    await token?.({ tokenId: 1, text: "partial" }); throw new Error("native reset failed");
  });
  const text = await (await createNativeResponse(f.options)).text();
  expect(text).toContain("partial"); expect(text).toContain('"error":{"message":"native reset failed"'); expect(text).not.toContain("[DONE]");
  expect(f.finishes()).toBe(1); expect(f.errors).toHaveLength(1); expect(f.count()).toBe(1);
});

test("reader cancellation aborts generation and waits for native cleanup", async () => {
  const cleanup = deferred(); const abortSeen = deferred();
  const f = fixture({ prompt: "hi", stream: true }, "/v1/completions", async (_plan, request, token) => {
    try {
      await token?.({ tokenId: 1, text: "partial" });
      await new Promise<void>((_, reject) => {
        const abort = () => { abortSeen.resolve(); reject(request.signal!.reason); };
        if (request.signal!.aborted) abort(); else request.signal!.addEventListener("abort", abort, { once: true });
      });
      return result;
    } finally { await cleanup.promise; }
  });
  const reader = (await createNativeResponse(f.options)).body!.getReader(); await reader.read();
  let cancelled = false; const cancel = reader.cancel(new Error("client disconnected")).then(() => { cancelled = true; });
  await abortSeen.promise; await Bun.sleep(1);
  expect(cancelled).toBe(false); expect(f.finishes()).toBe(0);
  cleanup.resolve(); await cancel;
  expect(f.finishes()).toBe(1); expect(f.errors).toHaveLength(1);
});

test("invalid input finishes without starting inference; nonstream failures finish once", async () => {
  const invalid = fixture({ prompt: "x", top_p: 1 });
  expect((await createNativeResponse(invalid.options)).status).toBe(400);
  expect(invalid.events).toEqual(["finish"]);
  const failed = fixture({ prompt: "x" }, "/v1/completions", async () => { throw new Error("worker unavailable"); });
  const response = await createNativeResponse(failed.options);
  expect(response.status).toBe(502); expect(await response.json()).toMatchObject({ error: { message: "worker unavailable", type: "server_error" } });
  expect(failed.finishes()).toBe(1); expect(failed.errors).toHaveLength(1);
});

test("an early chat failure remains handled while the consumer has not read the role event", async () => {
  const f = fixture({ messages: [{ role: "user", content: "x" }], stream: true }, "/v1/chat/completions", async () => { throw new Error("early failure"); });
  const response = await createNativeResponse(f.options); await Bun.sleep(1);
  const text = await response.text();
  expect(text).toContain("early failure"); expect(text).not.toContain("[DONE]"); expect(f.finishes()).toBe(1);
});
