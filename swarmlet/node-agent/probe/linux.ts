// Linux collectors: /proc/meminfo (MemAvailable), /proc/stat (cpu), nvidia-smi (GPU fallback and
// per-device usage) and the user-slice cgroup delegation. Parsers are pure.

import { readFile } from "node:fs/promises";
import type { GpuDevice } from "../../protocol/types.ts";
import { CODE_NOT_FOUND, exec } from "./exec.ts";
import { clampPct } from "./host.ts";

export interface Meminfo {
  memTotalKiB: number;
  memFreeKiB: number;
  memAvailableKiB: number;
  swapTotalKiB: number;
  swapFreeKiB: number;
}

/** /proc/meminfo -> KiB figures; MemAvailable is approximated on kernels that lack it. */
export function parseMeminfo(text: string): Meminfo | null {
  const kib: Record<string, number> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\w+):\s+(\d+)(?:\s+kB)?\s*$/.exec(line);
    if (m && m[1] && m[2]) kib[m[1]] = Number(m[2]);
  }
  const total = kib.MemTotal;
  const free = kib.MemFree;
  if (total === undefined || free === undefined) return null;
  const available = kib.MemAvailable ?? free + (kib.Buffers ?? 0) + (kib.Cached ?? 0) + (kib.SReclaimable ?? 0);
  return { memTotalKiB: total, memFreeKiB: free, memAvailableKiB: available, swapTotalKiB: kib.SwapTotal ?? 0, swapFreeKiB: kib.SwapFree ?? 0 };
}

export async function linuxFreeRamMiB(): Promise<number> {
  const m = parseMeminfo(await readFile("/proc/meminfo", "utf8"));
  if (!m) throw new Error("/proc/meminfo: unrecognized");
  return Math.floor(m.memAvailableKiB / 1024);
}

export interface ProcStat { idle: number; total: number }

/** Aggregate "cpu" line of /proc/stat: idle (idle + iowait) and total jiffies. */
export function parseProcStat(text: string): ProcStat | null {
  const m = /^cpu\s+(.+)$/m.exec(text);
  if (!m?.[1]) return null;
  const f = m[1].trim().split(/\s+/).map(Number);
  if (f.length < 4 || f.some((n) => !Number.isFinite(n))) return null;
  const idle = (f[3] ?? 0) + (f[4] ?? 0);
  const total = f.slice(0, 8).reduce((a, b) => a + b, 0);
  return { idle, total };
}

export function cpuPctBetween(a: ProcStat, b: ProcStat): number | undefined {
  const dt = b.total - a.total;
  if (dt <= 0) return undefined;
  return clampPct(100 * (1 - (b.idle - a.idle) / dt));
}

/** Machine-wide cpu percent over a `sampleMs` window. */
export async function linuxCpuPct(sampleMs = 1000): Promise<number> {
  const a = parseProcStat(await readFile("/proc/stat", "utf8"));
  await Bun.sleep(sampleMs);
  const b = parseProcStat(await readFile("/proc/stat", "utf8"));
  if (!a || !b) throw new Error("/proc/stat: unrecognized");
  const pct = cpuPctBetween(a, b);
  if (pct === undefined) throw new Error("/proc/stat: no time elapsed");
  return pct;
}

export const NVIDIA_INVENTORY_FIELDS = ["index", "name", "memory.total", "memory.free"] as const;
export const NVIDIA_USED_FIELDS = ["index", "memory.used"] as const;

/** Rows of `nvidia-smi --query-gpu=<fields> --format=csv,noheader,nounits`; a name containing commas is re-joined. */
export function parseNvidiaSmi(text: string, fields: readonly string[]): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = [];
  const nameAt = fields.indexOf("name");
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length > fields.length && nameAt >= 0) {
      const extra = parts.length - fields.length;
      parts.splice(nameAt, extra + 1, parts.slice(nameAt, nameAt + extra + 1).join(", "));
    }
    if (parts.length !== fields.length) continue;
    const row: Record<string, string> = {};
    fields.forEach((f, i) => { row[f] = parts[i] ?? ""; });
    rows.push(row);
  }
  return rows;
}

/** Inventory rows -> GpuDevice (ids cuda:N, engine names CUDAN); rows without a numeric total are dropped. */
export function nvidiaInventory(rows: Array<Record<string, string>>): GpuDevice[] {
  const out: GpuDevice[] = [];
  for (const r of rows) {
    const index = Number(r.index);
    const total = Number(r["memory.total"]);
    const free = Number(r["memory.free"]);
    if (!Number.isInteger(index) || !Number.isFinite(total)) continue;
    const g: GpuDevice = { id: `cuda:${index}`, name: r.name || `CUDA${index}`, backend: "cuda", engineName: `CUDA${index}`, totalMiB: total };
    if (Number.isFinite(free)) g.freeMiB = free;
    out.push(g);
  }
  return out;
}

export function nvidiaUsed(rows: Array<Record<string, string>>): Array<{ id: string; usedMiB: number }> {
  const out: Array<{ id: string; usedMiB: number }> = [];
  for (const r of rows) {
    const index = Number(r.index);
    const used = Number(r["memory.used"]);
    if (Number.isInteger(index) && Number.isFinite(used)) out.push({ id: `cuda:${index}`, usedMiB: used });
  }
  return out;
}

async function nvidiaSmi(fields: readonly string[]): Promise<Array<Record<string, string>>> {
  const r = await exec(["nvidia-smi", `--query-gpu=${fields.join(",")}`, "--format=csv,noheader,nounits"], { timeoutMs: 15_000 });
  if (r.code === CODE_NOT_FOUND) throw new Error("nvidia-smi not found");
  if (r.code !== 0) throw new Error(`nvidia-smi exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`);
  return parseNvidiaSmi(r.stdout, fields);
}

/** GPU inventory without the engine. */
export async function linuxGpusFallback(): Promise<GpuDevice[]> {
  return nvidiaInventory(await nvidiaSmi(NVIDIA_INVENTORY_FIELDS));
}

/** Used VRAM per device (ids cuda:N). */
export async function linuxGpuUsed(): Promise<Array<{ id: string; usedMiB: number }>> {
  return nvidiaUsed(await nvidiaSmi(NVIDIA_USED_FIELDS));
}

export function cgroupControllersPath(uid: number): string {
  return `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`;
}

/** cgroup.controllers ("cpu memory pids") -> which of the two we can enforce with. */
export function parseCgroupControllers(text: string): { memory: boolean; cpu: boolean } {
  const c = new Set(text.trim().split(/\s+/).filter(Boolean));
  return { memory: c.has("memory"), cpu: c.has("cpu") };
}

/** Controllers systemd delegates to this user's slice (throws when the slice is absent or not v2). */
export async function linuxCgroup(uid: number): Promise<{ memory: boolean; cpu: boolean }> {
  return parseCgroupControllers(await readFile(cgroupControllersPath(uid), "utf8"));
}
