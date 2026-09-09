// OpenAI response adapter for the explicitly qualified, greedy native execution path.
import type { StageExecutionPlan, StageExecutor, StageGenerationRequest, StageGenerationResult } from "./stage-execution.ts";

class NativeRequestError extends Error {}
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NativeRequestError("request must be a JSON object");
  return value as JsonObject;
}
function keys(value: JsonObject, allowed: string[]): void {
  const unknown = Object.keys(value).filter(k => !allowed.includes(k));
  if (unknown.length) throw new NativeRequestError(`native execution does not support option '${unknown[0]}'`);
}

/** Throws before inference for every unsupported option; no sampling option is silently ignored. */
export function parseNativeRequest(body: unknown, path: string): StageGenerationRequest {
  const chat = path === "/v1/chat/completions";
  if (!chat && path !== "/v1/completions") throw new NativeRequestError(`native execution does not support ${path}`);
  const q = object(body);
  keys(q, ["model", chat ? "messages" : "prompt", "max_tokens", "temperature", "n", "stream", "stream_options"]);
  if (q.model !== undefined && (typeof q.model !== "string" || !q.model || q.model.length > 256)) throw new NativeRequestError("model must be a nonempty string");
  const maxTokens = q.max_tokens === undefined ? 64 : q.max_tokens;
  if (!Number.isSafeInteger(maxTokens) || (maxTokens as number) < 1 || (maxTokens as number) > 128) throw new NativeRequestError("max_tokens must be an integer from 1 to 128");
  if (q.temperature !== undefined && q.temperature !== 0) throw new NativeRequestError("native execution supports only temperature 0");
  if (q.n !== undefined && q.n !== 1) throw new NativeRequestError("native execution supports only n=1");
  if (q.stream !== undefined && typeof q.stream !== "boolean") throw new NativeRequestError("stream must be a boolean");
  if (q.stream_options !== undefined) {
    if (q.stream !== true) throw new NativeRequestError("stream_options requires stream=true");
    const options = object(q.stream_options); keys(options, ["include_usage"]);
    if (typeof options.include_usage !== "boolean") throw new NativeRequestError("stream_options.include_usage must be a boolean");
  }
  if (chat) {
    if (!Array.isArray(q.messages) || !q.messages.length || q.messages.length > 64) throw new NativeRequestError("messages must contain 1 to 64 text messages");
    const messages = q.messages.map(value => {
      const m = object(value); keys(m, ["role", "content"]);
      if (typeof m.role !== "string" || !["system", "user", "assistant"].includes(m.role) || typeof m.content !== "string") throw new NativeRequestError("native messages require system/user/assistant role and string content");
      return { role: m.role as "system" | "user" | "assistant", content: m.content };
    });
    if (Buffer.byteLength(JSON.stringify(messages)) > 65536) throw new NativeRequestError("messages exceed the 65536 byte bound");
    return { messages, maxTokens: maxTokens as number, temperature: 0 };
  }
  if (typeof q.prompt !== "string" || !q.prompt || Buffer.byteLength(q.prompt) > 65536) throw new NativeRequestError("prompt must be a nonempty string of at most 65536 bytes");
  return { prompt: q.prompt, maxTokens: maxTokens as number, temperature: 0 };
}

