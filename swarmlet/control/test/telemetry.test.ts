import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TelemetryStore } from '../telemetry.ts';
import { fleetNode } from './fleet-fixture.ts';
import { telemetryResponse } from '../telemetry-response.ts';
function fixture(options: { maxAgeMs?: number; maxBytes?: number; segmentMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'swarmlet-telemetry-'));
  let now = 1800000000000;
  const settings = { ...options, segmentBytes: 512 * 1024, now: () => now };
  let store = new TelemetryStore(dir, settings);
  return { dir, get store() { return store; }, now: () => now, advance: (ms: number) => { now += ms; }, reopen() { store.close(); store = new TelemetryStore(dir, settings); }, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const rates = { inBps: 100, outBps: 200 };
test('records detailed numeric data without identifiers or free-form nested strings, and survives restart', () => {
  const f = fixture(), secret = 'IDENTITY_SENTINEL_192.168.2.1_prompt_password', node = fleetNode(secret);
  node.hostname = secret;
  try {
    const metrics = { ts: new Date(f.now()).toISOString(), cpuPct: 25, rssMiB: 123, serving: secret,
      gpu: [{ id: secret, usedMiB: 10, temperatureC: 50 }], network: [{ name: secret, rxBps: 12 }],
      hardware: { measuredAt: secret, fans: [{ id: secret, name: secret, rpm: 1000 }], temperatures: [{ name: secret, celsius: 42 }], fanControl: { state: 'error' as const, detail: secret } },
      runtime: { releaseSequence: 2026091104, uptimeSec: 100, workers: 1, coordinators: 0, replicas: 0, stages: 0 },
    };
    f.store.sample(node, metrics, rates); f.store.connection(node.id, true);
    f.store.request(node.id, { endpoint: 'chat', status: 200, durationMs: 500, firstByteMs: 25, bytes: 100, outcome: 'complete', deployment: secret });
    const id = f.store.anonymousId(node.id), before = f.store.query();
    expect(JSON.stringify(before)).not.toContain(secret);
    expect(before.sources[0]!.latest.values.cpuPct).toBe(25);
    expect(before.sources[0]!.latest.temperatures[0]!.celsius).toBe(42);
    expect(before.sources[0]!.latest.runtime.releaseSequence).toBe(2026091104);
    expect(before.requests.averageDurationMs).toBe(500);
    expect(before.requests.averageFirstByteMs).toBe(25);
    expect(before.series[0]!.cpuPct).toBe(25);
    f.reopen(); expect(f.store.anonymousId(node.id)).toBe(id); expect(f.store.query().retention.records).toBe(3);
    for (const file of readdirSync(f.dir)) expect(readFileSync(join(f.dir, file)).includes(Buffer.from(secret))).toBe(false);
  } finally { f.close(); }
});
test('both age and allocated disk limits rotate oldest shards, including after restart and without new traffic', () => {
  const f = fixture({ maxAgeMs: 1000, maxBytes: 2 * 1024 * 1024, segmentMs: 100 });
  try {
    const node = fleetNode('old');
    f.store.sample(node, { ts: new Date(f.now()).toISOString(), cpuPct: 1 }, rates);
    f.advance(101);
    const recent = fleetNode('recent');
    for (let i = 0; i < 200; i++) f.store.sample(recent, { ts: new Date(f.now()).toISOString(), cpuPct: 2, hardware: { measuredAt: '', fans: [], temperatures: Array.from({ length: 2048 }, () => ({ name: 'redact', celsius: Math.random() * 100 })), fanControl: { state: 'automatic', detail: '' } } }, rates);
    const disk = () => readdirSync(f.dir).reduce((n, file) => n + statSync(join(f.dir, file)).size, 0);
    expect(disk()).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(f.store.query({ rangeMs: 1000 }).sources.some(s => s.source === f.store.anonymousId('old'))).toBe(false);
    expect(f.store.query({ rangeMs: 1000 }).retention.dropped).toBe(0);
    f.reopen(); expect(disk()).toBeLessThanOrEqual(2 * 1024 * 1024);
    f.advance(1001); f.store.prune();
    expect(f.store.query({ rangeMs: 1000 }).retention.records).toBe(0);
    expect(disk()).toBe(32);
  } finally { f.close(); }
});
test('range and anonymous node filters preserve missing data and reject SQL-like inputs', () => {
  const f = fixture();
  try {
    f.store.sample(fleetNode('a'), { ts: new Date(f.now()).toISOString(), cpuPct: 10 }, rates);
    f.store.sample(fleetNode('b'), { ts: new Date(f.now()).toISOString(), cpuPct: 30 }, rates);
    expect(f.store.query().series[0]!.cpuPct).toBe(20);
    expect(f.store.query().series[0]!.gpuUsedMiB).toBeNull();
    expect(f.store.query({ source: f.store.anonymousId('a') }).series[0]!.cpuPct).toBe(10);
    expect(() => f.store.query({ source: "' OR 1=1" })).toThrow('invalid telemetry');
    expect(() => f.store.query({ rangeMs: 1000 * 3600 * 73 })).toThrow('invalid telemetry');
  } finally { f.close(); }
});
test('response observer preserves streaming bytes, captures latency/status and records cancellation once', async () => {
  const f = fixture();
  try {
    const req = new Request('http://local/v1/chat/completions', { method: 'POST', body: 'PRIVATE_PROMPT' });
    const response = telemetryResponse(req, new Response('PRIVATE_REPLY', { headers: { 'x-swarmlet-node': 'node', 'x-swarmlet-deployment': 'dep' } }), performance.now(), f.store);
    expect(await response.text()).toBe('PRIVATE_REPLY');
    let q = f.store.query(); expect(q.requests.count).toBe(1); expect(q.requests.bytes).toBe(13); expect(JSON.stringify(q)).not.toContain('PRIVATE');
    const abort = new AbortController();
    const pending = telemetryResponse(new Request(req.url, { method: 'POST', signal: abort.signal }), new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array([1])); } })), performance.now(), f.store);
    const reader = pending.body!.getReader(); await reader.read(); abort.abort(); await reader.cancel();
    q = f.store.query(); expect(q.requests.count).toBe(2); expect(q.requests.cancelled).toBe(1);
  } finally { f.close(); }
});

