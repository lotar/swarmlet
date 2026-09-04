// AssignmentRunner: executes what control assigns to this node. One entry per assignment id:
// worker (ggml-rpc-server slab), coordinator (llama-server holding the model, RPC client),
// replica (whole-model llama-server, or an external server we only health-check), stop.
// Every state change is reported to control and mirrored in state/assignments.json.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Assignment, AssignmentState, CoordinatorAssignment, Endpoint, ReplicaAssignment, WorkerAssignment } from "../protocol/types.ts";
import type { MuxStream } from "../protocol/frame.ts";
import type { Logger } from "../control/log.ts";
import type { ExternalService, NodeConfig } from "./config.ts";
import { enforce } from "./enforce/index.ts";
import { SupervisedProcess, waitForHealth, waitForPort } from "./roles/process.ts";
import { coordinatorArgv, replicaArgv, workerArgv } from "./roles/recipes.ts";
import { Dialer } from "./transport/dial.ts";

export interface RunnerDeps {
  cfg: () => NodeConfig;
  stateDir: string;
  certPem: string;
  keyPem: string;
  log: Logger;
  report: (id: string, state: AssignmentState, detail?: string, ports?: Record<string, number>) => void;
  logLine: (id: string, line: string) => void;
  openRelay: (targetNodeId: string, port: number) => MuxStream | null;
  /** darwin fit gate: free+reclaimable RAM now (MiB); undefined when unknown. */
  freeRamMiB: () => Promise<number | undefined>;
  onChange?: () => void;
}

interface Active {
  a: Assignment;
  state: AssignmentState;
  detail?: string;
  proc?: SupervisedProcess;
  dialer?: Dialer;
  ports: Record<string, number>;
  unwatch?: () => void;
  stoppedExternal?: ExternalService;
  healthTimer?: ReturnType<typeof setInterval>;
  stopping?: boolean;
}

export interface AssignmentSnapshot { id: string; kind: Assignment["kind"]; deploymentId: string; state: AssignmentState; detail?: string; ports?: Record<string, number>; pid?: number }

const LOAD_TIMEOUT_MS = 60 * 60 * 1000; // Flash-Next loads for minutes over a relay
const PORT_TIMEOUT_MS = 3 * 60 * 1000;
const STOP_EXTERNAL_WAIT_MS = 20 * 60 * 1000;

export class AssignmentRunner {
  private active = new Map<string, Active>();

  constructor(private readonly deps: RunnerDeps) {}

  /** Kill anything a previous agent instance left behind (recorded pids) and forget it. */
  async recover(): Promise<void> {
    const file = join(this.deps.stateDir, "assignments.json");
    if (!existsSync(file)) return;
    let prev: AssignmentSnapshot[] = [];
    try { prev = JSON.parse(readFileSync(file, "utf8")) as AssignmentSnapshot[]; } catch { prev = []; }
    for (const p of prev) {
      if (p.pid && p.kind !== "stop") {
        try { process.kill(p.pid, "SIGTERM"); this.deps.log.warn("killed leftover engine process from a previous agent run", { id: p.id, pid: p.pid }); } catch { /* gone */ }
      }
    }
    this.persist();
  }

  snapshot(): AssignmentSnapshot[] {
    return [...this.active.values()].map((x) => ({ id: x.a.id, kind: x.a.kind, deploymentId: x.a.deploymentId, state: x.state, detail: x.detail, ports: x.ports, pid: x.proc?.pid ?? undefined }));
  }

  states(): Array<{ id: string; state: AssignmentState; detail?: string; ports?: Record<string, number> }> {
    return [...this.active.values()].map((x) => ({ id: x.a.id, state: x.state, detail: x.detail, ports: Object.keys(x.ports).length ? x.ports : undefined }));
  }

  allowedPorts(): Set<number> {
    const s = new Set<number>();
    for (const x of this.active.values()) {
      if (x.a.kind === "worker") { s.add(x.a.port); if (x.a.peerPort) s.add(x.a.peerPort); }
      if (x.a.kind === "coordinator") s.add(x.a.port);
      if (x.a.kind === "replica") {
        if (x.a.external) { try { s.add(Number(new URL(x.a.external.url).port)); } catch { /* ignore */ } } else s.add(x.a.port);
      }
    }
    return s;
  }