export interface NativeResponseOptions {
  executor: Pick<StageExecutor, "generate">;
  plan: StageExecutionPlan;
  request: Request;
  body: unknown;
  path: string;
  headers: HeadersInit;
  signal: AbortSignal;
  onFinish(): void;
  onTokens(count: number): void;
  onError(error: unknown): void;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const usage = (result: StageGenerationResult) => ({ prompt_tokens: result.promptTokens, completion_tokens: result.completionTokens, total_tokens: result.promptTokens + result.completionTokens });

/** generate() runs synchronously through its lease acquisition before this helper awaits or writes SSE. */
export async function createNativeResponse(options: NativeResponseOptions): Promise<Response> {
  let finished = false, reported = false;
  const finish = () => { if (!finished) { finished = true; options.onFinish(); } };
  const report = (error: unknown) => { if (!reported) { reported = true; options.onError(error); } };
  const outHeaders = new Headers(options.headers);
  outHeaders.delete("content-length"); outHeaders.delete("content-encoding");
  let parsed: StageGenerationRequest;
  try { parsed = parseNativeRequest(options.body, options.path); }
  catch (error) {
    finish(); outHeaders.set("content-type", "application/json");
    return new Response(JSON.stringify({ error: { message: message(error), type: "invalid_request_error" } }), { status: 400, headers: outHeaders });
  }
  const body = options.body as JsonObject;
  const chat = options.path === "/v1/chat/completions", stream = body.stream === true;
  const model = typeof body.model === "string" ? body.model : "qwen3.5-2b";
  const id = `${chat ? "chatcmpl" : "cmpl"}-${crypto.randomUUID()}`, created = Math.floor(Date.now() / 1000);
  const abort = new AbortController();
  const signal = AbortSignal.any([options.signal, options.request.signal, abort.signal]);
  const generationRequest = { ...parsed, signal };
  if (!stream) {
    // No await occurs between entering this branch and acquiring the executor lease.
    const generation = options.executor.generate(options.plan, generationRequest, chunk => { if (chunk.tokenId !== null) options.onTokens(1); });
    try {
      const result = await generation;
      outHeaders.set("content-type", "application/json");
      return new Response(JSON.stringify({ id, object: chat ? "chat.completion" : "text_completion", created, model,
        choices: [chat ? { index: 0, message: { role: "assistant", content: result.text }, finish_reason: result.finishReason }
          : { index: 0, text: result.text, logprobs: null, finish_reason: result.finishReason }], usage: usage(result) }), { headers: outHeaders });
    } catch (error) {
      report(error); outHeaders.set("content-type", "application/json");
      return new Response(JSON.stringify({ error: { message: message(error), type: "server_error" } }), { status: signal.aborted ? 499 : 502, headers: outHeaders });
    } finally { finish(); }
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>();
  const writer = transform.writable.getWriter(), reader = transform.readable.getReader();
  const encoder = new TextEncoder();
  const write = (value: unknown) => writer.write(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
  const frame = (choices: unknown[], extra: JsonObject = {}) => ({ id, object: chat ? "chat.completion.chunk" : "text_completion", created, model, choices, ...extra });
  let start!: () => void;
  let generationFinished = false;
  const started = new Promise<void>(resolve => { start = resolve; });
  // A callback waits for the initial role event, but generate itself starts before any SSE write.
  const generation = options.executor.generate(options.plan, generationRequest, async chunk => {
    await started;
    if (generationFinished) return; // A cancelled generation may have finished cleanup while the reader was paused.
    if (chunk.tokenId !== null) options.onTokens(1);
    await write(frame([chat ? { index: 0, delta: { content: chunk.text }, finish_reason: null }
      : { index: 0, text: chunk.text, logprobs: null, finish_reason: null }]));
  });
  const settled = generation.finally(() => { generationFinished = true; finish(); });
  void settled.catch(report); // Observe an early failure even while the initial SSE write is blocked.
  // Reading cancellation also aborts blocked writer.write(), allowing executor cleanup to finish.
  void writer.closed.catch(error => { if (!abort.signal.aborted) abort.abort(error); });
  const initial = (async () => {
    try { if (chat) await write(frame([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }])); }
    catch (error) { abort.abort(error); }
    finally { start(); }
  })();
  void (async () => {
    try {
      await initial;
      const result = await settled; // Includes all native resets and capsule cleanup.
      await write(frame([chat ? { index: 0, delta: {}, finish_reason: result.finishReason }
        : { index: 0, text: "", logprobs: null, finish_reason: result.finishReason }]));
      if ((body.stream_options as JsonObject | undefined)?.include_usage === true) await write(frame([], { usage: usage(result) }));
      await writer.write(encoder.encode("data: [DONE]\n\n"));
    } catch (error) {
      report(error);
      // An explicit failure replaces the success terminator. A disconnected reader cannot receive it.
      try { await write({ error: { message: message(error), type: "server_error" } }); } catch { /* reader cancelled */ }
    } finally { try { await writer.close(); } catch { /* reader cancelled */ } }
  })();
  const readable = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try { const next = await reader.read(); if (next.done) { controller.close(); reader.releaseLock(); } else controller.enqueue(next.value); }
      catch (error) { controller.error(error); }
    },
    async cancel(reason) {
      if (!abort.signal.aborted) abort.abort(reason ?? new Error("native response reader cancelled"));
      await reader.cancel(reason).catch(() => {});
      await settled.catch(() => {}); // Cancellation does not complete before resets finish.
    },
  }, { highWaterMark: 0 });
  outHeaders.set("content-type", "text/event-stream");
  outHeaders.set("cache-control", "no-cache");
  outHeaders.delete("content-length"); outHeaders.delete("content-encoding");
  return new Response(readable, { headers: outHeaders });
}