test('structured SSE errors count as failures even when HTTP status is 200', async () => {
  const f = fixture();
  const { inferenceStream } = await import('../../protocol/inference-stream.ts');
  try {
    const state = { failed: false }, abort = new AbortController(), raw = 'data: {"error":{"message":"private engine message"}}\n\ndata: [DONE]\n\n';
    const upstream = new Response(raw, { headers: { 'content-type': 'text/event-stream' } });
    const response = new Response(inferenceStream(upstream, abort, { failure: () => { state.failed = true; } }), { headers: upstream.headers });
    const observed = telemetryResponse(new Request('http://local/v1/chat/completions', { method: 'POST' }), response, performance.now(), f.store, state);
    expect(await observed.text()).toBe(raw);
    expect(f.store.query().requests.errors).toBe(1);
    expect(JSON.stringify(f.store.query())).not.toContain('private engine message');
  } finally { f.close(); }
});

 test('a lost telemetry directory drops records without interrupting responses', async () => {
  const f = fixture(), moved = f.dir + '-offline';
  try {
    renameSync(f.dir, moved);
    const response = telemetryResponse(new Request('http://local/v1/chat/completions', { method: 'POST' }), new Response('still available'), performance.now(), f.store);
    expect(await response.text()).toBe('still available');
    renameSync(moved, f.dir);
    expect(f.store.query().retention.dropped).toBe(1);
    expect(f.store.query().retention.error).toContain('inference continues');
    f.store.connection('recovered', true);
    expect(f.store.query().retention.error).toBeNull();
  } finally { rmSync(moved, { recursive: true, force: true }); f.close(); }
});
