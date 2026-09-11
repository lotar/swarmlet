import type { TelemetryStore, RequestTelemetry } from './telemetry.ts';

/** Observe byte counts and timing only; payload bytes pass through unchanged and are never stored. */
export function telemetryResponse(req: Request, response: Response, started: number, store: TelemetryStore, observation?: { failed: boolean }): Response {
  const path = new URL(req.url).pathname;
  const endpoint = path === '/v1/chat/completions' ? 'chat' : path === '/v1/completions' ? 'completion' : path === '/v1/embeddings' ? 'embedding' : null;
  if (!endpoint || req.method !== 'POST') return response;
  const node = response.headers.get('x-swarmlet-node'), deployment = response.headers.get('x-swarmlet-deployment') ?? undefined;
  let bytes = 0, firstByteMs: number | undefined, finished = false;
  const finish = (outcome: RequestTelemetry['outcome']) => {
    if (finished) return;
    finished = true; req.signal.removeEventListener('abort', aborted);
    store.request(node, { status: response.status, durationMs: Math.max(0, performance.now() - started), firstByteMs, bytes, outcome, endpoint, deployment });
  };
  const aborted = () => finish('cancelled');
  req.signal.addEventListener('abort', aborted, { once: true });
  if (req.signal.aborted) aborted();
  if (!response.body) { finish(response.ok && !observation?.failed ? 'complete' : 'error'); return response; }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) { finish(response.ok && !observation?.failed ? 'complete' : 'error'); controller.close(); return; }
        if (result.value.byteLength) { firstByteMs ??= Math.max(0, performance.now() - started); bytes += result.value.byteLength; }
        controller.enqueue(result.value);
      } catch (error) { finish(req.signal.aborted ? 'cancelled' : 'error'); controller.error(error); }
    },
    async cancel(reason) { finish('cancelled'); await reader.cancel(reason).catch(() => {}); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
