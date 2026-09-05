// DeploymentManager: the state machine planned -> placing -> loading -> ready -> draining -> stopped
// (-> failed from anywhere). Turns a Plan into assignments (workers first, coordinator last), waits
// for the states the agents report, and tears everything down on any failure or node loss.

import { AGENT_DATA_PORT, type Assignment, type AssignmentState, type CoordinatorAssignment, type Deployment, type DeploymentSpec, type Endpoint, type ModelProfile, type Plan, type ReplicaAssignment, type WorkerAssignment } from "../protocol/types.ts";
import type { AgentChannel } from "./channel.ts";
import type { Logger } from "./log.ts";
import { PlanError, planDeployment } from "./planner.ts";
import type { NodeRow, Registry } from "./registry.ts";

export interface DeploymentDeps {
  reg: Registry; channel: AgentChannel; profiles: Map<string, ModelProfile>; log: Logger;
  recoveryDelayMs?: number; stopTimeoutMs?: number;
}

/** First port for coordinator / replica llama-servers on a node (SWARMLET_SERVER_PORT_BASE; tests use another base). */
const serverPortBase = (): number => Number(process.env.SWARMLET_SERVER_PORT_BASE ?? 8100); // read lazily: tests set it after import
const WORKER_TIMEOUT_MS = 5 * 60_000;
const COORDINATOR_TIMEOUT_MS = 60 * 60_000;
const STOP_TIMEOUT_MS = 2 * 60_000;
const MAX_RECOVERY_ATTEMPTS = 5;

