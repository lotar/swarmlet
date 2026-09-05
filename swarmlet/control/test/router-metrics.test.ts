import { afterEach, expect, test } from "bun:test";
import { createRouter } from "../router.ts";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const encoder = new TextEncoder();
function fixture() {
  const counts = { inflight: 0, releases: 0, tokens: 0 };
  const router = createRouter({
    deployments: {
      routing: () => [{ modelName: "test", deployments: [{ id: "d", nodeId: "n", port: 8000, inflight: 0 }] }],
      trackInflight: (_id: string, n: number) => { counts.inflight += n; if (n < 0) counts.releases++; },
      recordTokens: (_id: string, n: number) => { counts.tokens += n; },
    } as never,
    tunnels: { localPort: async () => 8000 } as never,
    log: { debug: () => {}, warn: () => {} } as never,
  });
  const request = (signal?: AbortSignal) => router(new Request("http://control/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "test", stream: true }), signal }), "/v1/chat/completions");
  return { counts, request };
}

test("fragmented SSE counts deltas and normal completion releases once", async () => {
  const { counts, request } = fixture();
  globalThis.fetch = (async () => new Response(new ReadableStream({ start(c) { for (const part of ['d', 'ata: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', 'data: {"choices":[{"delta":{"reasoning_content":"Think"}}]}\n\n', 'data: [DONE]\n\n']) c.enqueue(encoder.encode(part)); c.close(); } }), { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
  const response = await request(); await response.text();
  expect(counts).toEqual({ inflight: 0, releases: 1, tokens: 2 });
});

test("downstream cancellation cancels upstream and releases exactly once", async () => {
  const { counts, request } = fixture(); let cancelled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode('data: {}\n\n')); }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
  const response = await request(); const reader = response.body!.getReader(); await reader.read();
  expect(counts.inflight).toBe(1);
  await reader.cancel();
  expect(cancelled).toBe(true); expect(counts.inflight).toBe(0); expect(counts.releases).toBe(1);
});

test("upstream body error releases once", async () => {
  const { counts, request } = fixture();
  globalThis.fetch = (async () => new Response(new ReadableStream({ start(c) { c.error(new Error("broken body")); } }))) as unknown as typeof fetch;
  const response = await request();
  await expect(response.text()).rejects.toThrow("broken body");
  expect(counts.inflight).toBe(0); expect(counts.releases).toBe(1);
});

test("request abort releases even if caller never consumes response body", async () => {
  const { counts, request } = fixture(); const abort = new AbortController();
  globalThis.fetch = (async () => new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode("first")); } }))) as unknown as typeof fetch;
  const response = await request(abort.signal); abort.abort();
  expect(counts.inflight).toBe(0); expect(counts.releases).toBe(1);
  await response.body!.cancel(); expect(counts.releases).toBe(1);
});

test("fetch error and bodyless response release once", async () => {
  const f = fixture(); globalThis.fetch = (async () => { throw new Error("refused"); }) as unknown as typeof fetch;
  expect((await f.request()).status).toBe(502); expect(f.counts.releases).toBe(1); expect(f.counts.inflight).toBe(0);
  const g = fixture(); globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
  expect((await g.request()).status).toBe(204); expect(g.counts.releases).toBe(1); expect(g.counts.inflight).toBe(0);
});

test("nonstreamed reported usage is counted at completion", async () => {
  const { counts, request } = fixture();
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [], usage: { completion_tokens: 17 } }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  await (await request()).text();
  expect(counts).toEqual({ inflight: 0, releases: 1, tokens: 17 });
});
