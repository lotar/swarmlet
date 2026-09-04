// macOS collectors: vm_stat (free + reclaimable RAM), system_profiler (GPU fallback when the engine
// cannot answer), ps (cpu). Parsers are pure so they can be tested without the tools.

import type { GpuDevice } from "../../protocol/types.ts";
import { exec } from "./exec.ts";
import { clampPct, parsePsCpu } from "./host.ts";

const MiB = 1024 * 1024;

export interface VmStat {
  pageSize: number;
  free: number;
  inactive: number;
  speculative: number;
  purgeable: number;
  active: number;
  wired: number;
}

/** `vm_stat` output -> page counts; null when the header or one of the gated counters is missing. */
export function parseVmStat(text: string): VmStat | null {
  const header = /page size of (\d+) bytes/.exec(text);
  if (!header?.[1]) return null;
  const pages = (label: string): number => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, "m").exec(text);
    return m?.[1] ? Number(m[1]) : NaN;
  };
  const v: VmStat = {
    pageSize: Number(header[1]),
    free: pages("Pages free"),
    inactive: pages("Pages inactive"),
    speculative: pages("Pages speculative"),
    purgeable: pages("Pages purgeable"),
    active: pages("Pages active"),
    wired: pages("Pages wired down"),
  };
  if (![v.free, v.inactive, v.speculative, v.purgeable].every(Number.isFinite)) return null;
  return v;
}

/** "free + reclaimable": free, inactive, speculative and purgeable pages; the gate operators use before loading a model. */
export function reclaimableMiB(v: VmStat): number {
  return Math.floor(((v.free + v.inactive + v.speculative + v.purgeable) * v.pageSize) / MiB);
}

export async function darwinFreeRamMiB(): Promise<number> {
  const r = await exec(["vm_stat"], { timeoutMs: 5_000 });
  if (r.code !== 0) throw new Error(`vm_stat exited ${r.code}: ${r.stderr.trim()}`);
  const v = parseVmStat(r.stdout);
  if (!v) throw new Error("vm_stat: unrecognized output");
  return reclaimableMiB(v);
}

export interface DisplayGpu { name: string; cores?: number; vendor?: string }

/** `system_profiler SPDisplaysDataType -json` -> GPU entries (display panels are not GPUs and are skipped). */
export function parseDisplays(jsonText: string): DisplayGpu[] {
  let doc: unknown;
  try { doc = JSON.parse(jsonText); } catch { return []; }
  if (!doc || typeof doc !== "object") return [];
  const list = (doc as Record<string, unknown>).SPDisplaysDataType;
  if (!Array.isArray(list)) return [];
  const out: DisplayGpu[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.sppci_device_type === "string" && rec.sppci_device_type !== "spdisplays_gpu") continue;
    const name = typeof rec.sppci_model === "string" ? rec.sppci_model : typeof rec._name === "string" ? rec._name : "Apple GPU";
    const g: DisplayGpu = { name };
    const cores = Number(rec.sppci_cores);
    if (Number.isFinite(cores) && cores > 0) g.cores = cores;
    if (typeof rec.spdisplays_vendor === "string") g.vendor = rec.spdisplays_vendor;
    out.push(g);
  }
  return out;
}

/** Metal's recommended working set on Apple Silicon is 75 % of unified memory. */
export const METAL_WORKING_SET_FRACTION = 0.75;

/** GPU inventory without the engine: names from system_profiler, budget = Metal's working set. */
export async function darwinGpusFallback(ramMiB: number, arch: string): Promise<GpuDevice[]> {
  const r = await exec(["system_profiler", "SPDisplaysDataType", "-json"], { timeoutMs: 15_000 });
  const devs = r.code === 0 ? parseDisplays(r.stdout) : [];
  // unified memory: an Apple Silicon Mac always has exactly one Metal device
  if (devs.length === 0 && arch === "arm64") devs.push({ name: "Apple GPU" });
  if (devs.length === 0) throw new Error(r.code === 0 ? "system_profiler: no GPU listed" : `system_profiler exited ${r.code}: ${r.stderr.trim()}`);
  const totalMiB = Math.floor(ramMiB * METAL_WORKING_SET_FRACTION);
  return devs.map((d, i) => ({ id: `metal:${i}`, name: d.name, backend: "metal" as const, engineName: `MTL${i}`, totalMiB }));
}

/** Machine-wide cpu percent from the kernel's per-process recent-usage figures. */
export async function darwinCpuPct(cores: number): Promise<number> {
  const r = await exec(["ps", "-A", "-o", "%cpu="], { timeoutMs: 5_000 });
  if (r.code !== 0) throw new Error(`ps exited ${r.code}: ${r.stderr.trim()}`);
  return clampPct(parsePsCpu(r.stdout) / Math.max(1, cores));
}
