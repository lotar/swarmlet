// OS resource enforcement for engine processes.
//   linux : systemd-run --user --scope with MemoryMax / MemorySwapMax=0 / CPUQuota (cgroup v2, hard).
//           The user slice on Ubuntu 24.04 delegates cpu, memory and pids (not cpuset: no pinning).
//   darwin, win32: no cgroups. Thread count is passed to the engine; RAM is a soft cap enforced by an
//           RSS watchdog (ps on darwin, tasklist on Windows) that kills the process when it exceeds
//           the configured cap (no allowance that can consume the OS reserve).
// All return the argv to spawn plus a `watch` hook the runner calls with the pid.

import type { Logger } from "../../control/log.ts";
import { rssMiB } from "../probe/host.ts";

export interface Limits { ramMiB?: number; cpuCores?: number }

export interface Enforcement {
  argv: string[];
  /** Human summary for the assignment detail ("cgroup MemoryMax=8G CPUQuota=600%" / "soft rss cap 8 GiB"). */
  summary: string;
  /** Optional watchdog: returns a stop function. */
  watch?: (pid: number, kill: (reason: string) => void) => () => void;
}

async function haveSystemdRun(): Promise<boolean> {
  try {
    const p = Bun.spawn(["systemd-run", "--version"], { stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0;
  } catch { return false; }
}

export async function enforce(unit: string, argv: string[], limits: Limits, log: Logger): Promise<Enforcement> {
  if (process.platform === "linux") {
    if (!(await haveSystemdRun())) throw new Error("systemd-run is required for Linux resource enforcement; install systemd before starting managed assignments");
    const props: string[] = [];
    if (limits.ramMiB && limits.ramMiB > 0) { props.push("-p", `MemoryMax=${limits.ramMiB}M`, "-p", "MemorySwapMax=0"); }
    if (limits.cpuCores && limits.cpuCores > 0) { props.push("-p", `CPUQuota=${Math.round(limits.cpuCores * 100)}%`); }
    const wrapped = ["systemd-run", "--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, ...props, "--", ...argv];
    const summary = props.length ? `cgroup ${props.filter((p) => p !== "-p").join(" ")}` : "cgroup scope (no limits requested)";
    return { argv: wrapped, summary };
  }
  // darwin, win32: soft cap
  const cap = limits.ramMiB && limits.ramMiB > 0 ? limits.ramMiB : 0;
  const summary = cap ? `soft rss cap ${(cap / 1024).toFixed(1)} GiB (watchdog)` : "no ram cap";
  const watch = cap
    ? (pid: number, kill: (reason: string) => void) => {
        const timer = setInterval(async () => {
          try {
            const rss = await rssMiB([pid]);
            if (rss !== undefined && rss > cap) kill(`rss ${rss.toFixed(0)} MiB exceeds cap ${cap} MiB`);
          } catch { /* process gone or tool unavailable */ }
        }, 5000);
        return () => clearInterval(timer);
      }
    : undefined;
  return { argv, summary, watch };
}