  allowedFingerprints(): Set<string> {
    const s = new Set<string>();
    for (const x of this.active.values()) if (x.a.kind !== "stop") for (const fp of x.a.allow) s.add(fp);
    return s;
  }

  recentLog(id: string, n = 200): string[] { return this.active.get(id)?.proc?.recent(n) ?? []; }

  private lastTokens: { total: number; at: number } | null = null;

  /** tok/s over the last interval (delta of tokens_predicted_total), lifetime average and in-flight
   *  requests from the local llama-server /metrics: coordinator, replica, or an external server. */
  async serverMetrics(): Promise<{ tokPerSec?: number; tokPerSecAvg?: number; tokensTotal?: number; inflight?: number; serving?: string } | null> {
    // every ready llama-server on this node (coordinator, replica, external) contributes; rates are summed
    const servers = [...this.active.values()].filter((x) => (x.a.kind === "coordinator" || x.a.kind === "replica") && x.state === "ready");
    if (!servers.length) { this.lastTokens = null; return null; }
    let total = 0, inflight = 0, avg = 0, seen = 0;
    const serving: string[] = [];
    for (const srv of servers) {
      const a = srv.a as CoordinatorAssignment | ReplicaAssignment;
      const base = a.kind === "replica" && a.external ? a.external.url.replace(/\/$/, "") : `http://127.0.0.1:${a.port}`;
      try {
        const text = await (await fetch(`${base}/metrics`, { signal: AbortSignal.timeout(2000), headers: { connection: "close" } })).text();
        const num = (name: string) => { const m = text.match(new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)`, "m")); return m ? Number(m[1]) : undefined; };
        total += num("llamacpp:tokens_predicted_total") ?? 0;
        inflight += num("llamacpp:requests_processing") ?? 0;
        avg += num("llamacpp:predicted_tokens_seconds") ?? 0;
        seen++;
        if (a.modelName) serving.push(a.modelName);
      } catch { /* that server is not answering right now */ }
    }
    if (!seen) return null;
    const now = Date.now();
    let tokPerSec: number | undefined;
    if (this.lastTokens && now > this.lastTokens.at && total >= this.lastTokens.total) tokPerSec = (total - this.lastTokens.total) / ((now - this.lastTokens.at) / 1000);
    this.lastTokens = { total, at: now };
    return { tokPerSec: tokPerSec === undefined ? undefined : Math.round(tokPerSec * 10) / 10, tokPerSecAvg: Math.round(avg * 10) / 10, tokensTotal: total, inflight, serving: serving.join(", ") };
  }

  handle(a: Assignment): void {
    if (a.kind === "stop") { void this.stop(a.id, "stopped by control"); return; }
    if (this.active.has(a.id)) { this.deps.log.warn("duplicate assignment ignored", { id: a.id }); this.deps.report(a.id, this.active.get(a.id)!.state, "already running"); return; }
    const x: Active = { a, state: "starting", ports: {} };
    this.active.set(a.id, x);
    this.set(x, "starting");
    const run = a.kind === "worker" ? this.startWorker(x, a) : a.kind === "coordinator" ? this.startCoordinator(x, a) : this.startReplica(x, a);
    void run.catch((e: Error) => this.fail(x, e.message));
  }

  async stop(id: string, why: string): Promise<void> {
    const x = this.active.get(id);
    if (!x) { this.deps.report(id, "stopped", "not running"); return; }
    x.stopping = true;
    if (x.healthTimer) clearInterval(x.healthTimer);
    x.unwatch?.();
    await x.proc?.stop();
    x.dialer?.closeAll();
    await this.restoreExternal(x);
    this.active.delete(id);
    this.deps.report(id, "stopped", why);
    this.persist();
    this.deps.onChange?.();
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.active.keys()]) await this.stop(id, "agent shutting down");
  }

  // ---------- roles ----------

  private async startWorker(x: Active, a: WorkerAssignment): Promise<void> {
    const engine = this.deps.cfg().enginePath;
    const peerPorts: number[] = [];
    if (a.peers?.length) {
      x.dialer = this.newDialer();
      for (const p of a.peers) { const lp = await x.dialer.open(p.endpoint); peerPorts.push(lp.port); x.ports[`peer${p.index}`] = lp.port; }
    }
    const recipe = workerArgv(engine, a, peerPorts);
    await this.spawn(x, `worker-${a.id}`, recipe.argv, recipe.env, a.enforce);
    const up = await waitForPort(a.port, x.proc!, PORT_TIMEOUT_MS);
    if (!up) throw new Error(`rpc-server did not listen on ${a.port}: ${this.tail(x)}`);
    this.set(x, "listening", `${x.detail ?? ""}`.trim() || undefined);
  }

  private async startCoordinator(x: Active, a: CoordinatorAssignment): Promise<void> {
    const cfg = this.deps.cfg();
    await this.fitGate(x, a);
    x.dialer = this.newDialer();
    const rpcPorts: number[] = [];
    for (let i = 0; i < a.rpc.length; i++) { const lp = await x.dialer.open(a.rpc[i]!); rpcPorts.push(lp.port); x.ports[`rpc${i}`] = lp.port; }
    const recipe = coordinatorArgv(cfg.enginePath, a, rpcPorts);
    await this.spawn(x, `coordinator-${a.id}`, recipe.argv, recipe.env, a.enforce);
    this.set(x, "loading", x.detail);
    const ok = await waitForHealth(`http://127.0.0.1:${a.port}/health`, x.proc!, LOAD_TIMEOUT_MS);
    if (!ok) throw new Error(`llama-server not healthy: ${this.tail(x)}`);
    const paths = a.rpc.map((e, i) => `rpc${i}=${x.dialer!.currentPath(e)}`).join(" ");
    this.set(x, "ready", [x.detail, paths].filter(Boolean).join("; "));
  }

  private async startReplica(x: Active, a: ReplicaAssignment): Promise<void> {
    if (a.external) {
      const url = a.external.url.replace(/\/$/, "") + a.external.healthPath;
      const check = async () => {
        const ok = await waitForHealth(url, null, 2500);
        const next: AssignmentState = ok ? "ready" : "failed";
        if (x.state !== next) this.set(x, next, ok ? `external ${a.external!.url}` : `external ${a.external!.url} unhealthy`);
      };
      await check();
      x.healthTimer = setInterval(() => { void check(); }, 10_000);
      return;
    }
    const recipe = replicaArgv(this.deps.cfg().enginePath, a);
    await this.spawn(x, `replica-${a.id}`, recipe.argv, recipe.env);
    this.set(x, "loading");
    const ok = await waitForHealth(`http://127.0.0.1:${a.port}/health`, x.proc!, LOAD_TIMEOUT_MS);
    if (!ok) throw new Error(`llama-server not healthy: ${this.tail(x)}`);
    this.set(x, "ready", x.detail);
  }

  // ---------- helpers ----------

  private newDialer(): Dialer {
    return new Dialer({ certPem: this.deps.certPem, keyPem: this.deps.keyPem, openRelay: this.deps.openRelay, log: this.deps.log });
  }

  private async spawn(x: Active, unit: string, argv: string[], env: Record<string, string>, limits?: { ramMiB?: number; cpuCores?: number }): Promise<void> {
    const enf = await enforce(`swarmlet-${unit}`, argv, limits ?? {}, this.deps.log);
    x.detail = enf.summary;
    const proc = new SupervisedProcess(unit, this.deps.log, {
      onLine: (line) => this.deps.logLine(x.a.id, line),
      onExit: (code, signal) => {
        x.unwatch?.();
        if (!x.stopping && x.state !== "failed") this.fail(x, `engine exited (code ${code}${signal ? ", " + signal : ""}): ${this.tail(x)}`);
      },
    });
    x.proc = proc;
    proc.start({ argv: enf.argv, env });
    if (enf.watch && proc.pid) x.unwatch = enf.watch(proc.pid, (reason) => { this.deps.log.warn("watchdog kill", { id: x.a.id, reason }); x.detail = reason; void proc.stop(5000); });
    this.persist();
  }

  private async fitGate(x: Active, a: CoordinatorAssignment): Promise<void> {
    if (!a.fitMiB) return;
    let free = await this.deps.freeRamMiB();
    if (free === undefined) { this.deps.log.warn("fit gate: free RAM unknown, proceeding"); return; }
    if (free >= a.fitMiB) { x.detail = `fit ok: ${Math.round(free)} MiB free >= ${a.fitMiB}`; return; }
    if (!a.stopExternal) throw new Error(`does not fit: ${Math.round(free)} MiB free, need ${a.fitMiB}; no external service to stop`);
    const ext = this.deps.cfg().externals.find((e) => e.id === a.stopExternal);
    if (!ext) throw new Error(`does not fit and external service '${a.stopExternal}' is not registered on this node`);
    // The maintenance script refuses while clients are connected (exit 65). Like the operators, keep
    // asking every 20 s for up to STOP_EXTERNAL_WAIT_MS instead of failing on the first refusal.
    const stopDeadline = Date.now() + STOP_EXTERNAL_WAIT_MS;
    for (;;) {
      this.set(x, "starting", `stopping external ${ext.id} via maintenance script`);
      const out = await this.maintenance(ext, "stop");
      if (out.code === 0) break;
      const why = out.text.trim().split("\n").slice(-2).join(" | ");
      if (out.code !== 65 || Date.now() > stopDeadline) throw new Error(`maintenance stop refused (${out.code}): ${why}`);
      this.set(x, "starting", `waiting for ${ext.id} clients to disconnect (${why}); retry in 20 s until ${new Date(stopDeadline).toISOString().slice(11, 19)}Z`);
      await Bun.sleep(20_000);
      if (x.stopping) throw new Error("stopped while waiting for the external service");
    }
    x.stoppedExternal = ext;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      free = await this.deps.freeRamMiB();
      if (free !== undefined && free >= a.fitMiB) { x.detail = `fit ok after stopping ${ext.id}: ${Math.round(free)} MiB free`; return; }
      await Bun.sleep(5000);
    }
    throw new Error(`does not fit even after stopping ${ext.id}: ${Math.round(free ?? 0)} MiB free, need ${a.fitMiB}`);
  }

  private async restoreExternal(x: Active): Promise<void> {
    const ext = x.stoppedExternal;
    if (!ext) return;
    x.stoppedExternal = undefined;
    this.deps.log.info("restoring external service", { id: ext.id });
    const out = await this.maintenance(ext, "start");
    if (out.code !== 0) this.deps.log.error("external restore FAILED", { id: ext.id, out: out.text.slice(-400) });
    else this.deps.log.info("external service restored", { id: ext.id });
  }

  private async maintenance(ext: ExternalService, verb: "stop" | "start" | "check-only"): Promise<{ code: number; text: string }> {
    const p = Bun.spawn(["/bin/bash", ext.maintenance, verb], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    return { code, text: out + err };
  }

  private tail(x: Active): string { return (x.proc?.recent(6) ?? []).join(" | ").slice(-600); }

  private set(x: Active, state: AssignmentState, detail?: string): void {
    x.state = state;
    if (detail !== undefined) x.detail = detail;
    this.deps.report(x.a.id, state, x.detail, Object.keys(x.ports).length ? x.ports : undefined);
    this.persist();
    this.deps.onChange?.();
  }

  private fail(x: Active, why: string): void {
    this.deps.log.error("assignment failed", { id: x.a.id, why });
    x.state = "failed"; x.detail = why;
    this.deps.report(x.a.id, "failed", why, Object.keys(x.ports).length ? x.ports : undefined);
    x.unwatch?.();
    if (x.healthTimer) clearInterval(x.healthTimer);
    void (async () => { await x.proc?.stop(10_000); x.dialer?.closeAll(); await this.restoreExternal(x); this.persist(); this.deps.onChange?.(); })();
  }

  private persist(): void {
    try { writeFileSync(join(this.deps.stateDir, "assignments.json"), JSON.stringify(this.snapshot(), null, 2), { mode: 0o600 }); } catch (e) { this.deps.log.warn("persist failed", { err: (e as Error).message }); }
  }
}

export type { Endpoint };
