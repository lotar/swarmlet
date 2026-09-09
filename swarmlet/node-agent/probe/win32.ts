// Windows collectors: os.cpus() deltas (cpu), os.freemem() (available RAM), tasklist (resident memory
// of engine pids), PowerShell CIM for disk free and process identity. nvidia-smi is shared with Linux.
// Parsers are pure so they can be tested on any OS without the tools.

import { cpus, freemem } from "node:os";
import { CODE_NOT_FOUND, exec } from "./exec.ts";

const MiB = 1024 * 1024;
const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n * 10) / 10));

export interface CpuTimes { idle: number; total: number }

/** Aggregate idle/total ticks of an os.cpus() listing. */
export function cpuTimes(list: ReadonlyArray<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const c of list) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

export function cpuPctBetweenTimes(a: CpuTimes, b: CpuTimes): number | undefined {
  const dt = b.total - a.total;
  if (dt <= 0) return undefined;
  return clamp(100 * (1 - (b.idle - a.idle) / dt));
}

/** Machine-wide cpu percent over a `sampleMs` window (no external tool). */
export async function win32CpuPct(sampleMs = 1000): Promise<number> {
  const a = cpuTimes(cpus());
  await Bun.sleep(sampleMs);
  const b = cpuTimes(cpus());
  const pct = cpuPctBetweenTimes(a, b);
  if (pct === undefined) throw new Error("os.cpus: no time elapsed");
  return pct;
}

/** Available physical memory (GlobalMemoryStatusEx.ullAvailPhys via os.freemem). */
export async function win32FreeRamMiB(): Promise<number> {
  return Math.floor(freemem() / MiB);
}

export interface TasklistRow { image: string; pid: number; memKiB: number }

/**
 * `tasklist /FO CSV /NH` -> rows. The memory column is locale formatted ("12,345 K" or "12.345 K"),
 * so every non-digit is dropped before parsing.
 */
export function parseTasklistCsv(text: string): TasklistRow[] {
  const rows: TasklistRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith("\"")) continue;
    const cols = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => (m[1] ?? "").replace(/""/g, "\""));
    if (cols.length < 5) continue;
    const pid = Number(cols[1]);
    const memKiB = Number((cols[4] ?? "").replace(/[^0-9]/g, ""));
    if (!Number.isInteger(pid) || !Number.isFinite(memKiB)) continue;
    rows.push({ image: cols[0] ?? "", pid, memKiB });
  }
  return rows;
}

/** Resident memory (MiB) of the given pids from one tasklist call; gone pids count as 0. */
export async function win32RssMiB(pids: number[]): Promise<number | undefined> {
  const want = new Set(pids.filter((p) => Number.isInteger(p) && p > 0));
  if (want.size === 0) return undefined;
  const r = await exec(["tasklist", "/FO", "CSV", "/NH"], { timeoutMs: 10_000 });
  if (r.code === CODE_NOT_FOUND) throw new Error("tasklist not found");
  if (r.code !== 0) throw new Error(`tasklist exited ${r.code}: ${r.stderr.trim()}`);
  let kib = 0;
  for (const row of parseTasklistCsv(r.stdout)) if (want.has(row.pid)) kib += row.memKiB;
  return Math.floor(kib / 1024);
}

const POWERSHELL = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;

/** Drive letter of a Windows path ("C:\\Users\\x" -> "C:"); null for UNC or relative paths. */
export function driveOf(path: string): string | null {
  const m = /^([A-Za-z]):/.exec(path);
  return m?.[1] ? `${m[1].toUpperCase()}:` : null;
}

/** Free bytes of the volume holding `path` (Win32_LogicalDisk.FreeSpace). */
export async function win32DiskFreeMiB(path: string): Promise<number> {
  const drive = driveOf(path);
  if (!drive) throw new Error(`no drive letter in ${path}`);
  const cmd = `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'").FreeSpace`;
  const r = await exec([...POWERSHELL, cmd], { timeoutMs: 20_000 });
  if (r.code === CODE_NOT_FOUND) throw new Error("powershell not found");
  if (r.code !== 0) throw new Error(`powershell exited ${r.code}: ${r.stderr.trim()}`);
  const bytes = Number(r.stdout.trim());
  if (!Number.isFinite(bytes)) throw new Error(`Win32_LogicalDisk: unrecognized output ${JSON.stringify(r.stdout.trim())}`);
  return Math.floor(bytes / MiB);
}

export interface Win32ProcessInfo { created: string; command: string }

/** One "<ISO creation time>\t<command line>" line (the format win32ProcessIdentity asks PowerShell for). */
export function parseProcessLine(text: string): Win32ProcessInfo | null {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  const tab = line.indexOf("\t");
  if (tab < 0) return null;
  const created = line.slice(0, tab).trim();
  if (!/^\d{4}-\d\d-\d\dT/.test(created)) return null;
  return { created, command: line.slice(tab + 1).trim() };
}

/** Creation time + command line of a pid through CIM; null when the process is gone. Synchronous: used at spawn. */
export function win32ProcessIdentity(pid: number): Win32ProcessInfo | null {
  const cmd = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Math.floor(pid)}"; if ($p) { "$($p.CreationDate.ToUniversalTime().ToString('o'))\`t$($p.CommandLine)" }`;
  const r = Bun.spawnSync([...POWERSHELL, cmd], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`powershell exited ${r.exitCode}: ${r.stderr.toString().trim()}`);
  return parseProcessLine(r.stdout.toString());
}
