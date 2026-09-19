// Bench cache hygiene: entries are keyed by (model sha, binary sha, ctx), a corrupt cache is a miss,
// and benchKey is stable.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BENCH_CACHE, benchKey, readBenchCache, writeBenchCache } from "../bench.ts";
import type { BenchResult } from "../../protocol/types.ts";

const entry = (over: Partial<BenchResult> = {}): BenchResult => ({
  modelSha256: "a".repeat(64), engine: "e".repeat(64), engineSha256: "b".repeat(64), kind: "llama-server",
  ctx: 1024, parallel: 1, promptTokens: 512, genTokens: 32, prefillTokPerSec: 100, decodeTokPerSec: 20, measuredAt: "2026-09-19T00:00:00.000Z", ...over,
});

describe("bench cache", () => {
  test("round-trips entries and misses safely on corruption", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarmlet-bench-"));
    try {
      const file = join(dir, BENCH_CACHE);
      expect(readBenchCache(file).entries).toEqual({});
      const e = entry();
      writeBenchCache(file, { entries: { [benchKey(e)]: e } });
      expect(Object.values(readBenchCache(file).entries)).toEqual([e]);
      writeFileSync(file, "{not json");
      expect(readBenchCache(file).entries).toEqual({});
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("benchKey separates model, binary and context", () => {
    const base = benchKey(entry());
    expect(benchKey(entry({ modelSha256: "f".repeat(64) }))).not.toBe(base);
    expect(benchKey(entry({ engineSha256: "f".repeat(64) }))).not.toBe(base);
    expect(benchKey(entry({ ctx: 2048 }))).not.toBe(base);
  });
});