function newId(prefix: string): string {
  const b = new Uint8Array(6); crypto.getRandomValues(b);
  return `${prefix}-${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export class DeploymentManager {
  private waiters = new Map<string, Array<(s: AssignmentState, detail?: string) => void>>();
  private inflight = new Map<string, number>();
  private operations = new Map<string, Promise<void>>();
  private generations = new Map<string, number>();
  private closed = false;

  constructor(private readonly deps: DeploymentDeps) {}

  /** Relay sockets do not survive control restart. Withdraw persisted routes before serving HTTP. */
  restore(): void {
    const externalEndpoints = new Set<string>();
    for (const dep of this.deps.reg.listDeployments().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
      if (!this.deps.reg.deploymentIntent(dep.id).running) {
        // Stop intent is written before state/teardown. A crash between those writes must not resurrect a route.
        if (["ready", "placing", "loading", "draining"].includes(dep.state)) this.deps.reg.updateDeployment(dep.id, { state: "draining", endpoint: null });
        else if (dep.endpoint) this.deps.reg.updateDeployment(dep.id, { endpoint: null });
        continue;
      }
      if (dep.spec.kind === "external") {
        const key = `${dep.spec.external!.nodeId}:${this.externalOrigin(dep.spec.external!.url)}`;
        if (externalEndpoints.has(key)) {
          this.deps.reg.setDeploymentIntent(dep.id, { running: false });
          this.deps.reg.updateDeployment(dep.id, { state: "stopped", endpoint: null, error: "duplicate external endpoint; health watch retired" });
          this.deps.reg.event("deployment", "duplicate external endpoint retired (external server remains running)", { deploymentId: dep.id });
          continue;
        }
        externalEndpoints.add(key);
        const hasWatch = this.deps.reg.listAssignments(dep.id).some((a) => !a.retired && a.body.kind === "replica" && a.body.external);
        this.deps.reg.updateDeployment(dep.id, { state: hasWatch ? "loading" : "failed", endpoint: null });
        if (!hasWatch) this.scheduleRecovery(dep.id);
      } else if (dep.state !== "failed") {
        this.deps.reg.updateDeployment(dep.id, { state: "failed", endpoint: null, error: "control restarted; awaiting node reconciliation" });
        this.scheduleRecovery(dep.id);
      }
    }
  }

  /** Called by the existing control sweeper; no background timers outlive the control instance. */
  async reconcile(): Promise<void> {
    if (this.closed) return;
    await Promise.all(this.deps.reg.listDeployments().map(async (dep) => {
      this.finishDraining(dep.id);
      const intent = this.deps.reg.deploymentIntent(dep.id);
      if (dep.state === "ready" && intent.attempts && Date.now() - Date.parse(dep.updatedAt) > 60_000) {
        this.deps.reg.setDeploymentIntent(dep.id, { attempts: 0 });
      }
      if (!intent.running || dep.state !== "failed" || this.operations.has(dep.id) || intent.attempts >= MAX_RECOVERY_ATTEMPTS || Date.now() < intent.retryAt) return;
      let required = dep.spec.external ? [dep.spec.external.nodeId] : dep.plan
        ? [dep.plan.coordinatorNodeId, ...dep.plan.workers.map((w) => w.nodeId)]
        : [dep.spec.coordinatorNodeId ?? dep.spec.replicaNodeId, ...(dep.spec.workerNodeIds ?? [])].filter((n): n is string => !!n);
      if (!required.length) {
        // An automatic placement may have failed before it ever had a plan (for example, no nodes online).
        try { const candidate = this.plan(dep.spec, this.usedPorts()); required = [candidate.coordinatorNodeId, ...candidate.workers.map((w) => w.nodeId)]; }
        catch { return; } // wait for a viable offer instead of burning retries while the rig is absent
      }
      if (required.some((n) => !this.deps.channel.isOnline(n) || !this.deps.reg.getNode(n)?.online)) return;
      this.deps.reg.setDeploymentIntent(dep.id, { attempts: intent.attempts + 1 });
      this.deps.reg.event("deployment", `automatic recovery attempt ${intent.attempts + 1}/${MAX_RECOVERY_ATTEMPTS}`, { deploymentId: dep.id });
      await this.start(dep.id, true).catch(() => {}); // start records the error and next backoff
    }));
  }

  dispose(): void {
    this.closed = true;
    for (const dep of this.deps.reg.listDeployments()) this.cancel(dep.id);
  }

  // ---------- hooks from the channel ----------

  onAssignmentState(nodeId: string, id: string, state: AssignmentState, detail?: string): void {
    const row = this.deps.reg.getAssignment(id);
    if (!row || row.nodeId !== nodeId) return;
    if (row.retired && state !== "stopped") {
      this.deps.channel.send(nodeId, { t: "assign", assignment: { kind: "stop", id, deploymentId: row.deploymentId } });
      return;
    }
    for (const w of [...(this.waiters.get(id) ?? [])]) w(state, detail);
    const dep = this.deps.reg.getDeployment(row.deploymentId);
    if (!dep) return;
    if (state === "stopped") this.finishDraining(dep.id);
    if (row.retired) return;
    // an external server is only watched: unhealthy takes it out of routing, healthy again puts it back
    if (row.body.kind === "replica" && row.body.external && this.deps.reg.deploymentIntent(dep.id).running && (dep.state === "ready" || dep.state === "loading")) {
      if ((state === "failed" || state === "stopped") && dep.state === "ready") {
        this.deps.reg.updateDeployment(dep.id, { state: "loading", endpoint: null, error: `external server unhealthy: ${detail ?? ""}` });
        this.deps.reg.event("deployment", `external server unhealthy, out of routing (${detail ?? ""})`, { deploymentId: dep.id });
      } else if (state === "ready" && dep.state === "loading" && dep.spec.external) {
        this.deps.reg.updateDeployment(dep.id, { state: "ready", error: null, endpoint: { nodeId, port: Number(new URL(dep.spec.external.url).port), modelName: dep.spec.external.modelName } });
        this.deps.reg.event("deployment", "external server healthy again, back in routing", { deploymentId: dep.id });
      }
      return;
    }
    if ((state === "failed" || (state === "stopped" && !row.retired)) && dep.state !== "stopped" && dep.state !== "failed" && dep.state !== "draining") {
      void this.fail(dep.id, `assignment ${id} on ${nodeId} failed: ${detail ?? "no detail"}`).catch((e) => this.deps.log.warn("cleanup pending", { id: dep.id, error: String(e) }));
    }
  }

  /** A node (re)connected and listed what it still runs: re-issue health-only external assignments it
   *  lost (an agent restart forgets them), fail deployments whose engine processes died with the agent. */
  onHello(nodeId: string, reported: Array<{ id: string; state: AssignmentState }>): void {
    const have = new Map(reported.map((r) => [r.id, r.state]));
    for (const r of reported) {
      if (!this.deps.reg.getAssignment(r.id) && r.state !== "stopped") {
        this.deps.channel.send(nodeId, { t: "assign", assignment: { kind: "stop", id: r.id, deploymentId: "orphan" } });
      }
    }
    const externalSeen = new Set<string>();
    for (const row of this.deps.reg.listAssignments().sort((a, b) => Number(a.retired) - Number(b.retired) || a.id.localeCompare(b.id))) {
      if (row.nodeId !== nodeId) continue;
      const dep = this.deps.reg.getDeployment(row.deploymentId);
      const externalHealthOnly = row.body.kind === "replica" && !!row.body.external;
      const wants = !!dep && !row.retired && this.deps.reg.deploymentIntent(dep.id).running && !["failed", "stopped", "planned", "draining"].includes(dep.state);
      const duplicate = externalHealthOnly && externalSeen.has(row.deploymentId);
      if (externalHealthOnly && wants && !duplicate) externalSeen.add(row.deploymentId);
      if (!have.has(row.id) || have.get(row.id) === "stopped") {
        this.deps.reg.retireAssignment(row.id);
        this.deps.reg.setAssignmentState(row.id, "stopped", "agent confirmed assignment absent");
        for (const w of [...(this.waiters.get(row.id) ?? [])]) w("stopped");
        if (wants && externalHealthOnly && !duplicate) this.deps.channel.assign(nodeId, row.body);
        else if (wants && !externalHealthOnly) void this.fail(dep!.id, `node ${nodeId} restarted without assignment ${row.id}`).catch(() => {});
      } else if (!wants || duplicate || row.state === "stopped") {
        // Offline stop was never an acknowledgement. Keep retrying it on every hello.
        this.deps.reg.setAssignmentState(row.id, have.get(row.id)!);
        this.deps.reg.retireAssignment(row.id);
        this.deps.channel.send(nodeId, { t: "assign", assignment: { kind: "stop", id: row.id, deploymentId: row.deploymentId } });
      } else if (externalHealthOnly) {
        this.onAssignmentState(nodeId, row.id, have.get(row.id)!);
      } else if (have.get(row.id) === "failed") {
        void this.fail(dep!.id, `node ${nodeId} reported failed assignment ${row.id}`).catch(() => {});
      }
    }
  }

  onOffline(nodeId: string): void {
    for (const dep of this.deps.reg.listDeployments()) {
      if (dep.state === "stopped" || dep.state === "failed" || dep.state === "planned") continue;
      const rows = this.deps.reg.listAssignments(dep.id).filter((a) => a.nodeId === nodeId && a.state !== "stopped");
      if (!rows.length) continue;
      // The external engine stays running, but the router cannot reach it until its agent returns.
      if (rows.every((a) => a.body.kind === "replica" && a.body.external)) {
        this.deps.reg.updateDeployment(dep.id, { state: "loading", endpoint: null, error: `external agent ${nodeId} offline` });
        this.deps.reg.event("deployment", `agent on ${nodeId} offline; external route withdrawn until reconnect`, { deploymentId: dep.id });
        continue;
      }
      void this.fail(dep.id, `node ${nodeId} went offline`).catch(() => {});
    }
  }

  // ---------- API ----------

  async create(spec: DeploymentSpec): Promise<{ id: string }> {
    if (!spec.name || !/^[a-zA-Z0-9._-]{1,64}$/.test(spec.name)) throw new Error("name must be 1-64 chars of [a-zA-Z0-9._-]");
    if (spec.kind === "external") {
      if (!spec.external?.nodeId || !spec.external.url || !spec.external.modelName) throw new Error("external needs external.nodeId, url, modelName");
      this.assertUniqueExternal(spec);
    } else if (!this.deps.profiles.has(spec.profile)) {
      throw new Error(`unknown profile ${spec.profile} (have ${[...this.deps.profiles.keys()].join(", ")})`);
    }
    const dep = this.deps.reg.createDeployment(newId("dep"), spec);
    this.deps.reg.event("deployment", `created ${spec.name} (${spec.kind})`, { deploymentId: dep.id });
    return { id: dep.id };
  }

  async planPreview(spec: DeploymentSpec): Promise<Plan> {
    if (spec.kind === "external") throw new Error("external deployments are not planned");
    return this.plan(spec, this.usedPorts());
  }

  async start(id: string, recovering = false): Promise<void> {
    const dep = this.must(id);
    if (this.closed) throw new Error("control is shutting down");
    if (this.operations.has(id)) throw new Error("deployment operation already in progress");
    if (!["planned", "stopped", "failed"].includes(dep.state)) throw new Error(`cannot start from state ${dep.state}`);
    if (dep.spec.kind === "external") this.assertUniqueExternal(dep.spec, id);
    this.deps.reg.setDeploymentIntent(id, { running: true, ...(recovering ? {} : { attempts: 0, retryAt: 0 }) });
    const generation = this.generations.get(id) ?? 0;
    this.deps.reg.updateDeployment(id, { state: "placing", error: null, endpoint: null });
    return this.enqueue(id, async () => {
      try {
        await this.teardown(id);
        this.assertRunning(id, generation);
        if (dep.spec.kind === "external") await this.startExternal(dep, generation);
        else if (dep.spec.kind === "replica") await this.startReplica(dep, generation);
        else await this.startSplit(dep, generation);
      } catch (e) {
        if (!this.closed && generation === (this.generations.get(id) ?? 0)) {
          this.recordFailure(id, (e as Error).message);
          await this.teardown(id).catch(() => {});
        }
        throw e;
      }
    });
  }

  async stop(id: string): Promise<void> {
    this.must(id);
    this.deps.reg.setDeploymentIntent(id, { running: false, attempts: 0, retryAt: 0 });
    this.cancel(id);
    this.deps.reg.updateDeployment(id, { state: "draining", endpoint: null });
    await this.enqueue(id, async () => {
      await this.teardown(id);
      this.deps.reg.updateDeployment(id, { state: "stopped" });
      this.deps.reg.event("deployment", "stopped", { deploymentId: id });
    });
  }

  async remove(id: string): Promise<void> {
    const dep = this.must(id);
    if (!["planned", "stopped", "failed"].includes(dep.state)) throw new Error("stop the deployment first");
    await this.stop(id); // never discard the only durable record of an unacknowledged stop
    this.deps.reg.deleteDeployment(id);
  }

  /** Ready deployments grouped by served model name, for the router and the Routing page. */
  routing(): Array<{ modelName: string; deployments: Array<{ id: string; name: string; kind: string; nodeId: string; port: number; nodes: string[]; inflight: number; tokPerSec?: number; rttMs?: number }> }> {
    const byModel = new Map<string, Array<{ id: string; name: string; kind: string; nodeId: string; port: number; nodes: string[]; inflight: number; tokPerSec?: number; rttMs?: number }>>();
    for (const dep of this.deps.reg.listDeployments()) {
      if (dep.state !== "ready" || !dep.endpoint) continue;
      const node = this.deps.reg.getNode(dep.endpoint.nodeId);
      const list = byModel.get(dep.endpoint.modelName) ?? [];
      const nodes = dep.plan ? [dep.plan.coordinatorNodeId, ...dep.plan.workers.map((w) => w.nodeId)] : [dep.endpoint.nodeId];
      list.push({ id: dep.id, name: dep.spec.name, kind: dep.spec.kind, nodeId: dep.endpoint.nodeId, port: dep.endpoint.port, nodes, inflight: this.inflight.get(dep.id) ?? 0, tokPerSec: this.liveTokPerSec(dep.id), rttMs: node?.caps?.net?.rttMs });
      byModel.set(dep.endpoint.modelName, list);
    }
    return [...byModel].map(([modelName, deployments]) => ({ modelName, deployments }));
  }

  trackInflight(id: string, delta: number): void { this.inflight.set(id, Math.max(0, (this.inflight.get(id) ?? 0) + delta)); }

  /** Tokens the router saw stream out of each deployment, in 1 s buckets, for a live rate. */
  private tokenBuckets = new Map<string, Map<number, number>>();

  recordTokens(id: string, n: number): void {
    if (n <= 0) return;
    const sec = Math.floor(Date.now() / 1000);
    const b = this.tokenBuckets.get(id) ?? new Map<number, number>();
    b.set(sec, (b.get(sec) ?? 0) + n);
    for (const k of b.keys()) if (k < sec - 30) b.delete(k);
    this.tokenBuckets.set(id, b);
  }

  /** Routed generation rate over the last `windowSec` seconds (0 when idle). */
  liveTokPerSec(id: string, windowSec = 5): number {
    const b = this.tokenBuckets.get(id);
    if (!b) return 0;
    const now = Math.floor(Date.now() / 1000);
    let total = 0;
    for (const [k, v] of b) if (k > now - windowSec && k <= now) total += v;
    return Math.round((total / windowSec) * 10) / 10;
  }

  /** Routed live rate per node (sum over the ready deployments it serves). */
  liveTokPerSecByNode(): Map<string, number> {
    const out = new Map<string, number>();
    for (const dep of this.deps.reg.listDeployments()) {
      if (dep.state !== "ready" || !dep.endpoint) continue;
      const r = this.liveTokPerSec(dep.id);
      if (r > 0) out.set(dep.endpoint.nodeId, (out.get(dep.endpoint.nodeId) ?? 0) + r);
    }
    return out;
  }

  // ---------- starters ----------

  private async startExternal(dep: Deployment, generation: number): Promise<void> {
    const ext = dep.spec.external!;
    const node = this.node(ext.nodeId);
    const url = new URL(ext.url);
    const a: ReplicaAssignment = { kind: "replica", id: newId("as"), deploymentId: dep.id, port: Number(url.port), external: { url: ext.url, healthPath: ext.healthPath || "/health", maintenance: ext.maintenance }, modelName: ext.modelName, allow: [] };
    this.deps.reg.updateDeployment(dep.id, { state: "loading", plan: null });
    await this.dispatch(node.id, a, ["ready"], WORKER_TIMEOUT_MS);
    this.assertRunning(dep.id, generation);
    this.deps.reg.updateDeployment(dep.id, { state: "ready", endpoint: { nodeId: node.id, port: Number(url.port), modelName: ext.modelName } });
    this.deps.reg.event("deployment", `ready (external ${ext.url})`, { deploymentId: dep.id });
  }

  private async startReplica(dep: Deployment, generation: number): Promise<void> {
    const profile = this.deps.profiles.get(dep.spec.profile)!;
    const plan = this.plan(dep.spec, this.usedPorts());
    this.deps.reg.updateDeployment(dep.id, { plan, state: "loading" });
    const node = this.node(plan.coordinatorNodeId);
    const port = this.freePort(node.id, serverPortBase(), this.usedPorts());
    const a: ReplicaAssignment = { kind: "replica", id: newId("as"), deploymentId: dep.id, port, model: { path: plan.modelPath }, modelName: profile.modelName, ctx: plan.ctx, parallel: plan.parallel, extraArgs: profile.extraArgs, allow: [] };
    await this.dispatch(node.id, a, ["ready"], COORDINATOR_TIMEOUT_MS);
    this.assertRunning(dep.id, generation);
    this.deps.reg.updateDeployment(dep.id, { state: "ready", endpoint: { nodeId: node.id, port, modelName: profile.modelName } });
    this.deps.reg.event("deployment", `ready (replica on ${node.hostname})`, { deploymentId: dep.id });
  }

  private async startSplit(dep: Deployment, generation: number): Promise<void> {
    const profile = this.deps.profiles.get(dep.spec.profile)!;
    const used = this.usedPorts();
    const plan = this.plan(dep.spec, used);
    this.deps.reg.updateDeployment(dep.id, { plan });
    const coord = this.node(plan.coordinatorNodeId);
    const workers = plan.workers.map((w) => ({ w, node: this.node(w.nodeId) }));
    const relayOnly = dep.spec.transport === "relay";
    const endpointFor = (node: NodeRow, port: number): Endpoint => ({
      nodeId: node.id, certFp: node.certFp, port,
      direct: relayOnly ? [] : [...(node.caps?.privateIps ?? []), ...(node.caps?.publicIp ? [node.caps.publicIp] : [])].map((host) => ({ host, port: node.caps?.dataPort ?? AGENT_DATA_PORT })),
      relay: true,
    });
    // workers first, in ring order; worker i pushes to worker i+1 (peerPort) when forwarding is on
    const assignments: Array<{ nodeId: string; a: WorkerAssignment }> = workers.map(({ w, node }, i) => {
      const next = workers[i + 1];
      const prev = workers[i - 1];
      const allow = [coord.certFp, ...(prev ? [prev.node.certFp] : [])];
      const peers = next && w.peerPort && next.w.peerPort ? [{ index: i + 1, endpoint: endpointFor(next.node, next.w.peerPort) }] : undefined;
      const a: WorkerAssignment = { kind: "worker", id: newId("as"), deploymentId: dep.id, port: w.port, device: w.device, threads: w.threads, memCapMiB: w.memCapMiB, peerPort: w.peerPort, peers, allow, enforce: { ramMiB: node.offer?.ramMiB, cpuCores: node.offer?.cpuCores } };
      return { nodeId: node.id, a };
    });
    for (const { nodeId, a } of assignments) { if (!this.deps.channel.assign(nodeId, a)) throw new Error(`node ${nodeId} is offline`); }
    await Promise.all(assignments.map(({ a }) => this.waitFor(a.id, ["listening"], WORKER_TIMEOUT_MS)));
    this.assertRunning(dep.id, generation);
    this.deps.reg.updateDeployment(dep.id, { state: "loading" });
    const coordLayers = plan.tensorSplit[plan.tensorSplit.length - 1] ?? 0;
    const externals = dep.spec.stopExternal ? this.deps.reg.listDeployments().filter((d) => d.spec.kind === "external" && d.spec.external?.nodeId === coord.id) : [];
    const port = this.freePort(coord.id, serverPortBase(), used);
    const c: CoordinatorAssignment = {
      kind: "coordinator", id: newId("as"), deploymentId: dep.id, model: { path: plan.modelPath },
      rpc: workers.map(({ w, node }) => endpointFor(node, w.port)), devices: [...workers.map((_, i) => `RPC${i}`), plan.coordinatorDevice],
      tensorSplit: plan.tensorSplit, ctx: plan.ctx, parallel: plan.parallel,
      mtp: plan.chain > 0 && plan.mtpPath ? { path: plan.mtpPath, chain: plan.chain } : undefined,
      env: plan.env, extraArgs: profile.extraArgs, port, modelName: profile.modelName,
      fitMiB: coord.os === "darwin" ? coordLayers * profile.layerMiB + profile.coordinatorHostMiB : undefined,
      stopExternal: externals[0]?.spec.name, allow: [], enforce: { ramMiB: coord.offer?.ramMiB, cpuCores: coord.offer?.cpuCores },
    };
    if (!this.deps.channel.assign(coord.id, c)) throw new Error(`coordinator ${coord.id} is offline`);
    await this.waitFor(c.id, ["ready"], COORDINATOR_TIMEOUT_MS);
    this.assertRunning(dep.id, generation);
    this.deps.reg.updateDeployment(dep.id, { state: "ready", endpoint: { nodeId: coord.id, port, modelName: profile.modelName } });
    this.deps.reg.event("deployment", `ready (split ${plan.tensorSplit.join("/")} on ${[...workers.map((x) => x.node.hostname), coord.hostname].join(" > ")})`, { deploymentId: dep.id });
  }

  // ---------- teardown ----------

  private async fail(id: string, why: string): Promise<void> {
    const dep = this.deps.reg.getDeployment(id);
    if (!dep || ["failed", "stopped", "draining"].includes(dep.state) || this.closed) return;
    this.cancel(id);
    this.recordFailure(id, why);
    await this.enqueue(id, () => this.teardown(id));
  }

  private recordFailure(id: string, why: string): void {
    this.deps.log.error("deployment failed", { id, why });
    this.deps.reg.updateDeployment(id, { state: "failed", error: why, endpoint: null });
    this.deps.reg.event("deployment", `failed: ${why}`, { deploymentId: id });
    this.scheduleRecovery(id);
  }

  private scheduleRecovery(id: string): void {
    const intent = this.deps.reg.deploymentIntent(id);
    if (!intent.running) return;
    const delay = Math.min(60_000, (this.deps.recoveryDelayMs ?? 5000) * 2 ** Math.max(0, intent.attempts - 1));
    this.deps.reg.setDeploymentIntent(id, { retryAt: Date.now() + delay });
    this.deps.reg.event("deployment", intent.attempts >= MAX_RECOVERY_ATTEMPTS
      ? "automatic recovery exhausted; explicit Start required" : `recovery scheduled in ${delay}ms after required nodes reconnect`, { deploymentId: id });
  }

  private async teardown(id: string): Promise<void> {
    if (this.closed) throw new Error("control is shutting down");
    const rows = this.deps.reg.listAssignments(id).filter((r) => r.state !== "stopped");
    // coordinator first (it holds the client sockets), then workers
    const order = [...rows.filter((r) => r.body.kind === "coordinator"), ...rows.filter((r) => r.body.kind !== "coordinator")];
    for (const r of order) {
      this.deps.reg.retireAssignment(r.id);
      const stop: Assignment = { kind: "stop", id: r.body.id, deploymentId: id };
      if (!this.deps.channel.send(r.nodeId, { t: "assign", assignment: stop })) continue;
      // A failed engine can still own ports or have cleanup in progress. Only stopped/hello absence proves release.
      await this.waitFor(r.id, ["stopped"], this.deps.stopTimeoutMs ?? STOP_TIMEOUT_MS, false).catch(() => {});
      if (this.closed) throw new Error("control is shutting down");
    }
    const pending = this.deps.reg.listAssignments(id).filter((r) => r.state !== "stopped");
    if (pending.length) throw new Error(`cleanup pending acknowledgement: ${pending.map((r) => r.id).join(", ")}`);
  }

  // ---------- helpers ----------

  private assertUniqueExternal(spec: DeploymentSpec, except?: string): void {
    const ext = spec.external!;
    const key = this.externalOrigin(ext.url);
    const duplicate = this.deps.reg.listDeployments().find((d) => d.id !== except && d.spec.kind === "external"
      && d.spec.external?.nodeId === ext.nodeId && this.externalOrigin(d.spec.external.url) === key
      && (this.deps.reg.deploymentIntent(d.id).running || !["failed", "stopped"].includes(d.state)));
    if (duplicate) throw new Error(`external endpoint already registered by ${duplicate.spec.name} (${duplicate.id})`);
  }

  private externalOrigin(url: string): string {
    const u = new URL(url);
    if (["localhost", "[::1]"].includes(u.hostname)) u.hostname = "127.0.0.1";
    return u.origin;
  }

  private finishDraining(id: string): void {
    if (this.deps.reg.getDeployment(id)?.state === "draining" && !this.deps.reg.deploymentIntent(id).running
      && this.deps.reg.listAssignments(id).every((a) => a.state === "stopped")) {
      this.deps.reg.updateDeployment(id, { state: "stopped", endpoint: null, error: null });
      this.deps.reg.event("deployment", "stopped after all cleanup acknowledgements", { deploymentId: id });
    }
  }

  private enqueue(id: string, work: () => Promise<void>): Promise<void> {
    const prior = this.operations.get(id) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(work);
    this.operations.set(id, next);
    void next.finally(() => { if (this.operations.get(id) === next) this.operations.delete(id); }).catch(() => {});
    return next;
  }

  private cancel(id: string): void {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    for (const row of this.deps.reg.listAssignments(id)) {
      for (const w of [...(this.waiters.get(row.id) ?? [])]) w("failed", "deployment operation cancelled");
    }
  }

  private assertRunning(id: string, generation: number): void {
    if (this.closed || !this.deps.reg.deploymentIntent(id).running || generation !== (this.generations.get(id) ?? 0)) throw new Error("deployment operation cancelled");
  }

  private plan(spec: DeploymentSpec, usedPorts: Map<string, Set<number>>): Plan {
    const profile = this.deps.profiles.get(spec.profile);
    if (!profile) throw new Error(`unknown profile ${spec.profile}`);
    try {
      return planDeployment({ spec, profile, nodes: this.deps.reg.listNodes().map((n) => ({ ...n, online: n.online && this.deps.channel.isOnline(n.id) })), usedPorts });
    } catch (e) {
      if (e instanceof PlanError) throw new Error(`no plan: ${e.message}`); // message already carries every reason
      throw e as Error;
    }
  }

  private usedPorts(): Map<string, Set<number>> {
    const used = new Map<string, Set<number>>();
    for (const r of this.deps.reg.listAssignments()) {
      if (r.state === "stopped") continue;
      const s = used.get(r.nodeId) ?? new Set<number>();
      const b = r.body;
      if (b.kind === "worker") { s.add(b.port); if (b.peerPort) s.add(b.peerPort); }
      if (b.kind === "coordinator" || b.kind === "replica") s.add(b.port);
      used.set(r.nodeId, s);
    }
    return used;
  }

  private freePort(nodeId: string, from: number, used: Map<string, Set<number>>): number {
    const s = used.get(nodeId) ?? new Set<number>();
    let p = from; while (s.has(p)) p++;
    s.add(p); used.set(nodeId, s);
    return p;
  }

  private node(id: string): NodeRow {
    const n = this.deps.reg.getNode(id);
    if (!n) throw new Error(`unknown node ${id}`);
    if (!n.online || !this.deps.channel.isOnline(id)) throw new Error(`node ${n.hostname} (${id}) is offline or awaiting hello`);
    return n;
  }

  private must(id: string): Deployment {
    const d = this.deps.reg.getDeployment(id);
    if (!d) throw new Error(`unknown deployment ${id}`);
    return d;
  }

  private async dispatch(nodeId: string, a: Assignment, states: AssignmentState[], timeoutMs: number): Promise<void> {
    if (!this.deps.channel.assign(nodeId, a)) throw new Error(`node ${nodeId} is offline`);
    await this.waitFor(a.id, states, timeoutMs);
  }

  private waitFor(assignmentId: string, states: AssignmentState[], timeoutMs: number, rejectFailure = true): Promise<void> {
    const current = this.deps.reg.getAssignment(assignmentId)?.state;
    if (current && states.includes(current as AssignmentState)) return Promise.resolve();
    if (rejectFailure && current === "failed") return Promise.reject(new Error(`${assignmentId} failed: ${this.deps.reg.getAssignment(assignmentId)?.detail ?? ""}`));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { remove(); reject(new Error(`timeout waiting for ${assignmentId} to be ${states.join("/")}`)); }, timeoutMs);
      const cb = (s: AssignmentState, detail?: string) => {
        if (states.includes(s)) { clearTimeout(timer); remove(); resolve(); }
        else if (s === "failed" && (rejectFailure || this.closed)) { clearTimeout(timer); remove(); reject(new Error(`${assignmentId} failed: ${detail ?? ""}`)); }
      };
      const list = this.waiters.get(assignmentId) ?? [];
      list.push(cb); this.waiters.set(assignmentId, list);
      const remove = () => { const l = this.waiters.get(assignmentId) ?? []; const i = l.indexOf(cb); if (i >= 0) l.splice(i, 1); };
    });
  }
}
