// Legacy completions compatibility for chat-only external servers: request, response and SSE mappings.
import { describe, expect, test } from "bun:test";
import { chatSseToCompletions, chatToCompletions, completionsToChat } from "../completions-compat.ts";

const streamOf = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } });
};
const readAll = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
};

describe("completions compatibility", () => {
  test("a prompt becomes one user message; other paths pass through", () => {
    const mapped = completionsToChat("/v1/completions", { model: "qwen3.8-27b", prompt: "write a haiku", max_tokens: 32, temperature: 0 });
    expect(mapped.path).toBe("/v1/chat/completions");
    expect(mapped.body).toMatchObject({ model: "qwen3.8-27b", max_tokens: 32, messages: [{ role: "user", content: "write a haiku" }] });
    expect(mapped.body.prompt).toBeUndefined();
    const untouched = completionsToChat("/v1/chat/completions", { model: "x", messages: [] });
    expect(untouched.path).toBe("/v1/chat/completions");
    expect(untouched.body).toEqual({ model: "x", messages: [] });
  });

  test("a chat response maps to text_completion, with reasoning as a fallback", () => {
    const out = chatToCompletions({ id: "chatcmpl-1", created: 7, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { completion_tokens: 1 } });
    expect(out).toMatchObject({ object: "text_completion", model: "m", created: 7, choices: [{ text: "hello", index: 0, finish_reason: "stop" }], usage: { completion_tokens: 1 } });
    const thinking = chatToCompletions({ choices: [{ message: { content: null, reasoning_content: "42" } }] } as never);
    expect((thinking.choices as Array<{ text: string }>)[0]!.text).toBe("42");
  });

  test("streamed chat deltas become text_completion deltas and keep [DONE]", async () => {
    const sse = [
      'data: {"id":"c1","created":5,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const out = await readAll(chatSseToCompletions(streamOf(sse)));
    expect(out).toContain('"object":"text_completion"');
    expect(out).toContain('"text":"Hel"');
    expect(out).toContain('"text":"lo"');
    expect(out).toContain('"finish_reason":"stop"');
    expect(out.trimEnd().endsWith("[DONE]")).toBe(true);
    expect(out).not.toContain('"delta"');
  });

  test("a chunk split mid-line is buffered, not dropped", async () => {
    const sse = ['data: {"choices":[{"index":0,"delta":{"content":"par', 't"}}]}\n\ndata: [DONE]\n\n'];
    const out = await readAll(chatSseToCompletions(streamOf(sse)));
    expect(out).toContain('"text":"part"');
    expect(out).toContain("[DONE]");
  });
});
