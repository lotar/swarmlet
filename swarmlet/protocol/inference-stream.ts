/** Forward inference bytes while making premature SSE termination explicit to clients.
 * A POST is never replayed: upstream execution may continue even when transport is lost. */
export function inferenceStream(upstream: Response, abort: AbortController, hooks: {
  chunk?: (chunk: Uint8Array) => void;
  finish?: () => void;
  failure?: (message: string) => void;
} = {}): ReadableStream<Uint8Array> {
  const reader = upstream.body!.getReader();
  const sse = upstream.ok && /text\/event-stream/i.test(upstream.headers.get("content-type") ?? "");
  const decoder = new TextDecoder();
  let rest = "", terminal = false, finished = false;
  const finish = () => { if (!finished) { finished = true; hooks.finish?.(); } };
  const inspect = (bytes: Uint8Array) => {
    if (!sse) return;
    rest += decoder.decode(bytes, { stream: true });
    let nl: number;
    while ((nl = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, nl).trim(); rest = rest.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") terminal = true;
      else { try { if (JSON.parse(data)?.error) { terminal = true; hooks.failure?.("Upstream reported a stream error."); } } catch { /* not a terminal event */ } }
    }
    // Bound memory for a malformed upstream that never terminates its SSE line.
    if (rest.length > 1024 * 1024) throw new Error("Upstream SSE event exceeds 1 MiB");
  };
  const fail = (controller: ReadableStreamDefaultController<Uint8Array>, message: string) => {
    hooks.failure?.(message);
    abort.abort(new Error(message));
    void reader.cancel(message).catch(() => {});
    if (sse) {
      // Leading blank line closes any partial event before the structured error.
      controller.enqueue(new TextEncoder().encode(`\n\ndata: ${JSON.stringify({ error: { message, type: "server_error", code: "upstream_stream_interrupted" } })}\n\n`));
      controller.close();
    } else controller.error(new Error(message));
    finish();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (sse && !terminal) { fail(controller, "Upstream stream ended before [DONE]; response is incomplete."); return; }
          finish(); controller.close();
        } else { inspect(value); hooks.chunk?.(value); controller.enqueue(value); }
      } catch (e) { fail(controller, `Upstream stream interrupted: ${(e as Error).message}`); }
    },
    async cancel(reason) { finish(); abort.abort(reason); await reader.cancel(reason).catch(() => {}); },
  });
}
