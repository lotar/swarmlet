// Legacy /v1/completions compatibility for external servers that implement only chat completions.
//
// Inco Splash 1.0 answers /v1/chat/completions and 404s /v1/completions. The mesh keeps the alias and the
// legacy path working by translating both directions when an external deployment declares `upstreamModel`
// (the same signal that tells the router the endpoint is foreign). Pure functions here; the node gateway
// and the control router both use them.

type Json = Record<string, unknown>;

/** /v1/completions -> /v1/chat/completions. Non-completions paths and bodies pass through untouched. */
export function completionsToChat(path: string, body: Json): { path: string; body: Json } {
  if (path !== "/v1/completions") return { path, body };
  const { prompt, ...rest } = body;
  const content = Array.isArray(prompt) ? prompt.map((p) => String(p)).join("\n") : typeof prompt === "string" ? prompt : "";
  return { path: "/v1/chat/completions", body: { ...rest, messages: [{ role: "user", content }] } };
}

/** chat.completion -> text_completion. Reasoning is folded into text so a legacy client sees the answer
 *  that a chat client would see, not an empty string while the model thinks. */
export function chatToCompletions(payload: Json): Json {
  const chat = payload as { id?: string; created?: number; model?: string; usage?: unknown; choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string }> };
  const choices = (chat.choices ?? []).map((choice, index) => {
    const text = (choice.message?.content ?? "") || (choice.message?.reasoning_content ?? "") || "";
    return { text, index, logprobs: null, finish_reason: choice.finish_reason ?? null };
  });
  return { id: chat.id ?? `cmpl-${crypto.randomUUID()}`, object: "text_completion", created: chat.created ?? Math.floor(Date.now() / 1000), model: chat.model ?? "", choices, usage: chat.usage ?? null };
}

/** SSE chat deltas -> SSE text_completion deltas. Buffers partial lines; passes [DONE] through. */
export function chatSseToCompletions(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = stream.getReader();
  let buffer = "";
  let id = `cmpl-${crypto.randomUUID()}`;
  let created = Math.floor(Date.now() / 1000);
  let model = "";
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          const tail = buffer.trim();
          if (tail.startsWith("data:")) {
            const data = tail.slice(5).trim();
            controller.enqueue(encoder.encode(data === "[DONE]" ? "data: [DONE]\n\n" : ""));
          }
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        let out = "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") { out += "data: [DONE]\n\n"; continue; }
          let payload: Json;
          try { payload = JSON.parse(data) as Json; } catch { continue; }
          const chat = payload as { id?: string; created?: number; model?: string; choices?: Array<{ delta?: { content?: string | null }; index?: number; finish_reason?: string | null }> };
          if (chat.id) id = chat.id;
          if (typeof chat.created === "number") created = chat.created;
          if (chat.model) model = chat.model;
          for (const choice of chat.choices ?? []) {
            const text = choice.delta?.content ?? "";
            if (!text && !choice.finish_reason) continue;
            out += `data: ${JSON.stringify({ id, object: "text_completion", created, model, choices: [{ text, index: choice.index ?? 0, logprobs: null, finish_reason: choice.finish_reason ?? null }] })}\n\n`;
          }
        }
        if (out) { controller.enqueue(encoder.encode(out)); return; }
      }
    },
  });
}
