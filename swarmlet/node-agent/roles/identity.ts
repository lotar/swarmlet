// Numeric PIDs can be reused. Persist start time + command at spawn, and compare
// again before every signal while recovering a prior agent's engine process.
import { readFileSync } from "node:fs";
export interface ProcessIdentity { started: string; command: string; birthId?: string }

export function processIdentity(pid: number): ProcessIdentity | null {
  if (process.platform === "linux") {
    try {
      const startTick = () => { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!; };
      const tick = startTick();
      const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (tick !== startTick()) throw new Error(`process ${pid} changed during identity read`);
      const birthId = `${boot}:${tick}`;
      return { started: birthId, birthId, command };
    } catch (e) {
      if (["ENOENT", "ESRCH"].includes((e as NodeJS.ErrnoException).code ?? "")) return null;
      throw e;
    }
  }
  const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart=", "-o", "command="], { stdout: "pipe", stderr: "ignore" });
  if (result.exitCode !== 0) return null;
  const match = result.stdout.toString().match(/^\s*(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/m);
  if (!match) throw new Error(`cannot identify process ${pid}`);
  return { started: match[1]!.replace(/\s+/g, " "), command: match[2]!.trim() };
}

interface RecoveryIO {
  identify: (pid: number) => ProcessIdentity | null;
  signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  sleep: (ms: number) => Promise<unknown>;
  now: () => number;
}
const systemIO: RecoveryIO = { identify: processIdentity, signal: (pid, signal) => { process.kill(pid, signal); }, sleep: Bun.sleep, now: Date.now };

export async function stopRecordedProcess(pid: number, expected?: ProcessIdentity, io: RecoveryIO = systemIO): Promise<void> {
  const current = io.identify(pid);
  if (!current) return;
  if (!expected) throw new Error(`legacy process ${pid} is still alive without recorded identity; stop the old agent cleanly before upgrading`);
  const matches = () => {
    const found = io.identify(pid);
    if (!found) return false;
    if (expected.birthId && found.birthId) return expected.birthId === found.birthId;
    if (found.started !== expected.started) return false;
    if (found.command !== expected.command) throw new Error(`process ${pid} has the same start time but changed command; ownership is ambiguous`);
    return true;
  };
  if (!matches()) return; // original process is gone; never signal its PID's new owner
  try { io.signal(pid, "SIGTERM"); } catch (e) { if (matches()) throw e; }
  const deadline = io.now() + 10_000;
  while (matches() && io.now() < deadline) await io.sleep(100);
  if (!matches()) return;
  try { io.signal(pid, "SIGKILL"); } catch (e) { if (matches()) throw e; }
  const killDeadline = io.now() + 5000;
  while (matches() && io.now() < killDeadline) await io.sleep(100);
  if (matches()) throw new Error(`owned engine ${pid} did not exit; refusing to advertise cleared assignments`);
}
