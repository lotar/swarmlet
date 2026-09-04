// OS resource enforcement for engine processes.
//   linux : systemd-run --user --scope with MemoryMax / MemorySwapMax=0 / CPUQuota (cgroup v2, hard).
//           The user slice on Ubuntu 24.04 delegates cpu, memory and pids (not cpuset: no pinning).
//   darwin: no cgroups. Thread count is passed to the engine; RAM is a soft cap enforced by an RSS
//           watchdog that kills the process when it exceeds the cap by more than 10 %.
// Both return the argv to spawn plus a `watch` hook the runner calls with the pid.

import type { Logger } from "../../control/log.ts";

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
    if (!(await haveSystemdRun())) { log.warn("systemd-run not available: no cgroup enforcement"); return { argv, summary: "enforcement: none (systemd-run missing)" }; }
    const props: string[] = [];
    if (limits.ramMiB && limits.ramMiB > 0) { props.push("-p", `MemoryMax=${limits.ramMiB}M`, "-p", "MemorySwapMax=0"); }
    if (limits.cpuCores && limits.cpuCores > 0) { props.push("-p", `CPUQuota=${Math.round(limits.cpuCores * 100)}%`); }
    const wrapped = ["systemd-run", "--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, ...props, "--", ...argv];
    const summary = props.length ? `cgroup ${props.filter((p) => p !== "-p").join(" ")}` : "cgroup scope (no limits requested)";
    return { argv: wrapped, summary };
  }
  // darwin
  const cap = limits.ramMiB && limits.ramMiB > 0 ? limits.ramMiB : 0;
  const summary = cap ? `soft rss cap ${(cap / 1024).toFixed(1)} GiB (watchdog)` : "no ram cap";
  const watch = cap
    ? (pid: number, kill: (reason: string) => void) => {
        const timer = setInterval(async () => {
          try {
            const p = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
            const out = (await new Response(p.stdout).text()).trim();
            await p.exited;
            const rssMiB = Number(out) / 1024;
            if (Number.isFinite(rssMiB) && rssMiB > cap * 1.1) kill(`rss ${rssMiB.toFixed(0)} MiB exceeds cap ${cap} MiB by >10%`);
          } catch { /* process gone */ }
        }, 5000);
        return () => clearInterval(timer);
      }
    : undefined;
  return { argv, summary, watch };
}
