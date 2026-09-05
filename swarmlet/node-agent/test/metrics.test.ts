import { afterEach, expect, test, spyOn } from "bun:test";
import { AssignmentRunner } from "../assignments.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
function fixture() {
  const runner = new AssignmentRunner({} as never);
  const active = (runner as unknown as { active: Map<string, unknown> }).active;
  const add = (id: string, url = "http://127.0.0.1:8099", modelName = "flash") => active.set(id, { a: { id, kind: "replica", modelName, external: { url } }, state: "ready" });
  return { runner, active, add };
}
const metrics = (tokens: number, processing = 1) => new Response(`llamacpp:tokens_predicted_total ${tokens}\nllamacpp:requests_processing ${processing}\nllamacpp:predicted_tokens_seconds 10\n`);

test("duplicate endpoint watches and model names contribute only once", async () => {
  const { runner, add } = fixture(); let calls = 0;
  globalThis.fetch = (async () => { calls++; return metrics(100); }) as unknown as typeof fetch;
  add("a"); add("b", "http://127.0.0.1:8099/"); add("c", "http://127.0.0.1:8099", "alias");
  const m = await runner.serverMetrics();
  expect(calls).toBe(1);
  expect(m).toMatchObject({ tokensTotal: 100, inflight: 1, tokPerSecAvg: 10, serving: "flash, alias", serverMetricsState: "ok" });
  expect(m?.tokPerSec).toBeUndefined();
});

test("new endpoints, removals and counter resets never manufacture throughput", async () => {
  const { runner, active, add } = fixture();
  let now = 1000; const clock = spyOn(Date, "now").mockImplementation(() => now);
  let counts: Record<string, number> = { "8099": 100, "8100": 10000 };
  globalThis.fetch = (async (url: RequestInfo | URL) => metrics(counts[new URL(String(url)).port]!)) as unknown as typeof fetch;
  try {
    add("a"); await runner.serverMetrics();
    now += 2000; counts["8099"] = 120;
    expect((await runner.serverMetrics())?.tokPerSec).toBe(10);
    add("b", "http://127.0.0.1:8100"); now += 2000;
    expect((await runner.serverMetrics())?.tokPerSec).toBeUndefined();
    now += 2000; counts["8100"] = 10020;
    expect((await runner.serverMetrics())?.tokPerSec).toBe(10);
    active.delete("a"); now += 2000; counts["8100"] = 10040;
    expect((await runner.serverMetrics())?.tokPerSec).toBe(10);
    now += 2000; counts["8100"] = 2;
    expect((await runner.serverMetrics())?.tokPerSec).toBeUndefined();
  } finally { clock.mockRestore(); }
});

test("failed or invalid scrapes are unknown and recovery establishes a new baseline", async () => {
  const { runner, add } = fixture(); add("a");
  let now = 1000; const clock = spyOn(Date, "now").mockImplementation(() => now);
  let response = () => metrics(100);
  globalThis.fetch = (async () => response()) as unknown as typeof fetch;
  try {
    await runner.serverMetrics(); now += 2000;
    response = () => new Response("unavailable", { status: 503 });
    expect(await runner.serverMetrics()).toMatchObject({ serverMetricsState: "unavailable", tokPerSec: undefined, inflight: undefined, tokensTotal: undefined });
    response = () => metrics(1000); now += 2000;
    expect((await runner.serverMetrics())?.tokPerSec).toBeUndefined();
    response = () => new Response("<html>not metrics</html>"); now += 2000;
    expect((await runner.serverMetrics())?.serverMetricsState).toBe("unavailable");
  } finally { clock.mockRestore(); }
});

test("a busy server can have zero completed-token rate without being idle", async () => {
  const { runner, add } = fixture(); add("a");
  let now = 1000; const clock = spyOn(Date, "now").mockImplementation(() => now);
  globalThis.fetch = (async () => metrics(100, 1)) as unknown as typeof fetch;
  try { await runner.serverMetrics(); now += 2000; expect(await runner.serverMetrics()).toMatchObject({ tokPerSec: 0, inflight: 1 }); }
  finally { clock.mockRestore(); }
});

test("partial engine coverage never looks like complete totals", async () => {
  const { runner, add } = fixture(); add("a"); add("b", "http://127.0.0.1:8100");
  globalThis.fetch = (async (url: RequestInfo | URL) => String(url).includes("8100") ? new Response("down", { status: 503 }) : metrics(100)) as unknown as typeof fetch;
  expect(await runner.serverMetrics()).toMatchObject({ serverMetricsState: "partial", tokensTotal: undefined, inflight: undefined, tokPerSec: undefined });
});

test("overlapping heartbeats share a pending scrape", async () => {
  const { runner, add } = fixture(); add("a");
  let calls = 0, resolve!: (r: Response) => void;
  globalThis.fetch = (() => { calls++; return new Promise<Response>((r) => { resolve = r; }); }) as unknown as typeof fetch;
  const first = runner.serverMetrics(), second = runner.serverMetrics();
  expect(calls).toBe(1); resolve(metrics(100));
  expect(await first).toEqual(await second);
});
