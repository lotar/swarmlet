import { afterEach, expect, test } from "bun:test";
import { createRouter } from "../../control/router.ts";
import { createNodeInference } from "../../node-agent/inference.ts";
const servers: Array<{ stop(force: boolean): void }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });
function serve(fetch: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch }); servers.push(server); return server;
}
function setup(engine: (req: Request) => Response | Promise<Response>, tunnelFails = false) {
  const upstream = serve(engine); let inflight = 0, releases = 0;
  const router = createRouter({ deployments: {
    routing: () => [{ modelName: "test", deployments: [{ id: "d", nodeId: "n", port: upstream.port, inflight: 0 }] }],
    trackInflight: (_: string, n: number) => { inflight += n; if (n < 0) releases++; }, recordTokens: () => {},
  } as never, tunnels: { localPort: async () => { if (tunnelFails) throw new Error("node disconnected"); return upstream.port; } } as never,
  log: { warn: () => {}, debug: () => {} } as never });
  const control = serve(req => router(req, new URL(req.url).pathname));
  const node = createNodeInference({ local: () => [], remote: () => ({ url: `http://127.0.0.1:${control.port}`, key: "test" }), nodeId: () => "client" });
  const gateway = serve(req => node(req, new URL(req.url).pathname));
  const request = (signal?: AbortSignal) => fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "test", stream: true }), headers: { "x-request-id": "regression-request" }, signal });
  const directRequest = () => fetch(`http://127.0.0.1:${control.port}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "test", stream: true }) });
  return { request, directRequest, breakEngine: () => upstream.stop(true), counts: () => ({ inflight, releases }) };
}
const sse = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });
for (const prefix of ["", 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']) {
  test(`real HTTP gateway→router detects EOF ${prefix ? "after" : "before"} text exactly once without replay`, async () => {
    let calls = 0; const fixture = setup(() => { calls++; return sse(prefix); });
    const response = await fixture.request(); const body = await response.text();
    expect(response.status).toBe(200);
    expect(body.startsWith(prefix)).toBe(true);
    expect(body.match(/upstream_stream_interrupted/g)).toHaveLength(1);
    expect(body).not.toContain("data: [DONE]"); expect(calls).toBe(1);
    expect(fixture.counts()).toEqual({ inflight: 0, releases: 1 });
  });
}
test("real HTTP normal CRLF SSE is preserved", async () => {
  const body = 'data: {"choices":[]}\r\n\r\ndata: [DONE]\r\n\r\n';
  const fixture = setup(() => sse(body)); expect(await (await fixture.request()).text()).toBe(body);
  expect(fixture.counts()).toEqual({ inflight: 0, releases: 1 });
});
test("direct router HTTP client receives explicit error after decoded gzip SSE EOF", async () => {
  const prefix = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n';
  const compressed = Bun.gzipSync(new TextEncoder().encode(prefix));
  const fixture = setup(() => new Response(compressed, { headers: { "content-type": "text/event-stream", "content-encoding": "gzip", "content-length": String(compressed.length) } }));
  const response = await fixture.directRequest();
  expect(response.headers.get("content-encoding")).toBeNull();
  const body = await response.text();
  expect(body.startsWith(prefix)).toBe(true);
  expect(body.match(/upstream_stream_interrupted/g)).toHaveLength(1);
  if (response.headers.has("content-length")) expect(Number(response.headers.get("content-length"))).toBe(Buffer.byteLength(body));
  expect(fixture.counts()).toEqual({ inflight: 0, releases: 1 });
});
test("real HTTP explicit upstream 502 preserves reason and never replays", async () => {
  let calls = 0; const fixture = setup(req => { calls++; expect(req.headers.get("x-request-id")).toBe("regression-request"); return Response.json({ error: { message: "worker transport unavailable" } }, { status: 502 }); });
  const response = await fixture.request(); expect(response.status).toBe(502); expect(response.headers.get("x-request-id")).toBe("regression-request");
  expect(await response.json()).toEqual({ error: { message: "worker transport unavailable" } }); expect(calls).toBe(1);
  expect(fixture.counts()).toEqual({ inflight: 0, releases: 1 });
});
test("tunnel setup rejection becomes structured 502 with balanced inflight", async () => {
  const fixture = setup(() => sse("data: [DONE]\n\n"), true);
  const response = await fixture.request(); expect(response.status).toBe(502);
  expect((await response.json() as any).error.message).toContain("node disconnected");
  expect(fixture.counts()).toEqual({ inflight: 0, releases: 1 });
});
test("real HTTP downstream abort reaches engine through both gateways", async () => {
  let cancelled = false, calls = 0;
  const fixture = setup(req => { calls++; req.signal.addEventListener("abort", () => { cancelled = true; });
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: {}\n\n")); }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } }); });
  const abort = new AbortController(); const response = await fixture.request(abort.signal);
  await response.body!.getReader().read(); abort.abort();
  for (let i = 0; i < 100 && !cancelled; i++) await Bun.sleep(10);
  expect(cancelled).toBe(true); expect(calls).toBe(1);
  expect(fixture.counts()).toEqual({ inflight: 0, releases: 1 });
});

test("real HTTP engine connection loss after text becomes explicit stream error", async () => {
  let calls = 0;
  const fixture = setup(() => { calls++; return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')); } }), { headers: { "content-type": "text/event-stream" } }); });
  const response = await fixture.request(); const reader = response.body!.getReader();
  const first = await reader.read(); expect(new TextDecoder().decode(first.value)).toContain("partial");
  fixture.breakEngine();
  let rest = ""; while (true) { const next = await reader.read(); if (next.done) break; rest += new TextDecoder().decode(next.value); }
  expect(rest).toContain("upstream_stream_interrupted"); expect(calls).toBe(1);
  expect(fixture.counts()).toEqual({ inflight: 0, releases: 1 });
});
