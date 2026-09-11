// Deterministic open-window update test. No writes or inference reach the upstream node.
// bun swarmlet/e2e/ui-update-fixture.ts; open http://127.0.0.1:47820/#chat.
// POST /fixture/update advances the served UI; POST /fixture/reply releases the held reply.
import { createHash } from 'node:crypto';
import { serveUi } from '../node-agent/ui/ui.ts';
let build = 1, finishReply = true, replies = 0;
const upstream = process.env.SWARMLET_FIXTURE_NODE_URL || 'http://127.0.0.1:47800';
const base = await serveUi(new Request('http://localhost/ui-version.json'), '/ui-version.json')!.json();
const version = () => createHash('sha256').update(base.version + ':fixture:' + build).digest('hex');
Bun.serve({ hostname: '127.0.0.1', port: 47820, idleTimeout: 0, async fetch(req) {
  const url = new URL(req.url), path = url.pathname;
  if (path === '/fixture/update' && req.method === 'POST') { build++; return Response.json({ build, version: version() }); }
  if (path === '/fixture/reply' && req.method === 'POST') { finishReply = (await req.json()).finish; return Response.json({ finishReply }); }
  if (path === '/fixture/state') return Response.json({ build, version: version(), replies, finishReply });
  if (path === '/v1/models') return Response.json({ object: 'list', data: [{ id: 'ui-update-fixture', route: 'mesh', selectable: true }] });
  if (path === '/v1/chat/completions' && req.method === 'POST') {
    const encoder = new TextEncoder(); replies++;
    return new Response(new ReadableStream({ async start(controller) {
      const frame = (content: string) => encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n');
      controller.enqueue(frame('**Streaming'));
      while (!finishReply && !req.signal.aborted) await Bun.sleep(50);
      if (req.signal.aborted) { controller.close(); return; }
      controller.enqueue(frame(' update**\n\nFinished without interruption.'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  }
  const asset = serveUi(req, path);
  if (asset) {
    if (path === '/ui-version.json') return Response.json({ version: version() }, { headers: { 'cache-control': 'no-store' } });
    if (path === '/' || path === '/index.html') return new Response((await asset.text()).replace(base.version, version()), { headers: asset.headers });
    if (path === '/app.js') return new Response((await asset.text()) + '\nwindow.__fixtureBuild = ' + build + ';', { headers: asset.headers });
    return asset;
  }
  if (req.method === 'GET' && (path.startsWith('/api/') || path.startsWith('/v1/'))) {
    const response = await fetch(upstream + path + url.search);
    return new Response(response.body, { status: response.status, headers: { 'content-type': response.headers.get('content-type') || 'application/json' } });
  }
  return new Response('fixture only', { status: 405 });
} });
console.log('UI update fixture http://127.0.0.1:47820/#chat');
