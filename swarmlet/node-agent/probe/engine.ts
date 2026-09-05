// Engine (llama.cpp build) inventory, identical on both OSes: GPU devices as ggml names them and the
// build's sha256 manifest. `enginePath` is the directory holding llama-server and ggml-rpc-server.

import { join } from "node:path";
import type { Capabilities, GpuDevice } from "../../protocol/types.ts";
import type { Logger } from "../../control/log.ts";
import { CODE_NOT_FOUND, exec } from "./exec.ts";

/** RPC protocol the shipped engine speaks (push forwarding + wire compression). */
export const ENGINE_PROTO = "8.1";
// A cold static Metal engine compiles its shader library before listing devices.
export const ENGINE_DEVICE_TIMEOUT_MS = 90_000;

// "  MTL0: Apple M5 Max (98304 MiB, 98304 MiB free)"  /  "  RPC0[host:port]: RPC[host:port] (3706 MiB, 3596 MiB free)"
const DEVICE_LINE = /^\s*([A-Za-z]+)(\d*)(?:\[[^\]]*\])?:\s+(.*?)\s+\((\d+)\s+MiB,\s+(\d+)\s+MiB free\)\s*$/;
const NOT_A_GPU = new Set(["CPU", "BLAS", "RPC", "ACCEL"]);

/** Devices from `llama-server --list-devices`; CPU, BLAS and RPC entries are skipped. */
export function parseListDevices(text: string): GpuDevice[] {
  const gpus: GpuDevice[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = DEVICE_LINE.exec(line);
    if (!m) continue;
    const prefix = m[1] ?? "";
    const index = m[2] ?? "";
    if (NOT_A_GPU.has(prefix.toUpperCase())) continue;
    const backend: GpuDevice["backend"] = prefix === "MTL" ? "metal" : prefix === "CUDA" ? "cuda" : "other";
    const idPrefix = backend === "other" ? prefix.toLowerCase() : backend;
    gpus.push({
      id: `${idPrefix}:${index === "" ? 0 : Number(index)}`,
      name: m[3] ?? "",
      backend,
      engineName: `${prefix}${index}`,
      totalMiB: Number(m[4]),
      freeMiB: Number(m[5]),
    });
  }
  return gpus;
}

export type EngineDevices = { ok: true; gpus: GpuDevice[] } | { ok: false; reason: string };

const lastLine = (s: string) => s.trim().split("\n").pop()?.trim() ?? "";

/** Ask the engine itself what it can drive; the caller falls back to OS tools when this is not ok. */
export async function engineDevices(enginePath: string): Promise<EngineDevices> {
  const bin = join(enginePath, "llama-server");
  const r = await exec([bin, "--list-devices"], { timeoutMs: ENGINE_DEVICE_TIMEOUT_MS });
  if (r.code === CODE_NOT_FOUND) return { ok: false, reason: `${bin}: not found` };
  if (r.code !== 0) {
    return { ok: false, reason: `${bin} --list-devices exited ${r.code}${r.timedOut ? " (timed out)" : ""}: ${lastLine(r.stderr) || lastLine(r.stdout)}` };
  }
  if (!/Available devices/i.test(r.stdout)) return { ok: false, reason: `${bin} --list-devices: unexpected output` };
  return { ok: true, gpus: parseListDevices(r.stdout) };
}

/** sha256sum-style manifest ("<hex>  <name>" per line) -> { name: hex }. */
export function parseShaManifest(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m && m[1] && m[2]) out[m[2]] = m[1].toLowerCase();
  }
  return out;
}

/** Engine identity for Capabilities.engine; undefined when there is no llama-server at enginePath. */
export async function engineInfo(enginePath: string, log: Logger): Promise<Capabilities["engine"] | undefined> {
  if (!(await Bun.file(join(enginePath, "llama-server")).exists())) {
    log.warn("engine: llama-server not found; engine info omitted", { enginePath });
    return undefined;
  }
  const manifest = Bun.file(join(enginePath, "sha256.txt"));
  if (!(await manifest.exists())) {
    log.warn("engine: sha256.txt missing; binary hashes unknown", { enginePath });
    return { proto: ENGINE_PROTO, sha256: {} };
  }
  return { proto: ENGINE_PROTO, sha256: parseShaManifest(await manifest.text()) };
}
