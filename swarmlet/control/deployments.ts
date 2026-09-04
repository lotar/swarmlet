// DeploymentManager: the state machine planned -> placing -> loading -> ready -> draining -> stopped
// (-> failed from anywhere). Turns a Plan into assignments (workers first, coordinator last), waits
// for the states the agents report, and tears everything down on any failure or node loss.

import { AGENT_DATA_PORT, type Assignment, type AssignmentState, type CoordinatorAssignment, type Deployment, type DeploymentSpec, type Endpoint, type ModelProfile, type Plan, type ReplicaAssignment, type WorkerAssignment } from "../protocol/types.ts";
import type { AgentChannel } from "./channel.ts";
import type { Logger } from "./log.ts";
import { PlanError, planDeployment } from "./planner.ts";
import type { NodeRow, Registry } from "./registry.ts";

export interface DeploymentDeps { reg: Registry; channel: AgentChannel; profiles: Map<string, ModelProfile>; log: Logger }

const WORKER_TIMEOUT_MS = 5 * 60_000;
const COORDINATOR_TIMEOUT_MS = 60 * 60_000;
const STOP_TIMEOUT_MS = 2 * 60_000;

function newId(prefix: string): string {
  const b = new Uint8Array(6); crypto.getRandomValues(b);
  return `${prefix}-${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export class DeploymentManager {
  private waiters = new Map<string, Array<(s: AssignmentState, detail?: string) => void>>();
  private inflight = new Map<string, number>();

  constructor(private readonly deps: DeploymentDeps) {}

  // ---------- hooks from the channel ----------

  onAssignmentState(nodeId: string, id: string, state: AssignmentState, detail?: string): void {
    for (const w of this.waiters.get(id) ?? []) w(state, detail);
    if (state === "failed") {
      const row = this.deps.reg.getAssignment(id);
      if (!row) return;
      const dep = this.deps.reg.getDeployment(row.deploymentId);
      if (dep && dep.state !== "stopped" && dep.state !== "failed" && dep.state !== "draining") {
        void this.fail(dep.id, `assignment ${id} on ${nodeId} failed: ${detail ?? "no detail"}`);
      }
    }
  }

  onOffline(nodeId: string): void {
    for (const dep of this.deps.reg.listDeployments()) {
      if (dep.state === "stopped" || dep.state === "failed" || dep.state === "planned") continue;
      const mine = this.deps.reg.listAssignments(dep.id).some((a) => a.nodeId === nodeId && a.state !== "stopped");
      if (mine) void this.fail(dep.id, `node ${nodeId} went offline`);
    }
  }

  // ---------- API ----------

  async create(spec: DeploymentSpec): Promise<{ id: string }> {
    if (!spec.name || !/^[a-zA-Z0-9._-]{1,64}$/.test(spec.name)) throw new Error("name must be 1-64 chars of [a-zA-Z0-9._-]");
    if (spec.kind === "external") {
      if (!spec.external?.nodeId || !spec.external.url || !spec.external.modelName) throw new Error("external needs external.nodeId, url, modelName");
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

  async start(id: string): Promise<void> {
    const dep = this.must(id);
    if (!["planned", "stopped", "failed"].includes(dep.state)) throw new Error(`cannot start from state ${dep.state}`);
    this.deps.reg.updateDeployment(id, { state: "placing", error: null, endpoint: null });
    try {
      if (dep.spec.kind === "external") await this.startExternal(dep);
      else if (dep.spec.kind === "replica") await this.startReplica(dep);
      else await this.startSplit(dep);
    } catch (e) {
      await this.fail(id, (e as Error).message);
      throw e;
    }
  }

  async stop(id: string): Promise<void> {
    const dep = this.must(id);
    if (dep.state === "stopped" || dep.state === "planned") return;
    this.deps.reg.updateDeployment(id, { state: "draining", endpoint: null });
    await this.teardown(id);
    this.deps.reg.updateDeployment(id, { state: "stopped" });
    this.deps.reg.event("deployment", "stopped", { deploymentId: id });
  }

  async remove(id: string): Promise<void> {
    const dep = this.must(id);
    if (!["planned", "stopped", "failed"].includes(dep.state)) throw new Error("stop the deployment first");
    this.deps.reg.deleteDeployment(id);
  }

  /** Ready deployments grouped by served model name, for the router and the Routing page. */
  routing(): Array<{ modelName: string; deployments: Array<{ id: string; name: string; nodeId: string; port: number; inflight: number; tokPerSec?: number; rttMs?: number }> }> {
    const byModel = new Map<string, Array<{ id: string; name: string; nodeId: string; port: number; inflight: number; tokPerSec?: number; rttMs?: number }>>();
    for (const dep of this.deps.reg.listDeployments()) {
      if (dep.state !== "ready" || !dep.endpoint) continue;
      const node = this.deps.reg.getNode(dep.endpoint.nodeId);
      const list = byModel.get(dep.endpoint.modelName) ?? [];
      list.push({ id: dep.id, name: dep.spec.name, nodeId: dep.endpoint.nodeId, port: dep.endpoint.port, inflight: this.inflight.get(dep.id) ?? 0, tokPerSec: node?.metrics?.tokPerSec, rttMs: node?.caps?.net?.rttMs });
      byModel.set(dep.endpoint.modelName, list);
    }
    return [...byModel].map(([modelName, deployments]) => ({ modelName, deployments }));
  }

  trackInflight(id: string, delta: number): void { this.inflight.set(id, Math.max(0, (this.inflight.get(id) ?? 0) + delta)); }

  // ---------- starters ----------

  private async startExternal(dep: Deployment): Promise<void> {
    const ext = dep.spec.external!;
    const node = this.node(ext.nodeId);
    const url = new URL(ext.url);
    const a: ReplicaAssignment = { kind: "replica", id: newId("as"), deploymentId: dep.id, port: Number(url.port), external: { url: ext.url, healthPath: ext.healthPath || "/health", maintenance: ext.maintenance }, modelName: ext.modelName, allow: [] };
    this.deps.reg.updateDeployment(dep.id, { state: "loading", plan: null });
    await this.dispatch(node.id, a, ["ready"], WORKER_TIMEOUT_MS);
    this.deps.reg.updateDeployment(dep.id, { state: "ready", endpoint: { nodeId: node.id, port: Number(url.port), modelName: ext.modelName } });
    this.deps.reg.event("deployment", `ready (external ${ext.url})`, { deploymentId: dep.id });
  }

  private async startReplica(dep: Deployment): Promise<void> {
    const profile = this.deps.profiles.get(dep.spec.profile)!;
    const plan = this.plan(dep.spec, this.usedPorts());
    this.deps.reg.updateDeployment(dep.id, { plan, state: "loading" });
    const node = this.node(plan.coordinatorNodeId);
    const port = this.freePort(node.id, 8100, this.usedPorts());
    const a: ReplicaAssignment = { kind: "replica", id: newId("as"), deploymentId: dep.id, port, model: { path: plan.modelPath }, modelName: profile.modelName, ctx: plan.ctx, parallel: plan.parallel, extraArgs: profile.extraArgs, allow: [] };
    await this.dispatch(node.id, a, ["ready"], COORDINATOR_TIMEOUT_MS);
    this.deps.reg.updateDeployment(dep.id, { state: "ready", endpoint: { nodeId: node.id, port, modelName: profile.modelName } });
    this.deps.reg.event("deployment", `ready (replica on ${node.hostname})`, { deploymentId: dep.id });
  }

  private async startSplit(dep: Deployment): Promise<void> {
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
    this.deps.reg.updateDeployment(dep.id, { state: "loading" });
    const coordLayers = plan.tensorSplit[plan.tensorSplit.length - 1] ?? 0;
    const externals = dep.spec.stopExternal ? this.deps.reg.listDeployments().filter((d) => d.spec.kind === "external" && d.spec.external?.nodeId === coord.id) : [];
    const port = this.freePort(coord.id, 8100, used);
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
    this.deps.reg.updateDeployment(dep.id, { state: "ready", endpoint: { nodeId: coord.id, port, modelName: profile.modelName } });
    this.deps.reg.event("deployment", `ready (split ${plan.tensorSplit.join("/")} on ${[...workers.map((x) => x.node.hostname), coord.hostname].join(" > ")})`, { deploymentId: dep.id });
  }

  // ---------- teardown ----------

  private async fail(id: string, why: string): Promise<void> {
    const dep = this.deps.reg.getDeployment(id);
    if (!dep || dep.state === "failed") return;
    this.deps.log.error("deployment failed", { id, why });
    this.deps.reg.updateDeployment(id, { state: "failed", error: why, endpoint: null });
    this.deps.reg.event("deployment", `failed: ${why}`, { deploymentId: id });
    await this.teardown(id);
  }

  private async teardown(id: string): Promise<void> {
    const rows = this.deps.reg.listAssignments(id).filter((r) => r.state !== "stopped");
    // coordinator first (it holds the client sockets), then workers
    const order = [...rows.filter((r) => r.body.kind === "coordinator"), ...rows.filter((r) => r.body.kind !== "coordinator")];
    for (const r of order) {
      const stop: Assignment = { kind: "stop", id: r.body.id, deploymentId: id };
      if (!this.deps.channel.send(r.nodeId, { t: "assign", assignment: stop })) { this.deps.reg.setAssignmentState(r.id, "stopped", "node offline at stop"); continue; }
      await this.waitFor(r.id, ["stopped", "failed"], STOP_TIMEOUT_MS).catch(() => this.deps.reg.setAssignmentState(r.id, "stopped", "stop timed out"));
    }
  }

  // ---------- helpers ----------

  private plan(spec: DeploymentSpec, usedPorts: Map<string, Set<number>>): Plan {
    const profile = this.deps.profiles.get(spec.profile);
    if (!profile) throw new Error(`unknown profile ${spec.profile}`);
    try {
      return planDeployment({ spec, profile, nodes: this.deps.reg.listNodes().map((n) => ({ ...n, online: this.deps.channel.isOnline(n.id) })), usedPorts });
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
    if (!this.deps.channel.isOnline(id)) throw new Error(`node ${n.hostname} (${id}) is offline`);
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

  private waitFor(assignmentId: string, states: AssignmentState[], timeoutMs: number): Promise<void> {
    const current = this.deps.reg.getAssignment(assignmentId)?.state;
    if (current && states.includes(current as AssignmentState)) return Promise.resolve();
    if (current === "failed") return Promise.reject(new Error(`${assignmentId} failed: ${this.deps.reg.getAssignment(assignmentId)?.detail ?? ""}`));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { remove(); reject(new Error(`timeout waiting for ${assignmentId} to be ${states.join("/")}`)); }, timeoutMs);
      const cb = (s: AssignmentState, detail?: string) => {
        if (states.includes(s)) { clearTimeout(timer); remove(); resolve(); }
        else if (s === "failed") { clearTimeout(timer); remove(); reject(new Error(`${assignmentId} failed: ${detail ?? ""}`)); }
      };
      const list = this.waiters.get(assignmentId) ?? [];
      list.push(cb); this.waiters.set(assignmentId, list);
      const remove = () => { const l = this.waiters.get(assignmentId) ?? []; const i = l.indexOf(cb); if (i >= 0) l.splice(i, 1); };
    });
  }
}
