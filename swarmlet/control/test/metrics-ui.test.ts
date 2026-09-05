import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
// Exercise the actual browser presentation function with the same JSON snapshots the SSE API sends.
const source = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
const functionSource = source.slice(source.indexOf("  function throughput("), source.indexOf("  function tpsCell("));
const throughput = new Function("m", "routed", 'var isNum = function(v) { return typeof v === "number" && Number.isFinite(v); };' + functionSource + '\nreturn throughput(m, routed);') as (m: unknown, routed?: number) => { value: number | null; label: string };
const fresh = () => ({ ts: new Date().toISOString(), serverMetricsState: "ok", tokPerSec: 0 });
test("busy bypass traffic does not display zero throughput as idle", () => {
  expect(throughput({ ...fresh(), inflight: 1 })).toEqual({ value: null, label: "1 active · decode rate unavailable" });
  expect(throughput({ ...fresh(), inflight: 0 }).label).toBe("idle at engine sample");
});
test("routed estimate, completed interval, unknown and stale rates are distinct", () => {
  expect(throughput({ ...fresh(), inflight: 1 }, 12).label).toContain("routed stream estimate");
  expect(throughput({ ...fresh(), tokPerSec: 12 }).label).toBe("completed-token interval");
  expect(throughput(fresh()).label).toBe("activity unknown");
  expect(throughput({ ...fresh(), ts: "2020-01-01T00:00:00Z", tokPerSec: 50 }).value).toBeNull();
  expect(throughput({ ...fresh(), serverMetricsState: "partial", tokPerSec: 50 }).value).toBeNull();
});
