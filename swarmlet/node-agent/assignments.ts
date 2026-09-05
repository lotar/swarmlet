// AssignmentRunner: executes what control assigns to this node. One entry per assignment id:
// worker (ggml-rpc-server slab), coordinator (llama-server holding the model, RPC client),
// replica (whole-model llama-server, or an external server we only health-check), stop.
// Every state change is reported to control and mirrored in state/assignments.json.

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Assignment, AssignmentState, CoordinatorAssignment, Endpoint, NodeMetrics, ReplicaAssignment, WorkerAssignment } from "../protocol/types.ts";
import type { MuxStream } from "../protocol/frame.ts";
import type { Logger } from "../control/log.ts";
import type { ExternalService, NodeConfig } from "./config.ts";
import { enforce } from "./enforce/index.ts";
import { SupervisedProcess, waitForHealth, waitForPort } from "./roles/process.ts";
import { coordinatorArgv, replicaArgv, workerArgv } from "./roles/recipes.ts";
import { Dialer } from "./transport/dial.ts";
import { stopRecordedProcess, type ProcessIdentity } from "./roles/identity.ts";

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
  startTask?: Promise<void>;
  cleanupTask?: Promise<void>;
  stopTask?: Promise<void>;
}

export interface AssignmentSnapshot { id: string; kind: Assignment["kind"]; deploymentId: string; state: AssignmentState; detail?: string; ports?: Record<string, number>; pid?: number; processIdentity?: ProcessIdentity; stoppedExternalId?: string }

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
    const prev = JSON.parse(readFileSync(file, "utf8")) as AssignmentSnapshot[];
    if (!Array.isArray(prev) || prev.some((p) => !p || typeof p.id !== "string" || typeof p.deploymentId !== "string"
        || !["worker", "coordinator", "replica", "stop"].includes(p.kind)
        || (p.pid !== undefined && (!Number.isInteger(p.pid) || p.pid <= 0))
        || (p.processIdentity !== undefined && (typeof p.processIdentity.started !== "string" || typeof p.processIdentity.command !== "string"))
        || (p.stoppedExternalId !== undefined && typeof p.stoppedExternalId !== "string"))) {
      throw new Error("invalid assignment ownership snapshot; refusing to discard recovery state");
    }
    for (const p of prev) {
      if (p.pid && p.kind !== "stop") {
        await stopRecordedProcess(p.pid, p.processIdentity);
        this.deps.log.info("previous engine process retired", { id: p.id, pid: p.pid });
      }
      if (p.stoppedExternalId) {
        const ext = this.deps.cfg().externals.find((e) => e.id === p.stoppedExternalId);
        if (!ext) throw new Error(`cannot restore unregistered external ${p.stoppedExternalId}`);
        const out = await this.maintenance(ext, "start");
        if (out.code !== 0) throw new Error(`external crash recovery failed: ${ext.id}`);
      }
    }
    this.persist();
  }

  snapshot(): AssignmentSnapshot[] {
    return [...this.active.values()].map((x) => ({ id: x.a.id, kind: x.a.kind, deploymentId: x.a.deploymentId, state: x.state, detail: x.detail, ports: x.ports, pid: x.proc?.pid ?? undefined, processIdentity: x.proc?.identity, stoppedExternalId: x.stoppedExternal?.id }));
  }

  /** Only ready HTTP model servers can answer inference; RPC workers cannot decode alone. */
  inferenceTargets(): Array<{ model: string; deploymentId: string; url: string }> {
    return [...this.active.values()].flatMap(({ a, state }) => {
      if (state !== "ready" || (a.kind !== "coordinator" && a.kind !== "replica") || !a.modelName) return [];
      return [{ model: a.modelName, deploymentId: a.deploymentId, url: a.kind === "replica" && a.external ? a.external.url : `http://127.0.0.1:${a.port}` }];
    });
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

  private tokenSamples = new Map<string, { total: number; at: number }>();
  private pendingMetrics: Promise<Partial<NodeMetrics> | null> | null = null;

  /** Completion-counter deltas are interval rates, not instantaneous decode speed. In particular,
   *  a busy server can leave its counter unchanged until the current request completes. */
  serverMetrics(): Promise<Partial<NodeMetrics> | null> {
    // A slow scrape may outlast a heartbeat; don't race two samples against the same baselines.
    if (!this.pendingMetrics) this.pendingMetrics = this.collectServerMetrics().finally(() => { this.pendingMetrics = null; });
    return this.pendingMetrics;
  }

  private async collectServerMetrics(): Promise<Partial<NodeMetrics> | null> {
    const servers = new Map<string, Set<string>>();
    for (const x of this.active.values()) {
      if ((x.a.kind !== "coordinator" && x.a.kind !== "replica") || x.state !== "ready") continue;
      const a = x.a;
      const url = new URL(a.kind === "replica" && a.external ? a.external.url : `http://127.0.0.1:${a.port}`);
      // Loopback aliases and a trailing slash describe the same local server.
      url.search = ""; url.hash = "";
      const base = url.href.replace(/\/+$/, "");
      if (!servers.has(base)) servers.set(base, new Set());
      if (a.modelName) servers.get(base)!.add(a.modelName);
    }
    for (const base of this.tokenSamples.keys()) if (!servers.has(base)) this.tokenSamples.delete(base);
    if (!servers.size) return null;
    let total = 0, inflight = 0, avg = 0, rate = 0, seen = 0;
    let totalsKnown = true, inflightKnown = true, averagesKnown = true, ratesKnown = true;
    for (const base of servers.keys()) {
      try {
        const response = await fetch(`${base}/metrics`, { signal: AbortSignal.timeout(2000), headers: { connection: "close" } });
        if (!response.ok) throw new Error(`metrics HTTP ${response.status}`);
        const text = await response.text();
        const num = (name: string) => {
          const m = text.match(new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)`, "m"));
          const n = m ? Number(m[1]) : undefined;
          return n !== undefined && Number.isFinite(n) && n >= 0 ? n : undefined;
        };
        const tokens = num("llamacpp:tokens_predicted_total");
        const processing = num("llamacpp:requests_processing");
        const average = num("llamacpp:predicted_tokens_seconds");
        if (tokens === undefined && processing === undefined && average === undefined) throw new Error("no engine metrics");
        const now = Date.now(), previous = this.tokenSamples.get(base);
        if (tokens !== undefined) {
          total += tokens;
          if (previous && now > previous.at && tokens >= previous.total) rate += (tokens - previous.total) / ((now - previous.at) / 1000);
          else ratesKnown = false; // New/restarted endpoint: establish a baseline, never count its history as new tokens.
          this.tokenSamples.set(base, { total: tokens, at: now });
        } else { totalsKnown = false; ratesKnown = false; this.tokenSamples.delete(base); }
        if (processing !== undefined) inflight += processing; else inflightKnown = false;
        if (average !== undefined) avg += average; else averagesKnown = false;
        seen++;
      } catch {
        this.tokenSamples.delete(base); // A failed sample must not become a delayed rate spike on recovery.
        totalsKnown = inflightKnown = averagesKnown = ratesKnown = false;
      }
    }
    const round = (n: number) => Math.round(n * 10) / 10;
    return {
      tokPerSec: ratesKnown ? round(rate) : undefined,
      tokPerSecAvg: averagesKnown ? round(avg) : undefined,
      tokensTotal: totalsKnown ? total : undefined,
      inflight: inflightKnown ? inflight : undefined,
      serving: [...new Set([...servers.values()].flatMap((names) => [...names]))].join(", "),
      serverMetricsTs: new Date().toISOString(),
      serverMetricsState: !seen ? "unavailable" : seen < servers.size ? "partial" : "ok",
    };
  }

  handle(a: Assignment): void {
    if (a.kind === "stop") {
      void this.stop(a.id, "stopped by control").catch((e: Error) => {
        this.deps.log.error("stop failed", { id: a.id, err: e.message });
        this.deps.report(a.id, "failed", `cleanup incomplete: ${e.message}`);
      });
      return;
    }
    if (this.active.has(a.id)) { this.deps.log.warn("duplicate assignment ignored", { id: a.id }); this.deps.report(a.id, this.active.get(a.id)!.state, "already running"); return; }
    const x: Active = { a, state: "starting", ports: {} };
    this.active.set(a.id, x);
    this.set(x, "starting");
    x.startTask = Promise.resolve().then(() => {
      this.assertStarting(x);
      return a.kind === "worker" ? this.startWorker(x, a) : a.kind === "coordinator" ? this.startCoordinator(x, a) : this.startReplica(x, a);
    }).catch((e: Error) => { if (!x.stopping) this.fail(x, e.message); });
  }

  async stop(id: string, why: string): Promise<void> {
    const x = this.active.get(id);
    if (!x) { this.deps.report(id, "stopped", "not running"); return; }
    if (x.stopTask) return x.stopTask;
    x.stopTask = (async () => {
      await this.cleanup(x);
      if (this.active.get(id) === x) this.active.delete(id);
      this.deps.report(id, "stopped", why);
      this.persist();
      this.deps.onChange?.();
    })();
    try { await x.stopTask; } catch (e) { x.stopTask = undefined; throw e; }
  }

  private cleanup(x: Active): Promise<void> {
    if (x.cleanupTask) return x.cleanupTask;
    x.stopping = true;
    x.cleanupTask = (async () => {
      if (x.healthTimer) clearInterval(x.healthTimer);
      x.unwatch?.();
      x.dialer?.closeAll();
      await x.proc?.stop();
      // No stopped acknowledgement until all asynchronous startup work settles.
      // Every spawn/dial/timer continuation checks stopping before creating work.
      await x.startTask;
      x.dialer?.closeAll();
      if (x.healthTimer) clearInterval(x.healthTimer);
      await this.restoreExternal(x);
    })();
    void x.cleanupTask.catch(() => { x.cleanupTask = undefined; });
    return x.cleanupTask;
  }

  private assertStarting(x: Active): void {
    if (x.stopping || this.active.get(x.a.id) !== x) throw new Error("assignment cancelled");
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
      for (const p of a.peers) { this.assertStarting(x); const lp = await x.dialer.open(p.endpoint); this.assertStarting(x); peerPorts.push(lp.port); x.ports[`peer${p.index}`] = lp.port; }
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
    this.assertStarting(x);
    x.dialer = this.newDialer();
    const rpcPorts: number[] = [];
    for (let i = 0; i < a.rpc.length; i++) { this.assertStarting(x); const lp = await x.dialer.open(a.rpc[i]!); this.assertStarting(x); rpcPorts.push(lp.port); x.ports[`rpc${i}`] = lp.port; }
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
      this.assertStarting(x);
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
    this.assertStarting(x);
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
    this.assertStarting(x);
    if (free === undefined) { this.deps.log.warn("fit gate: free RAM unknown, proceeding"); return; }
    if (free >= a.fitMiB) { x.detail = `fit ok: ${Math.round(free)} MiB free >= ${a.fitMiB}`; return; }
    if (!a.stopExternal) throw new Error(`does not fit: ${Math.round(free)} MiB free, need ${a.fitMiB}; no external service to stop`);
    const ext = this.deps.cfg().externals.find((e) => e.id === a.stopExternal);
    if (!ext) throw new Error(`does not fit and external service '${a.stopExternal}' is not registered on this node`);
    // The maintenance script refuses while clients are connected (exit 65). Like the operators, keep
    // asking every 20 s for up to STOP_EXTERNAL_WAIT_MS instead of failing on the first refusal.
    const stopDeadline = Date.now() + STOP_EXTERNAL_WAIT_MS;
    for (;;) {
      this.assertStarting(x);
      this.set(x, "starting", `stopping external ${ext.id} via maintenance script`);
      x.stoppedExternal = ext; // stop may mutate production and then fail or be interrupted
      this.persist();
      const out = await this.maintenance(ext, "stop");
      if (out.code === 0) { this.assertStarting(x); break; }
      if (out.code === 65) { x.stoppedExternal = undefined; this.persist(); }
      const why = out.text.trim().split("\n").slice(-2).join(" | ");
      if (out.code !== 65 || Date.now() > stopDeadline) throw new Error(`maintenance stop refused (${out.code}): ${why}`);
      this.set(x, "starting", `waiting for ${ext.id} clients to disconnect (${why}); retry in 20 s until ${new Date(stopDeadline).toISOString().slice(11, 19)}Z`);
      await Bun.sleep(20_000);
      if (x.stopping) throw new Error("stopped while waiting for the external service");
    }
    x.stoppedExternal = ext;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      this.assertStarting(x);
      free = await this.deps.freeRamMiB();
      this.assertStarting(x);
      if (free !== undefined && free >= a.fitMiB) { x.detail = `fit ok after stopping ${ext.id}: ${Math.round(free)} MiB free`; return; }
      await Bun.sleep(5000);
    }
    throw new Error(`does not fit even after stopping ${ext.id}: ${Math.round(free ?? 0)} MiB free, need ${a.fitMiB}`);
  }

  private async restoreExternal(x: Active): Promise<void> {
    const ext = x.stoppedExternal;
    if (!ext) return;
    this.deps.log.info("restoring external service", { id: ext.id });
    const out = await this.maintenance(ext, "start");
    if (out.code !== 0) throw new Error(`external restore FAILED (${ext.id}): ${out.text.slice(-400)}`);
    x.stoppedExternal = undefined;
    this.persist();
    this.deps.log.info("external service restored", { id: ext.id });
  }

  private async maintenance(ext: ExternalService, verb: "stop" | "start" | "check-only"): Promise<{ code: number; text: string }> {
    const p = Bun.spawn(["/bin/bash", ext.maintenance, verb], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    return { code, text: out + err };
  }

  private tail(x: Active): string { return (x.proc?.recent(6) ?? []).join(" | ").slice(-600); }

  private set(x: Active, state: AssignmentState, detail?: string): void {
    if (x.stopping || this.active.get(x.a.id) !== x) return;
    x.state = state;
    if (detail !== undefined) x.detail = detail;
    this.deps.report(x.a.id, state, x.detail, Object.keys(x.ports).length ? x.ports : undefined);
    this.persist();
    this.deps.onChange?.();
  }

  private fail(x: Active, why: string): void {
    if (x.stopping) return;
    this.deps.log.error("assignment failed", { id: x.a.id, why });
    x.state = "failed"; x.detail = why;
    this.deps.report(x.a.id, "failed", why, Object.keys(x.ports).length ? x.ports : undefined);
    void this.cleanup(x).then(() => { this.persist(); this.deps.onChange?.(); }).catch((e: Error) => {
      this.deps.log.error("assignment cleanup failed", { id: x.a.id, err: e.message });
    });
  }

  private persist(): void {
    const file = join(this.deps.stateDir, "assignments.json");
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(this.snapshot(), null, 2), { mode: 0o600 });
      renameSync(temporary, file);
    } catch (e) { this.deps.log.error("persist failed", { err: (e as Error).message }); throw e; }
  }
}

export type { Endpoint };
