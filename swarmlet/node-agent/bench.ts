// Registration-time benchmark: one fixed reference request per (model, engine, ctx) on this node.
//
// The number this produces is the input the controller prices topologies with, so it must reflect a
// real engine run, not a hardware guess. The engine is started on a scratch port, asked for a fixed
// prompt and a fixed greedy output, and stopped; the engine's own `timings` are recorded. Results are
// cached by (model sha, binary sha, ctx); a changed model or engine invalidates the entry, never
// silently reuses it.
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import type { BenchResult, ModelFile } from "../protocol/types.ts";
import { exeName } from "./platform.ts";
import { engineInfo } from "./probe/engine.ts";
import { makeLogger, type Logger } from "../control/log.ts";

export const BENCH_CACHE = "bench.json";
export const BENCH_TIMEOUT_MS = 120_000;
const REFERENCE_CTX = 1024;
const PROMPT_TOKENS = 512;
const GEN_TOKENS = 32;

export interface BenchCache { entries: Record<string, BenchResult> }
const key = (modelSha256: string, engineSha256: string, ctx: number) => `${modelSha256}:${engineSha256}:${ctx}`;

export function readBenchCache(file: string): BenchCache {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as BenchCache;
    if (parsed && typeof parsed.entries === "object" && parsed.entries) return { entries: parsed.entries };
  } catch { /* missing or corrupt cache is a miss, not an error */ }
  return { entries: {} };
}

export function writeBenchCache(file: string, cache: BenchCache): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

/** Cached entries the engine we run right now actually produced. A stale entry (different binary or
 *  model) is never reported: the planner must not price a node by a measurement that no longer applies. */
export async function cachedBench(enginePath: string, file: string, log?: Logger): Promise<BenchResult[]> {
  const info = await engineInfo(enginePath, log ?? makeLogger("bench"));
  const llama = info?.sha256?.["llama-server"];
  if (!llama) return [];
  return Object.values(readBenchCache(file).entries).filter((e) => e.engineSha256 === llama && e.ctx > 0);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

async function waitHealthy(port: number, child: ChildProcess, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`engine exited with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch { /* not up yet */ }
    await Bun.sleep(300);
  }
  throw new Error("engine health timeout");
}

function stop(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 5000).unref?.();
}

/** Run the reference request against one model. Returns undefined and logs on any failure: a node
 *  that cannot bench a model simply has no measurement for it, and the planner will say so. */
export async function benchModel(opts: {
  enginePath: string; model: ModelFile; ctx?: number; timeoutMs?: number; log?: Logger; dataDir: string;
}): Promise<BenchResult | undefined> {
  const log = opts.log ?? makeLogger("bench");
  if (!opts.model.sha256) { log.warn("bench: model has no hash", { model: opts.model.name }); return undefined; }
  const binary = join(opts.enginePath, exeName("llama-server"));
  if (!existsSync(binary)) { log.warn("bench: llama-server missing", { enginePath: opts.enginePath }); return undefined; }
  const ctx = opts.ctx ?? REFERENCE_CTX;
  const timeoutMs = opts.timeoutMs ?? BENCH_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const port = await freePort();
  const child = spawn(binary, ["-m", opts.model.path, "--host", "127.0.0.1", "--port", String(port), "-ngl", "999",
    "-c", String(ctx), "--parallel", "1", "--temp", "0", "--alias", "bench"], { stdio: ["ignore", "ignore", "ignore"] });
  try {
    await waitHealthy(port, child, deadline);
    const prompt = ("Snow falls on the quiet mountain village while the river keeps its steady course. ").repeat(64).slice(0, PROMPT_TOKENS * 4);
    const response = await fetch(`http://127.0.0.1:${port}/v1/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, max_tokens: GEN_TOKENS, temperature: 0, cache_prompt: false }),
      signal: AbortSignal.timeout(Math.max(5_000, deadline - Date.now())),
    });
    if (!response.ok) throw new Error(`completion HTTP ${response.status}`);
    const body = await response.json() as { timings?: Record<string, number>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const t = body.timings ?? {};
    const promptTokens = Number(t.prompt_n ?? body.usage?.prompt_tokens ?? 0);
    const genTokens = Number(t.predicted_n ?? body.usage?.completion_tokens ?? 0);
    const prefill = Number(t.prompt_per_second ?? (promptTokens > 0 && t.prompt_ms ? (promptTokens / t.prompt_ms) * 1000 : 0));
    const decode = Number(t.predicted_per_second ?? (genTokens > 0 && t.predicted_ms ? (genTokens / t.predicted_ms) * 1000 : 0));
    if (!(promptTokens > 0) || !(genTokens > 0) || !(prefill > 0) || !(decode > 0)) throw new Error("engine reported no phase timings");
    const info = await engineInfo(opts.enginePath, log);
    const engineSha256 = info?.sha256?.["llama-server"];
    if (!engineSha256) throw new Error("engine hash unavailable");
    const result: BenchResult = {
      modelSha256: opts.model.sha256, engine: info?.stages?.engine ?? info?.proto ?? "", engineSha256, kind: "llama-server", ctx, parallel: 1,
      promptTokens, genTokens, prefillTokPerSec: Math.round(prefill * 10) / 10, decodeTokPerSec: Math.round(decode * 10) / 10,
      measuredAt: new Date().toISOString(),
    };
    const file = join(opts.dataDir, BENCH_CACHE);
    const cache = readBenchCache(file);
    cache.entries[key(result.modelSha256, engineSha256, ctx)] = result;
    writeBenchCache(file, cache);
    log.info("bench", { model: opts.model.name, prefillTokPerSec: result.prefillTokPerSec, decodeTokPerSec: result.decodeTokPerSec, ctx });
    return result;
  } catch (e) {
    log.warn("bench failed", { model: opts.model.name, err: (e as Error).message });
    return undefined;
  } finally {
    stop(child);
  }
}

/** Benchmark every local model within a total budget; used by `join` so a fresh node registers with
 *  measurements already attached. Best effort: a model that cannot load is skipped, never fatal. */
export async function benchAll(opts: {
  enginePath: string; models: ModelFile[]; dataDir: string; budgetMs?: number; filter?: string; log?: Logger;
}): Promise<BenchResult[]> {
  const budget = opts.budgetMs ?? 180_000;
  const deadline = Date.now() + budget;
  const results: BenchResult[] = [];
  for (const model of opts.models) {
    if (opts.filter && !model.path.includes(opts.filter)) continue;
    if (model.kind !== "gguf") continue;
    if (Date.now() > deadline) break;
    const remaining = deadline - Date.now();
    const result = await benchModel({ enginePath: opts.enginePath, model, dataDir: opts.dataDir, timeoutMs: Math.min(BENCH_TIMEOUT_MS, remaining), log: opts.log });
    if (result) results.push(result);
  }
  return results;
}

/** Stable identity of a bench entry for cache keys and logs. */
export const benchKey = (r: BenchResult): string => createHash("sha256").update(`${r.modelSha256}:${r.engineSha256}:${r.ctx}`).digest("hex").slice(0, 16);
