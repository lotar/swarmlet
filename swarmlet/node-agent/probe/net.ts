// Network measurement against the control plane: rtt (median of timed /health GETs) and down/up
// throughput through control's /probe endpoints. A throughput leg that fails is simply left out;
// the only rejection is control never answering /health (no rtt, nothing worth reporting).

import type { NetMeasurement } from "../../protocol/types.ts";

export interface NetOptions {
  /** Payload size for the throughput legs (default 8,000,000 bytes). */
  bytes?: number;
  /** Number of timed /health requests (default 5). */
  samples?: number;
  /** Per-request budget for the throughput legs (default 60 s); rtt and ip requests get 5 s. */
  timeoutMs?: number;
}

export const NET_PROBE_BYTES = 8_000_000;
const SHORT_TIMEOUT_MS = 5_000;

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? NaN) : ((s[mid - 1] ?? NaN) + (s[mid] ?? NaN)) / 2;
}

const baseUrl = (u: string) => u.replace(/\/+$/, "");
const round = (n: number, places: number) => { const f = 10 ** places; return Math.round(n * f) / f; };
/** Megabits per second for `bytes` moved in `ms` (floored at 1 ms so a local loopback stays finite). */
const mbit = (bytes: number, ms: number) => round((bytes * 8) / 1e6 / (Math.max(ms, 1) / 1000), 1);

function randomBody(n: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(n);
  for (let o = 0; o < n; o += 65_536) crypto.getRandomValues(b.subarray(o, Math.min(n, o + 65_536)));
  return b;
}

export async function measureNet(controlUrl: string, opts: NetOptions = {}): Promise<NetMeasurement> {
  const base = baseUrl(controlUrl);
  const bytes = opts.bytes ?? NET_PROBE_BYTES;
  const samples = opts.samples ?? 5;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const rtts: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(SHORT_TIMEOUT_MS) });
      await res.arrayBuffer();
      if (res.ok) rtts.push(performance.now() - t0);
    } catch { /* a miss */ }
  }
  const rtt = median(rtts);
  if (!Number.isFinite(rtt)) throw new Error(`control unreachable: no /health response in ${samples} tries (${base})`);
  const out: NetMeasurement = { rttMs: round(rtt, 2), measuredAt: new Date().toISOString() };
  // one round trip of request/first-byte latency is not throughput
  const overheadMs = rtt;

  try {
    const t0 = performance.now();
    const res = await fetch(`${base}/probe/down?bytes=${bytes}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok && res.body) {
      const reader = res.body.getReader();
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.byteLength;
      }
      if (got > 0) out.downMbit = mbit(got, performance.now() - t0 - overheadMs);
    }
  } catch { /* leg skipped */ }

  try {
    const body = randomBody(bytes);
    const t0 = performance.now();
    const res = await fetch(`${base}/probe/up`, {
      method: "POST",
      body,
      headers: { "content-type": "application/octet-stream" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const elapsed = performance.now() - t0 - overheadMs;
    if (res.ok) {
      const reply = (await res.json().catch(() => null)) as { bytes?: unknown } | null;
      const sent = typeof reply?.bytes === "number" && reply.bytes > 0 ? reply.bytes : bytes;
      out.upMbit = mbit(sent, elapsed);
    }
  } catch { /* leg skipped */ }

  return out;
}

/** This node's address as control sees it (GET /probe/ip -> {ip}); undefined when unreachable. */
export async function publicIp(controlUrl: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${baseUrl(controlUrl)}/probe/ip`, { signal: AbortSignal.timeout(SHORT_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const reply = (await res.json()) as { ip?: unknown };
    return typeof reply.ip === "string" && reply.ip.length > 0 ? reply.ip : undefined;
  } catch {
    return undefined;
  }
}
