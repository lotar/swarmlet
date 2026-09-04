// Host facts that read the same on both OSes: disk free, private IPv4s, ps-derived cpu and rss.

import { statfs } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { CODE_NOT_FOUND, exec } from "./exec.ts";

const MiB = 1024 * 1024;

/** Clamp to 0..100 with one decimal. */
export const clampPct = (n: number): number => Math.max(0, Math.min(100, Math.round(n * 10) / 10));

export interface DfEntry {
  filesystem: string;
  totalMiB: number;
  usedMiB: number;
  availableMiB: number;
  mount: string;
}

/** Last data row of `df -k` / `df -kP` output (1024-byte blocks); handles macOS' extra inode columns. */
export function parseDfK(text: string): DfEntry | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines.length > 1 ? lines[lines.length - 1] : undefined;
  if (!last) return null;
  const cols = last.split(/\s+/);
  const filesystem = cols[0];
  if (!filesystem || cols.length < 6) return null;
  const blocksK = Number(cols[1]);
  const usedK = Number(cols[2]);
  const availK = Number(cols[3]);
  if (![blocksK, usedK, availK].every(Number.isFinite)) return null;
  // -P prints 6 columns (mount at 5); plain macOS df adds iused/ifree/%iused (mount at 8)
  const mountAt = (cols[5] ?? "").startsWith("/") ? 5 : 8;
  return {
    filesystem,
    totalMiB: Math.floor(blocksK / 1024),
    usedMiB: Math.floor(usedK / 1024),
    availableMiB: Math.floor(availK / 1024),
    mount: cols.slice(mountAt).join(" "),
  };
}

/** Free space (MiB) of the filesystem holding `path`: statfs, else `df -kP`. */
export async function diskFreeMiB(path: string): Promise<number> {
  try {
    const s = await statfs(path);
    return Math.floor((Number(s.bavail) * Number(s.bsize)) / MiB);
  } catch {
    const r = await exec(["df", "-kP", path], { timeoutMs: 10_000 });
    if (r.code !== 0) throw new Error(`df exited ${r.code}: ${r.stderr.trim()}`);
    const d = parseDfK(r.stdout);
    if (!d) throw new Error("df: unrecognized output");
    return d.availableMiB;
  }
}

export interface IfaceAddress { address: string; family: string; internal: boolean }

const isRfc1918 = (ip: string) => /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
const isLinkLocal = (ip: string) => /^169\.254\./.test(ip);

/** Non-loopback IPv4 addresses, LAN (RFC 1918) ranges first; link-local (169.254/16) is never dialable and is dropped. */
export function privateIps(ifaces: Record<string, IfaceAddress[] | undefined> = networkInterfaces()): string[] {
  const ips = new Set<string>();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.internal || a.family !== "IPv4" || isLinkLocal(a.address)) continue;
      ips.add(a.address);
    }
  }
  return [...ips].sort((x, y) => Number(isRfc1918(y)) - Number(isRfc1918(x)));
}

/** Sum of the numeric lines of a single-column `ps -o <col>=` listing. */
export function sumNumericLines(text: string): number {
  let sum = 0;
  for (const line of text.split(/\r?\n/)) {
    const n = Number(line.trim());
    if (line.trim() && Number.isFinite(n)) sum += n;
  }
  return sum;
}

/** `ps -A -o %cpu=` -> total percent across all processes (divide by cores for a machine figure). */
export const parsePsCpu = sumNumericLines;
/** `ps -o rss= -p ...` -> total resident KiB. */
export const parsePsRss = sumNumericLines;

/** Resident memory of the given pids (MiB). Gone pids count as 0; undefined when there is nothing to measure. */
export async function rssMiB(pids: number[]): Promise<number | undefined> {
  // pids above 2^22 cannot exist (linux pid_max ceiling; macOS stops at 99998) and make ps reject the whole batch
  const list = pids.filter((p) => Number.isInteger(p) && p > 0 && p <= 4_194_304);
  if (list.length === 0) return undefined;
  const r = await exec(["ps", "-o", "rss=", "-p", list.join(",")], { timeoutMs: 5_000 });
  if (r.code === CODE_NOT_FOUND) throw new Error("ps not found");
  // ps exits 1 when one of the pids is gone but still prints the others
  return Math.floor(parsePsRss(r.stdout) / 1024);
}
