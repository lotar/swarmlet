// One supervised engine process: spawn (optionally wrapped by the OS enforcer), collect log lines,
// wait for readiness, stop with SIGTERM then SIGKILL. No automatic restart: an unexpected exit is
// reported and control decides (restart-on-crash belongs to the deployment state machine).

import { connect as netConnect } from "node:net";
import type { Logger } from "../../control/log.ts";
import { processIdentity, type ProcessIdentity } from "./identity.ts";

export interface SpawnSpec {
  argv: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface ProcessEvents {
  onLine?: (line: string) => void;
  onExit?: (code: number | null, signal: string | null) => void;
}

const MAX_LINES = 400;

export class SupervisedProcess {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private lines: string[] = [];
  private exited = false;
  private stopping = false;
  private exitInfo: { code: number | null; signal: string | null } | null = null;
  private spawnIdentity: ProcessIdentity | undefined;

  constructor(readonly name: string, private readonly log: Logger, private readonly events: ProcessEvents = {}) {}

  get pid(): number | null { return this.proc?.pid ?? null; }
  get identity(): ProcessIdentity | undefined { return this.spawnIdentity; }
  get running(): boolean { return this.proc !== null && !this.exited; }
  get exit(): { code: number | null; signal: string | null } | null { return this.exitInfo; }
  recent(n = 40): string[] { return this.lines.slice(-n); }

  start(spec: SpawnSpec): void {
    if (this.proc) throw new Error(`${this.name}: already started`);
    this.log.info(`${this.name}: spawn`, { argv: spec.argv.join(" ") });
    const proc = Bun.spawn(spec.argv, {
      env: { ...process.env, ...(spec.env ?? {}) },
      cwd: spec.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.proc = proc;
    void this.pump(proc.stdout);
    void this.pump(proc.stderr);
    void proc.exited.then((code) => {
      this.exited = true;
      this.exitInfo = { code, signal: proc.signalCode ?? null };
      this.log.info(`${this.name}: exited`, { code, signal: proc.signalCode, stopping: this.stopping });
      this.events.onExit?.(code, proc.signalCode ?? null);
    });
    try { this.spawnIdentity = processIdentity(proc.pid) ?? undefined; }
    catch (e) { proc.kill("SIGTERM"); throw e; }
  }

  private async pump(stream: ReadableStream<Uint8Array> | number | null | undefined): Promise<void> {
    if (!stream || typeof stream === "number") return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let rest = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        rest += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = rest.indexOf("\n")) >= 0) {
          const line = rest.slice(0, nl).replace(/\r$/, "");
          rest = rest.slice(nl + 1);
          this.push(line);
        }
      }
      if (rest) this.push(rest);
    } catch { /* stream closed */ }
  }

  private push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    this.events.onLine?.(line);
  }

  /** SIGTERM, then SIGKILL after `graceMs`. Resolves when the process is gone. */
  async stop(graceMs = 90_000): Promise<void> {
    const proc = this.proc;
    if (!proc || this.exited) return;
    this.stopping = true;
    proc.kill("SIGTERM");
    const deadline = Date.now() + graceMs;
    while (!this.exited && Date.now() < deadline) await Bun.sleep(250);
    if (!this.exited) { this.log.warn(`${this.name}: SIGKILL after ${graceMs} ms`); proc.kill("SIGKILL"); await proc.exited; }
  }
}

/** Wait until something accepts TCP connections on 127.0.0.1:port, or the process dies, or timeout. */
export async function waitForPort(port: number, proc: SupervisedProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!proc.running) return false;
    const ok = await new Promise<boolean>((resolve) => {
      const s = netConnect({ host: "127.0.0.1", port });
      s.once("connect", () => { s.destroy(); resolve(true); });
      s.once("error", () => resolve(false));
    });
    if (ok) return true;
    await Bun.sleep(500);
  }
  return false;
}

/** Wait for an HTTP 200 from url, or the process dies, or timeout. */
export async function waitForHealth(url: string, proc: SupervisedProcess | null, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc && !proc.running) return false;
    try {
      // Connection: close so our own health probes never hold a keep-alive socket open on a service
      // whose maintenance script refuses to stop while clients are connected.
      const r = await fetch(url, { signal: AbortSignal.timeout(3000), headers: { connection: "close" } });
      if (r.ok) return true;
    } catch { /* not yet */ }
    await Bun.sleep(1000);
  }
  return false;
}
