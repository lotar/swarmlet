// Controlled real SSE for the embedded node UI. Never forwards chat writes to a model.
// bun swarmlet/e2e/chat-scroll-fixture.ts
import { serveUi } from '../node-agent/ui/ui.ts';
const upstream = process.env.SWARMLET_FIXTURE_NODE_URL || 'http://127.0.0.1:47800';
const liveAssets = process.env.SWARMLET_FIXTURE_LIVE_ASSETS === '1';
let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
const encoder = new TextEncoder();
Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.PORT || 47831), idleTimeout: 0, async fetch(req) {
  const url = new URL(req.url), path = url.pathname;
  if (path === '/fixture/chunk' && req.method === 'POST') {
    if (!stream) return new Response('No active stream', { status: 409 });
    const { content, done } = await req.json();
    stream.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: content || '' } }] }) + '\n\n'));
    if (done) { stream.enqueue(encoder.encode('data: [DONE]\n\n')); stream.close(); stream = undefined; }
    return Response.json({ ok: true });
  }
  if (path === '/v1/models') return Response.json({ data: [{ id: 'scroll-fixture', route: 'mesh', selectable: true }] });
  if (path === '/v1/chat/completions' && req.method === 'POST') {
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(encoder.encode(': connected\n\n')); }, cancel() { stream = undefined; } }), { headers: { 'content-type': 'text/event-stream' } });
  }
  const asset = serveUi(req, path);
  if (asset && !liveAssets) return asset;
  if (req.method === 'GET') {
    const response = await fetch(upstream + path + url.search);
    return new Response(response.body, { status: response.status, headers: { 'content-type': response.headers.get('content-type') || 'application/json' } });
  }
  return new Response('Fixture only', { status: 405 });
} });
console.log('Chat scroll fixture ready');
