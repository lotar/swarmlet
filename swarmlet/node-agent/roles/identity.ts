// Numeric PIDs can be reused. Persist start time + command at spawn, and compare
// again before every signal while recovering a prior agent's engine process.
import { readFileSync } from "node:fs";
export interface ProcessIdentity { started: string; command: string; birthId?: string }

export function processIdentity(pid: number): ProcessIdentity | null {
  if (process.platform === "linux") {
    try {
      const startTick = () => { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); return fields[0] === "Z" ? null : fields[19]!; };
      const tick = startTick();
      if (tick === null) return null; // exited children have no running process to signal
      const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const after = startTick();
      if (after === null) return null;
      if (tick !== after) throw new Error(`process ${pid} changed during identity read`);
      const birthId = `${boot}:${tick}`;
      return { started: birthId, birthId, command };
    } catch (e) {
      if (["ENOENT", "ESRCH"].includes((e as NodeJS.ErrnoException).code ?? "")) return null;
      throw e;
    }
  }
  const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "stat=", "-o", "lstart=", "-o", "command="], { stdout: "pipe", stderr: "ignore" });
  if (result.exitCode !== 0) return null;
  const match = result.stdout.toString().match(/^\s*(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/m);
  if (!match) throw new Error(`cannot identify process ${pid}`);
  if (match[1]!.startsWith("Z")) return null;
  return { started: match[2]!.replace(/\s+/g, " "), command: match[3]!.trim() };
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
  const state = (): "gone" | "owned" | "ambiguous" => {
    const found = io.identify(pid);
    if (!found) return "gone";
    if (expected.birthId && found.birthId) return expected.birthId === found.birthId ? "owned" : "gone";
    if (found.started !== expected.started) return "gone";
    return found.command === expected.command ? "owned" : "ambiguous";
  };
  const ambiguous = () => new Error(`process ${pid} has the same start time but changed command; ownership is ambiguous`);
  const matches = () => {
    const observed = state();
    if (observed === "ambiguous") throw ambiguous();
    return observed === "owned";
  };
  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    const deadline = io.now() + timeoutMs;
    let sawAmbiguity = false;
    for (;;) {
      const observed = state();
      if (observed === "gone") return true;
      // macOS may briefly report '(bun)' while an already-signalled process exits.
      // Observe without signalling; an ambiguous interval cannot authorize another kill,
      // even if the same coarse start time and command subsequently reappear.
      if (observed === "ambiguous") sawAmbiguity = true;
      if (io.now() >= deadline) {
        if (sawAmbiguity) throw ambiguous();
        return false;
      }
      await io.sleep(100);
    }
  };
  if (!matches()) return; // original process is gone; never signal its PID's new owner
  try { io.signal(pid, "SIGTERM"); } catch (e) { if (matches()) throw e; }
  if (await waitForExit(10_000)) return;
  if (!matches()) return;
  try { io.signal(pid, "SIGKILL"); } catch (e) { if (matches()) throw e; }
  if (!await waitForExit(5000)) throw new Error(`owned engine ${pid} did not exit; refusing to advertise cleared assignments`);
}
