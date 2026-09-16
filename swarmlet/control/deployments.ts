// DeploymentManager: the state machine planned -> placing -> loading -> ready -> draining -> stopped
// (-> failed from anywhere). Turns a Plan into assignments (workers first, coordinator last), waits
// for the states the agents report, and tears everything down on any failure or node loss.

import { AGENT_DATA_PORT, type Assignment, type AssignmentState, type CoordinatorAssignment, type Deployment, type DeploymentKind, type DeploymentSpec, type Endpoint, type ModelProfile, type NativeExecutionPlan, type Plan, type ReplicaAssignment, type StageAssignment, type WorkerAssignment } from "../protocol/types.ts";
import type { AgentChannel } from "./channel.ts";
import type { Logger } from "./log.ts";
import { PlanError } from "./planner.ts";
import { availableNodes, planWithResources, reservedResources, addAllocations, type ResourceLedger } from "./resources.ts";
import { fleetRevision, hostMemoryErrors, parseFleetRequest, previewFleet, type FleetInput, type FleetRun } from "./fleet.ts";
import type { NodeRow, Registry } from "./registry.ts";
import type { Qwen35NativeQualification } from "./profiles/qwen35-native.ts";

export interface DeploymentDeps {
  reg: Registry; channel: AgentChannel; profiles: Map<string, ModelProfile>; log: Logger;
  recoveryDelayMs?: number; stopTimeoutMs?: number; reconnectGraceMs?: number;
  /** Floor between two automatic re-placements of the same deployment (default 10 min). */
  moveIntervalMs?: number;
  /** Overridable for tests and for a rig that wants a longer memory: how long a crashed placement is refused. */
  crashCooldownMs?: number;
  /** A deployment must have been stable this long before it can be moved (default 60 s). */
  moveSettleMs?: number;
  /** How long a deployment may sit non-ready before the sweeper re-plans it (default 5 min). */
  wedgedLoadMs?: number;
  nativeQualifications?: readonly Qwen35NativeQualification[];
}

/** First port for coordinator / replica llama-servers on a node (SWARMLET_SERVER_PORT_BASE; tests use another base). */
const serverPortBase = (): number => Number(process.env.SWARMLET_SERVER_PORT_BASE ?? 8100); // read lazily: tests set it after import
const WORKER_TIMEOUT_MS = 5 * 60_000;
const COORDINATOR_TIMEOUT_MS = 60 * 60_000;
const STOP_TIMEOUT_MS = 2 * 60_000;
const MAX_RECOVERY_ATTEMPTS = 5;
/** Default for DeploymentDeps.wedgedLoadMs: a load that has not finished in this long has stopped making progress. */
const WEDGED_LOAD_MS = 5 * 60_000;
/** How long a placement that took the engine down is kept out of the way, and how far a repeat extends it. */
const CRASH_COOLDOWN_MS = 60 * 60_000;
const CRASH_COOLDOWN_MAX_MS = 24 * 60 * 60_000;

function newId(prefix: string): string {
  const b = new Uint8Array(6); crypto.getRandomValues(b);
  return `${prefix}-${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

function planNodes(plan: Plan): string[] {
  return plan.nativeExecution ? plan.nativeExecution.endpoints.map(e => e.nodeId) : [plan.coordinatorNodeId, ...plan.workers.map(w => w.nodeId)];
}

/** True when a candidate would put exactly the same work on exactly the same nodes as the plan already
 *  running. A re-decision that reaches the same layout must not cost an engine reload: a 27B model takes
 *  minutes to come back, and the placement it would come back to is the one that never stopped serving.
 *  Ports are deliberately not compared - they can shift when another deployment takes one, and a port
 *  change alone is not worth an outage. */
export function samePlacement(a: Plan | null | undefined, b: Plan | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.coordinatorNodeId !== b.coordinatorNodeId || a.coordinatorDevice !== b.coordinatorDevice) return false;
  if (a.modelPath !== b.modelPath || a.mtpPath !== b.mtpPath) return false;
  if (a.ctx !== b.ctx || a.parallel !== b.parallel || a.chain !== b.chain) return false;
  if (JSON.stringify(a.speculation ?? null) !== JSON.stringify(b.speculation ?? null)) return false;
  if (JSON.stringify(a.nativeExecution ?? null) !== JSON.stringify(b.nativeExecution ?? null)) return false;
  if (a.workers.length !== b.workers.length) return false;
  for (let i = 0; i < a.workers.length; i++) {
    const x = a.workers[i]!, y = b.workers[i]!;
    if (x.nodeId !== y.nodeId || x.layers !== y.layers || x.device !== y.device || x.threads !== y.threads) return false;
  }
  const aSplit = a.engineTensorSplit ?? a.tensorSplit, bSplit = b.engineTensorSplit ?? b.tensorSplit;
  if (aSplit.length !== bSplit.length) return false;
  for (let i = 0; i < aSplit.length; i++) if (aSplit[i] !== bSplit[i]) return false;
  return true;
}

/** A stable name for what was put where, used to remember a placement that crashed. Ports and timings are
 *  excluded on purpose: the shape is the model, the nodes, the split and the threads - not the ephemeral
 *  numbers that change when another deployment takes a port. */
export function planFingerprint(plan: Plan): string {
  const workers = plan.workers.map((w) => `${w.nodeId}/${w.device}/${w.layers}/${w.threads}`).join(",");
  const split = (plan.engineTensorSplit ?? plan.tensorSplit).join("-");
  return [plan.coordinatorNodeId, plan.coordinatorDevice, workers, split, plan.ctx, plan.parallel, plan.chain, plan.modelPath].join("|");
}

export class DeploymentManager {
  private waiters = new Map<string, Array<(s: AssignmentState, detail?: string) => void>>();
  private inflight = new Map<string, number>();
  private updateLease: { nodeId: string; token: string; expiresAt: number } | null = null;
  private updateRecovery = new Set<string>();
  private operations = new Map<string, Promise<void>>();
  private distributionApplications = new Set<string>();
  private generations = new Map<string, number>();
  private closed = false;
  private fleetToken: symbol | null = null;
  private fleetPlanning = false;
  private nativeLifetimes = new Map<string, AbortController>();
  // A channel loss invalidates relay RPC state. Keep routing withdrawn while acknowledged
  // teardown and bounded reconnect run, then build a fresh placement (never resume RPC state).
  private reconnecting = new Map<string, { deadline: number; cleanupDeadline?: number; nodes: string[]; reason: string }>();
  /** Last move decision per deployment - a re-placement, or a rescue attempt that could not move: the
   *  cooldown that stops two equivalent placements fighting. */
  private lastMove = new Map<string, number>();
  /** Placements this deployment has proved it cannot run: fingerprint -> why, and when to try again.
   *  A shape that aborted in the engine is not a layout to re-decide into fifteen minutes later. */
  private blocked = new Map<string, Map<string, { until: number; cooldownMs: number; why: string }>>();
  /** Nodes a deployment has just failed to start on, so neither a retry nor the recovery re-chooses them. */
  private moveExcluded = new Map<string, { nodes: Set<string>; at: number }>();
  private get moveIntervalMs(): number { return this.deps.moveIntervalMs ?? 10 * 60_000; }
  private get crashCooldownMs(): number { return this.deps.crashCooldownMs ?? CRASH_COOLDOWN_MS; }
  private get wedgedLoadMs(): number { return this.deps.wedgedLoadMs ?? WEDGED_LOAD_MS; }
  /** A move must be worth that reload: layers off the serving node, or a materially larger coordinator. */
  private readonly moveMarginLayers = 2;

  constructor(private readonly deps: DeploymentDeps) {}

  private updatingNode(): string | null {
    if (this.updateLease && this.updateLease.expiresAt <= Date.now()) this.updateLease = null;
    return this.updateLease?.nodeId ?? null;
  }

  /** Synchronous with router admission: a granted lease withdraws affected routes before
   * another request can increment inflight. One node at a time; recover service before the next. */
  acquireUpdate(nodeId: string): { nodeId: string; token: string; expiresAt: number } | null {
    if (this.closed || !this.deps.channel.isOnline(nodeId) || !this.deps.reg.getNode(nodeId)) return null;
    if (this.updatingNode()) return null;
    if (this.operations.size || this.distributionApplications.size || this.reconnecting.size || this.fleetToken || this.fleetPlanning) return null;
    for (const id of this.updateRecovery) {
      const dep = this.deps.reg.getDeployment(id);
      if (!dep || dep.state === "ready" || !this.deps.reg.deploymentIntent(id).running) this.updateRecovery.delete(id);
    }
    if (this.updateRecovery.size) return null;
    const affected: string[] = [];
    for (const dep of this.deps.reg.listDeployments()) {
      const nodes = dep.plan ? planNodes(dep.plan) : dep.endpoint ? [dep.endpoint.nodeId] : [];
      if (nodes.includes(nodeId) && (this.inflight.get(dep.id) ?? 0) > 0) return null;
      if (nodes.includes(nodeId) && dep.state === "ready" && this.deps.reg.deploymentIntent(dep.id).running) affected.push(dep.id);
    }
    this.updateRecovery = new Set(affected);
    this.updateLease = { nodeId, token: crypto.randomUUID(), expiresAt: Date.now() + 120_000 };
    return { ...this.updateLease };
  }

  releaseUpdate(nodeId: string, token: string): boolean {
    if (this.updateLease?.nodeId !== nodeId || this.updateLease.token !== token) return false;
    this.updateLease = null;
    return true;
  }

  /** Relay sockets do not survive control restart. Withdraw persisted routes before serving HTTP. */
  restore(): void {
    for (const run of this.deps.reg.fleetRuns()) if (run.status === 'applying') {
      run.status = 'interrupted'; run.error = 'Control restarted during allocation. Review current placements and preview again before retrying.';
      run.updatedAt = new Date().toISOString(); this.deps.reg.saveFleetRun(run);
    }
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
    if (this.closed || this.updatingNode() || this.fleetToken) return;
    await Promise.all(this.deps.reg.listDeployments().map(async (dep) => {
      this.finishDraining(dep.id);
      const intent = this.deps.reg.deploymentIntent(dep.id);
      this.observeReconnect(dep.id);
      const reconnect = this.reconnecting.get(dep.id);
      const cleanupPending = reconnect && (this.deps.reg.listAssignments(dep.id).some(a => a.state !== "stopped")
        || reconnect.nodes.some(n => !this.deps.channel.isOnline(n) || !this.deps.reg.getNode(n)?.online));
      const expired = reconnect && (reconnect.cleanupDeadline === undefined
        ? Date.now() >= reconnect.deadline : cleanupPending && Date.now() >= reconnect.cleanupDeadline);
      if (reconnect && (expired || intent.attempts >= MAX_RECOVERY_ATTEMPTS)) {
        // Our own cleanup may still hold this deployment; retry on the next tick instead of failing a
        // deployment whose teardown we are ourselves running.
        if (this.operations.has(dep.id)) return;
        // The node is gone and the grace ran out. Killing the deployment is a choice we cannot defend:
        // the model is still servable by whatever nodes are left, and the owner asked for a model, not
        // for those particular machines - so move it before giving up on it.
        const moved = await this.redistribute(dep.id, reconnect.reason).catch(() => false);
        if (moved) return;
        this.recordFailure(dep.id, `${reconnect.reason}; ${reconnect.cleanupDeadline ? "reconnect cleanup deadline" : "reconnect grace"} expired or recovery budget exhausted`);
        return;
      }
      // A load that cannot finish needs a way forward that does not depend on a node coming back or on a
      // membership change control may never be told about: nothing else in this loop looks at a deployment
      // that is stuck mid-load. The same redistribution path as every other move, under the same pacing, so
      // this is a rescue and not a second placement mechanism.
      if (!reconnect && intent.running && !this.operations.has(dep.id)) {
        const wedged = this.wedgedLoadReason(dep);
        if (wedged) {
          this.lastMove.set(dep.id, Date.now()); // one attempt per moveIntervalMs, even one that cannot move
          if (await this.redistribute(dep.id, wedged).catch(() => false)) return;
        }
      }
      // Serving again for a minute: the exclusions have done their job, and a later move is free to consider
      // every node again.
      if (dep.state === "ready" && (this.moveExcluded.get(dep.id)?.at ?? 0) < Date.now() - 60_000) this.moveExcluded.delete(dep.id);
      if (dep.state === "ready" && intent.attempts && Date.now() - Date.parse(dep.updatedAt) > 60_000) {
        this.deps.reg.setDeploymentIntent(dep.id, { attempts: 0 });
      }
      if (!intent.running || (dep.state !== "failed" && !reconnect) || this.operations.has(dep.id) || intent.attempts >= MAX_RECOVERY_ATTEMPTS || Date.now() < intent.retryAt) return;
      let required = dep.spec.external ? [dep.spec.external.nodeId] : dep.plan
        ? planNodes(dep.plan)
        : [dep.spec.coordinatorNodeId ?? dep.spec.replicaNodeId, ...(dep.spec.workerNodeIds ?? [])].filter((n): n is string => !!n);
      if (!required.length) {
        // An automatic placement may have failed before it ever had a plan (for example, no nodes online).
        try { const candidate = this.plan(dep.spec, this.usedPorts(), dep.id); required = planNodes(candidate); }
        catch { return; } // wait for a viable offer instead of burning retries while the rig is absent
      }
      // Waiting out the reconnect grace is the point: a node that blips for a few seconds must not cost
      // an engine reload. Only when the grace expires (above) does an auto-placed deployment move, and
      // a pinned one keeps waiting for the node its owner named.
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
    if (row.retired || this.reconnecting.has(dep.id)) return; // queued teardown owns failures during reconnect
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
      // An agent that is going away fails its own assignments on the way out, and its socket may not have
      // closed yet when that message lands - so "is this node still online?" cannot answer on its own. A
      // node leaving is not a broken engine: it takes the node-loss route, so the route is withdrawn, the
      // grace runs, and the deployment is re-placed rather than killed. Anything else is a genuine engine
      // failure and still fails, immediately and loudly.
      const leaving = !this.deps.channel.isOnline(nodeId) || /shutting down|going offline|agent stopping/i.test(detail ?? "");
      if (leaving) { this.onOffline(nodeId); return; }
      // The engine died on its own here (a node that is leaving took the branch above). Remember the shape so
      // that the next re-decision cannot walk into it again.
      if (/code\s*(?!0[,\s)])[1-9]|SIG[A-Z]+/.test(detail ?? "") && dep.plan) this.blockPlacement(dep.id, dep.plan, detail ?? "engine failed");
      void this.fail(dep.id, `assignment ${id} on ${nodeId} failed: ${detail ?? "no detail"}`).catch((e) => this.deps.log.warn("cleanup pending", { id: dep.id, error: String(e) }));
    }
  }

  /** A node (re)connected and listed what it still runs: re-issue health-only external assignments it
   *  lost (an agent restart forgets them), fail deployments whose engine processes died with the agent. */
  onHello(nodeId: string, reported: Array<{ id: string; state: AssignmentState }>): void {
    for (const [id, reconnect] of this.reconnecting) if (reconnect.nodes.includes(nodeId)) this.observeReconnect(id);
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
      const wants = !!dep && !this.reconnecting.has(dep.id) && !row.retired && this.deps.reg.deploymentIntent(dep.id).running && !["failed", "stopped", "planned", "draining"].includes(dep.state);
      const duplicate = externalHealthOnly && externalSeen.has(row.deploymentId);
      if (externalHealthOnly && wants && !duplicate) externalSeen.add(row.deploymentId);
      if (!have.has(row.id) || have.get(row.id) === "stopped") {
        this.deps.reg.retireAssignment(row.id);
        this.deps.reg.setAssignmentState(row.id, "stopped", "agent confirmed assignment absent");
        for (const w of [...(this.waiters.get(row.id) ?? [])]) w("stopped");
        // Absence only proves a lost engine when the row was actually expected to be running. A row
        // the node itself reported stopped on the way out - or one we retired while it was away - has
        // nothing to lose, and failing the deployment over it turned a clean return into an outage.
        const expected = wants && row.state !== "stopped";
        if (expected && externalHealthOnly && !duplicate) this.deps.channel.assign(nodeId, row.body);
        else if (expected && !externalHealthOnly) void this.fail(dep!.id, `node ${nodeId} restarted without assignment ${row.id}`).catch(() => {});
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
      if (this.closed || !this.deps.reg.deploymentIntent(dep.id).running || ["stopped", "failed", "planned", "draining"].includes(dep.state) || this.reconnecting.has(dep.id)) continue;
      const rows = this.deps.reg.listAssignments(dep.id).filter((a) => a.nodeId === nodeId && a.state !== "stopped");
      // A node that leaves after already reporting its assignments stopped would otherwise look like a
      // deployment with nothing wrong with it - ready, routing traffic, and missing a worker. The plan
      // still names that node, so the plan decides too, not only the live assignment rows.
      const planned = dep.plan ? planNodes(dep.plan).includes(nodeId) : false;
      if (!rows.length && !planned) continue;
      // The external engine stays running, but the router cannot reach it until its agent returns.
      if (rows.length && rows.every((a) => a.body.kind === "replica" && a.body.external)) {
        this.deps.reg.updateDeployment(dep.id, { state: "loading", endpoint: null, error: `external agent ${nodeId} offline` });
        this.deps.reg.event("deployment", `agent on ${nodeId} offline; external route withdrawn until reconnect`, { deploymentId: dep.id });
        continue;
      }
      const reason = `node ${nodeId} went offline`;
      this.cancel(dep.id);
      const nodes = dep.plan ? planNodes(dep.plan)
        : [...new Set(this.deps.reg.listAssignments(dep.id).filter(a => !a.retired).map(a => a.nodeId))];
      this.reconnecting.set(dep.id, { deadline: Math.max(Date.now(), this.updateLease?.nodeId === nodeId ? this.updateLease.expiresAt : 0) + (this.deps.reconnectGraceMs ?? 30_000), nodes, reason });
      this.deps.reg.updateDeployment(dep.id, { state: "loading", endpoint: null, error: `${reason}; reconnecting with fresh placement required` });
      this.deps.reg.event("deployment", `${reason}; route withdrawn, waiting up to ${this.deps.reconnectGraceMs ?? 30_000}ms for reconnect`, { deploymentId: dep.id });
      void this.enqueue(dep.id, () => this.teardown(dep.id)).catch((e) => this.deps.log.warn("reconnect cleanup pending", { id: dep.id, error: String(e) }));
    }
  }

  /**
   * A node just (re)connected. An auto-placed deployment need not keep living on the hardware that
   * happened to exist when it started, so ask whether the nodes present *now* would place it better -
   * and move it only when the answer is clearly better and it has been stable long enough that we are
   * not shuffling between equivalent layouts.
   */
  onNodeOnline(nodeId: string): void {
    if (this.closed) return;
    for (const dep of this.deps.reg.listDeployments()) {
      if (dep.state !== "ready" || !this.deps.reg.deploymentIntent(dep.id).running) continue;
      if (this.pinsNodes(dep.spec) || this.reconnecting.has(dep.id) || this.operations.has(dep.id)) continue;
      if (Date.now() < (this.lastMove.get(dep.id) ?? 0) + this.moveIntervalMs) continue;
      if (Date.now() - Date.parse(dep.updatedAt) < (this.deps.moveSettleMs ?? 60_000)) continue; // freshly placed: let it settle
      if (dep.spec.autoModel) {
        // "Better" for an automatic deployment means a better model, not merely fewer layers somewhere.
        // redistribute() re-decides and skips the restart when nothing would actually change.
        const joined = this.deps.reg.getNode(nodeId)?.hostname ?? nodeId;
        void this.redistribute(dep.id, `${joined} joined`).catch((e) => this.deps.log.warn("re-decision failed", { id: dep.id, error: String(e) }));
        continue;
      }
      let candidate: Plan;
      try { candidate = this.plan(dep.spec, this.usedPorts(), dep.id); } catch { continue; }
      const gain = this.placementGain(dep.plan, candidate);
      if (!gain) continue;
      const host = this.deps.reg.getNode(nodeId)?.hostname ?? nodeId;
      this.deps.reg.event("deployment", `${host} joined; ${dep.spec.name} fits better there (${gain})`, { deploymentId: dep.id });
      void this.redistribute(dep.id, `better placement available (${gain})`).catch((e) => this.deps.log.warn("re-placement failed", { id: dep.id, error: String(e) }));
    }
  }

  /**
   * The best model the nodes online can actually serve right now.
   *
   * Profiles are ranked by the owner's judgement (`profile.rank`), and the first one that can be placed
   * wins: a whole-model replica on one node is tried before a split, because a replica has no boundary
   * traffic and no ring to cross. Nothing here decides feasibility for itself - the planner refuses a
   * model whose weights a node does not hold and layers that do not fit, so the choice can only ever
   * land on something the nodes can really run today.
   */
  private chooseAuto(base: DeploymentSpec, replacingId?: string, exclude?: Set<string>): { spec: DeploymentSpec; why: string } | null {
    const ranked = [...this.deps.profiles.values()]
      .filter((p) => typeof p.rank === "number")
      .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
    const tried: string[] = [];
    const skipped: string[] = [];
    for (const profile of ranked) {
      for (const kind of ["replica", "split"] as const) {
        const candidate: DeploymentSpec = {
          ...base, profile: profile.id, kind, autoModel: true,
          replicaNodeId: undefined, workerNodeIds: undefined, workerLayers: undefined,
        };
        try {
          const planned = this.plan(candidate, this.usedPorts(), replacingId, { exclude });
          if (!this.fitsNow(planned, profile, kind)) {
            skipped.push(`${profile.id} needs ${this.fitNeedMiB(planned, profile, kind)} MiB free on ${this.deps.reg.getNode(planned.coordinatorNodeId)?.hostname ?? planned.coordinatorNodeId}, which has ${Math.round(this.deps.reg.getNode(planned.coordinatorNodeId)?.metrics?.freeRamMiB ?? 0)}`);
            continue;
          }
          return { spec: candidate, why: `${profile.id} as ${kind}${skipped.length ? ` (skipped: ${skipped[0]})` : ""}` };
        } catch (e) {
          tried.push(`${profile.id}/${kind}: ${(e as Error).message.replace(/^no plan: /, "").slice(0, 140)}`);
        }
      }
    }
    this.deps.log.warn("automatic model choice found nothing placeable", { tried: tried.slice(0, 4) });
    this.lastAutoFailure = tried;
    return null;
  }

  /** Why the last automatic choice failed, so the operator is told rather than left guessing. */
  private lastAutoFailure: string[] = [];

  /** What an engine on this node would need resident: the weights it holds plus its host share. */
  private fitNeedMiB(plan: Plan, profile: ModelProfile, kind: DeploymentKind): number {
    const layers = kind === "replica"
      ? profile.layers
      : (plan.engineTensorSplit ?? plan.tensorSplit).at(-1) ?? profile.layers;
    return layers * profile.layerMiB + profile.coordinatorHostMiB;
  }

  /**
   * Whether the node that would carry the engine has that much memory free *right now*.
   *
   * The planner admits against the offer a node published - what it is willing to lend - not against what
   * is free this minute, and a machine running Docker, a browser and another model still advertises its
   * whole GPU. Without this check the automatic choice lands on the best model that fits the offer and
   * dies in the agent's fit gate seconds later, which is exactly what happened the first time it ran.
   */
  private fitsNow(plan: Plan, profile: ModelProfile, kind: DeploymentKind): boolean {
    const node = this.deps.reg.getNode(plan.coordinatorNodeId);
    if (!node || node.os !== "darwin") return true; // the fit gate is macOS-only; elsewhere the offer governs
    const free = node.metrics?.freeRamMiB;
    if (typeof free !== "number") return true;      // unmeasured: the agent's gate is the only authority
    const need = this.fitNeedMiB(plan, profile, kind);
    if (free >= need) return true;
    this.deps.log.info("automatic choice skipped a model that does not fit now", { profile: profile.id, node: node.hostname, freeMiB: Math.round(free), needMiB: need });
    return false;
  }

  /** True when the owner fixed the placement: an explicit choice is not ours to rewrite. */
  private pinsNodes(spec: DeploymentSpec): boolean {
    if (spec.kind === "external" || spec.kind === "stages" || spec.kind === "prefill-decode") return true;
    if (spec.kind === "replica") return !!spec.replicaNodeId;
    return !!spec.coordinatorNodeId || !!(spec.workerNodeIds && spec.workerNodeIds.length);
  }

  /** Layers the serving (coordinator) node carries in a plan; lower is better. */
  private servingLayers(plan: Plan | null | undefined): number | null {
    const split = plan?.engineTensorSplit ?? plan?.tensorSplit;
    if (!split || !split.length) return null;
    return split[split.length - 1] ?? null;
  }

  /**
   * How much better a candidate placement is, or null when it is not worth an engine restart.
   * Deliberately narrow: fewer layers on the serving node, or a coordinator with materially more
   * memory. Anything else is variation, not improvement.
   */
  private placementGain(current: Plan | null | undefined, candidate: Plan): string | null {
    const nowLayers = this.servingLayers(current), nextLayers = this.servingLayers(candidate);
    if (nowLayers !== null && nextLayers !== null && nextLayers <= nowLayers - this.moveMarginLayers) {
      return `${nowLayers} -> ${nextLayers} layers on the serving node`;
    }
    const nowCoord = current?.coordinatorNodeId, nextCoord = candidate.coordinatorNodeId;
    if (nextCoord && nextCoord !== nowCoord) {
      const a = this.deps.reg.getNode(nowCoord ?? "")?.offer?.ramMiB ?? 0;
      const b = this.deps.reg.getNode(nextCoord)?.offer?.ramMiB ?? 0;
      if (a > 0 && b >= a * 1.25) {
        return `coordinator ${this.deps.reg.getNode(nextCoord)?.hostname ?? nextCoord} offers ${Math.round(b / 1024)} vs ${Math.round(a / 1024)} GiB`;
      }
    }
    return null;
  }

  /**
   * The reason a non-ready deployment should be re-planned, or null when it is not wedged.
   *
   * A load can stop making progress for reasons the reconnect path cannot see: the plan can name a node
   * that is no longer online - so the load can never finish - or the engines can simply never report
   * again. The first is answered once the deployment has settled, the second only after it has been
   * non-ready past wedgedLoadMs. Nothing here decides an unreadable or pinned placement: an unknown plan
   * is not evidence of a wedged load, and a pinned one belongs to its owner.
   */
  private wedgedLoadReason(dep: Deployment): string | null {
    if (dep.state !== "placing" && dep.state !== "loading") return null;
    const plan = dep.plan;
    if (!plan || this.pinsNodes(dep.spec)) return null;
    const age = Date.now() - Date.parse(dep.updatedAt);
    if (!Number.isFinite(age)) return null; // a timestamp we cannot read is not evidence of anything
    // The same two pacing rules as any other move: a freshly placed deployment settles first, and a
    // deployment is never re-planned twice inside moveIntervalMs.
    if (age < (this.deps.moveSettleMs ?? 60_000)) return null;
    if (Date.now() < (this.lastMove.get(dep.id) ?? 0) + this.moveIntervalMs) return null;
    const gone = planNodes(plan).filter((n) => !this.deps.channel.isOnline(n) || !this.deps.reg.getNode(n)?.online);
    if (gone.length) return `plan names ${gone.map((n) => this.deps.reg.getNode(n)?.hostname ?? n).join(", ")}, which is offline`;
    if (age < this.wedgedLoadMs) return null;
    return `still not ready after ${Math.round(age / 1000)}s`;
  }

  /** Remember that this deployment cannot run this shape, and say so once, with the evidence. */
  private blockPlacement(id: string, plan: Plan, why: string): void {
    const fingerprint = planFingerprint(plan);
    let perDeployment = this.blocked.get(id);
    if (!perDeployment) { perDeployment = new Map(); this.blocked.set(id, perDeployment); }
    const previous = perDeployment.get(fingerprint);
    // Every repeat of the same crash buys a longer rest: one outage teaches the control nothing new, so the
    // shape is kept out of the way rather than rediscovered on a timer.
    const cooldownMs = previous ? Math.min(previous.cooldownMs * 4, CRASH_COOLDOWN_MAX_MS) : this.crashCooldownMs;
    perDeployment.set(fingerprint, { until: Date.now() + cooldownMs, cooldownMs, why });
    this.deps.reg.event("deployment", `this placement crashed (${why}); not retrying it for ${Math.round(cooldownMs / 60_000)} min - stop and start the deployment to clear that memory`, { deploymentId: id });
  }

  /** The evidence against this shape, if it is still within its rest. */
  private blockedUntil(id: string, plan: Plan): { until: number; why: string } | null {
    const fingerprint = planFingerprint(plan);
    const perDeployment = this.blocked.get(id);
    const entry = perDeployment?.get(fingerprint);
    if (!entry) return null;
    if (entry.until <= Date.now()) { perDeployment!.delete(fingerprint); return null; }
    return entry;
  }

  /** Plan a spec for a deployment, refusing a shape this deployment has already crashed on. Every start
   *  path funnels through here, so a recovery, a move and a manual start are equally unable to adopt a
   *  placement that is known to take the engine down. */
  private planFor(dep: Deployment): Plan {
    const plan = this.plan(dep.spec, this.usedPorts(), dep.id);
    const blocked = this.blockedUntil(dep.id, plan);
    if (blocked) {
      throw new Error(`refusing a placement this deployment crashed on ${Math.max(1, Math.round((blocked.until - Date.now()) / 60_000))} min ago: ${blocked.why}`);
    }
    return plan;
  }

  /**
   * Re-plan a running deployment against the nodes that are here now, and start the result.
   *
   * False when the spec pins its nodes, when no placement exists (the deployment is then failed with
   * the reason attached rather than left limping), or when another operation owns the deployment.
   */
  private async redistribute(id: string, reason: string): Promise<boolean> {
    let dep = this.deps.reg.getDeployment(id);
    if (!dep || this.closed || this.operations.has(id)) return false;
    if (this.pinsNodes(dep.spec)) {
      this.deps.reg.event("deployment", `${dep.spec.name}: ${reason}; placement is pinned, not moving`, { deploymentId: id });
      return false;
    }
    if (this.operations.has(id)) return false;
    if (dep.spec.autoModel) {
      // Re-decide the model first: a node joining may make a better one servable, and a node leaving may
      // take one away. The concrete choice is written back, so the record always says what is served.
      const excludeNow = new Set<string>(this.moveExcluded.get(id)?.nodes ?? []);
      const choice = this.chooseAuto(dep.spec, id, excludeNow);
      if (!choice) {
        this.deps.reg.event("deployment", `${dep.spec.name}: nothing placeable after ${reason} - ${this.lastAutoFailure[0] ?? "no candidate"}`, { deploymentId: id });
        return false;
      }
      if (choice.spec.profile !== dep.spec.profile || choice.spec.kind !== dep.spec.kind) {
        this.deps.reg.event("deployment", `${dep.spec.name}: automatic model choice is now ${choice.why} (was ${dep.spec.profile}/${dep.spec.kind})`, { deploymentId: id });
        this.deps.reg.updateDeployment(id, { spec: choice.spec });
        // Re-read: everything below must plan the model we just chose, not the one we are replacing.
        dep = this.deps.reg.getDeployment(id)!;
      }
    }
    let candidate: Plan;
    try { candidate = this.plan(dep.spec, this.usedPorts(), id); }
    catch (e) {
      this.deps.reg.event("deployment", `${dep.spec.name}: cannot re-place after ${reason} - ${(e as Error).message}`, { deploymentId: id });
      return false;
    }
    const name = (n: string) => this.deps.reg.getNode(n)?.hostname ?? n;
    const before = dep.plan ? planNodes(dep.plan).map(name).join(", ") : "-";
    const after = planNodes(candidate).map(name).join(", ");
    const blockedCandidate = this.blockedUntil(id, candidate);
    if (blockedCandidate) {
      this.lastMove.set(id, Date.now());
      const keepServing = dep.state === "ready";
      this.deps.reg.event("deployment", `${dep.spec.name}: ${reason}; ${after} crashed recently (${blockedCandidate.why}) - ${keepServing ? "keeping the placement that is serving" : "refusing to place it again yet"}`, { deploymentId: id });
      return false;
    }
    // A re-decision that lands on the layout already running must not cost a reload. This is the case that
    // restarted a serving deployment every time a peer node flapped: the candidate was identical, the event
    // below still announced a re-placement, and the model had to come back up to reach where it already was.
    if (dep.state === "ready" && dep.plan && samePlacement(dep.plan, candidate)) {
      this.lastMove.set(id, Date.now()); // pacing: nothing to re-decide here for another move interval
      this.deps.reg.event("deployment", `${dep.spec.name}: ${reason}; placement unchanged (${after}) - not restarting`, { deploymentId: id });
      return false;
    }
    this.deps.reg.setDeploymentIntent(id, { attempts: 0, retryAt: 0 });
    this.deps.reg.event("deployment", `${dep.spec.name}: re-placing after ${reason} (${before} -> ${after})`, { deploymentId: id });
    this.lastMove.set(id, Date.now());
    try {
      await this.start(id, true, undefined, { abandonOfflineCleanup: true, fromReady: true }); // start() re-plans and clears the reconnect record
      return true;
    } catch (e) {
      // A move that cannot start must not cost the placement that was serving. Drop the node that failed
      // and try once more without it; the exclusion is remembered, so the recovery that follows avoids it
      // too, instead of bouncing off the same node five times.
      const why = (e as Error).message;
      const failed = [...new Set(this.deps.reg.listAssignments(id)
        .filter((a) => a.detail && /engine exited|exited \(code|SIGABRT|SIGTERM|failed to allocate|not healthy/i.test(a.detail))
        .map((a) => a.nodeId))];
      if (failed.length) {
        const seen = this.moveExcluded.get(id)?.nodes ?? new Set<string>();
        for (const n of failed) seen.add(n);
        this.moveExcluded.set(id, { nodes: seen, at: Date.now() });
        this.deps.reg.event("deployment", `${dep.spec.name}: re-placement did not start (${why}); re-placing without ${failed.map(name).join(", ")}`, { deploymentId: id });
        return this.redistribute(id, reason);
      }
      this.deps.reg.event("deployment", `${dep.spec.name}: re-placement did not start (${why})`, { deploymentId: id });
      return false;
    }
  }

  // ---------- API ----------

  async create(spec: DeploymentSpec): Promise<{ id: string }> {
    let autoNote: string | undefined;
    if (!spec.name || !/^[a-zA-Z0-9._-]{1,64}$/.test(spec.name)) throw new Error("name must be 1-64 chars of [a-zA-Z0-9._-]");
    if (spec.kind === "external") {
      this.assertExternalOptions(spec);
      if (!spec.external?.nodeId || !spec.external.url || !spec.external.modelName) throw new Error("external needs external.nodeId, url, modelName");
      this.assertUniqueExternal(spec);
    } else if (spec.profile === "auto" || spec.autoModel) {
      // Automatic: pick the best model these nodes can serve, and keep the door open to change it.
      const choice = this.chooseAuto({ ...spec, profile: spec.profile === "auto" ? "" : spec.profile, autoModel: true });
      if (!choice) throw new Error(`no model can be placed on the nodes online right now. The best candidate failed with: ${this.lastAutoFailure[0] ?? "no profile is ranked and placeable"}`);
      spec = choice.spec;
      autoNote = choice.why;
    } else if (!this.deps.profiles.has(spec.profile)) {
      throw new Error(`unknown profile ${spec.profile} (have ${[...this.deps.profiles.keys()].join(", ")})`);
    }
    const note = spec.autoModel ? `, automatic: ${autoNote ?? spec.profile}` : "";
    const dep = this.deps.reg.createDeployment(newId("dep"), spec);
    this.deps.reg.event("deployment", `created ${spec.name} (${spec.kind}${note})`, { deploymentId: dep.id });
    return { id: dep.id };
  }

  async planPreview(spec: DeploymentSpec, replacingId?: string): Promise<Plan> {
    if (spec.kind === "external") throw new Error("external deployments are not planned");
    if (replacingId) this.must(replacingId);
    return this.plan(spec, this.usedPorts(), replacingId);
  }

  private fleetInput(): FleetInput {
    return { nodes: this.deps.reg.listNodes().map(n => ({ ...n, online: n.online && this.deps.channel.isOnline(n.id) && n.id !== this.updatingNode() })),
      deployments: this.deps.reg.listDeployments(), assignments: this.deps.reg.listAssignments(), profiles: this.deps.profiles };
  }

  fleetSnapshot() {
    const input = this.fleetInput(), reserved = reservedResources(input.deployments, input.assignments, input.nodes);
    const free = new Map(availableNodes(input.nodes, reserved).map(n => [n.id, n.offer]));
    return { revision: fleetRevision(input), nodes: input.nodes.map(n => ({ id: n.id, hostname: n.hostname, os: n.os, online: n.online, supported: n.caps?.allocationVersion === 1,
      offer: n.offer, available: free.get(n.id), reserved: reserved.get(n.id), gpus: n.caps?.gpus ?? [], net: n.metrics?.link ?? n.caps?.net,
      freeRamMiB: n.metrics?.freeRamMiB, lastSeen: n.lastSeen, modelCount: n.models.length,
      deployments: input.deployments.filter(d => d.spec.kind !== 'external' && (d.plan ? planNodes(d.plan).includes(n.id) : false) &&
        (['placing','loading','ready','draining'].includes(d.state) || input.assignments.some(a => a.deploymentId === d.id && a.state !== 'stopped'))).map(d => ({ id: d.id, name: d.spec.name })) })),
      deployments: input.deployments.map(d => ({ ...d, inflight: this.inflight.get(d.id) ?? 0, observedTokPerSec: this.liveTokPerSec(d.id) })),
      runs: this.deps.reg.fleetRuns().slice(0, 5), busy: !!this.fleetToken };
  }

  async previewAllocation(value: unknown): Promise<FleetRun> {
    if (this.closed || this.fleetToken || this.fleetPlanning) throw new Error('An allocation operation is already in progress.');
    const request = parseFleetRequest(value), input = this.fleetInput();
    this.fleetPlanning = true;
    try {
      let result;
      if (input.nodes.length > 64 || request.items.length > 20) {
        // Large searches must not block relay traffic and router admission.
        result = await new Promise<ReturnType<typeof previewFleet>>((resolve, reject) => {
          const worker = new Worker(new URL('./fleet.worker.ts', import.meta.url).href);
          const timer = setTimeout(() => { worker.terminate(); reject(new Error('Planning exceeded 20 seconds. Select a smaller deployment batch.')); }, 20000);
          const finish = () => { clearTimeout(timer); worker.terminate(); };
          worker.onmessage = event => { finish(); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result); };
          worker.onerror = event => { finish(); reject(new Error(event.message)); };
          worker.postMessage({ request, input });
        });
      } else result = previewFleet(request, input);
      if (this.closed || result.revision !== fleetRevision(this.fleetInput())) throw new Error('Fleet changed during planning. Preview again.');
      const timestamp = new Date().toISOString();
      const run: FleetRun = { ...result, id: newId('fleet'), request, status: 'preview', createdAt: timestamp, updatedAt: timestamp };
      this.deps.reg.saveFleetRun(run); return run;
    } finally { this.fleetPlanning = false; }
  }

  private assertFleetAccess(token?: symbol): void {
    if (this.fleetToken && token !== this.fleetToken) throw new Error('Fleet allocation is applying; wait for its result before changing deployments.');
  }

  private validateFleetPlans(run: FleetRun): void {
    const input = this.fleetInput(), selected = new Set(run.entries.map(e => e.deploymentId));
    const reserved: ResourceLedger = reservedResources(input.deployments, input.assignments, input.nodes, selected);
    for (const entry of run.entries) {
      if (!entry.spec || !entry.plan || entry.error) throw new Error('Every selected deployment needs a valid plan.');
      const profile = this.deps.profiles.get(entry.spec.profile); if (!profile) throw new Error('Model profile changed; preview again.');
      const plan = planWithResources({ spec: entry.spec, profile, nodes: input.nodes, reserved, usedPorts: new Map() });
      addAllocations(reserved, plan.allocations!);
    }
    const errors = hostMemoryErrors(input, run.entries, selected); if (errors.length) throw new Error(errors.join(' '));
  }

  applyAllocation(id: string): FleetRun {
    const run = this.deps.reg.fleetRun(id); if (!run) throw new Error('Allocation preview not found. Preview again.');
    if (run.status !== 'preview') return run; // Repeated requests never start a second apply.
    if (this.closed || this.fleetToken || this.fleetPlanning || this.updatingNode() || this.operations.size || this.distributionApplications.size || this.reconnecting.size) throw new Error('Another deployment or node operation is in progress. Retry when it finishes.');
    if (!run.canApply || Date.now() - Date.parse(run.createdAt) > 10 * 60000) throw new Error('This preview is invalid or expired. Preview again.');
    if (run.revision !== fleetRevision(this.fleetInput())) throw new Error('Nodes, offers or deployments changed since this preview. Preview again.');
    if (run.entries.some(e => (this.inflight.get(e.deploymentId) ?? 0) > 0)) throw new Error('Selected deployments have active requests. Wait for them to finish before applying.');
    this.validateFleetPlans(run);
    const token = Symbol('fleet-apply'); this.fleetToken = token;
    run.status = 'applying'; run.updatedAt = new Date().toISOString();
    for (const entry of run.entries) entry.phase = 'queued';
    try {
      this.deps.reg.db.transaction(() => {
        this.deps.reg.saveFleetRun(run);
        // Withdraw every selected route atomically with admission, before any await.
        for (const entry of run.entries) this.deps.reg.updateDeployment(entry.deploymentId, { state: 'draining', endpoint: null });
      })();
    } catch (error) { this.fleetToken = null; throw error; }
    void this.performAllocation(run, token).catch(error => this.deps.log.error("allocation persistence failed", { id: run.id, error: String(error) }));
    return run;
  }

  private async performAllocation(run: FleetRun, token: symbol): Promise<void> {
    const save = () => { if (!this.closed) { run.updatedAt = new Date().toISOString(); this.deps.reg.saveFleetRun(run); } };
    try {
      for (const entry of run.entries) entry.phase = 'stopping'; save();
      const stopped = await Promise.allSettled(run.entries.map(e => this.stop(e.deploymentId, token)));
      const failed = stopped.find(r => r.status === 'rejected');
      if (failed?.status === 'rejected') throw new Error(`Cleanup was not acknowledged: ${String(failed.reason)}. Original specifications retained.`);
      if (this.closed) return;
      this.validateFleetPlans(run); // Offers and actual free memory may have changed.
      this.deps.reg.applyFleetSpecs(run.entries.map(e => ({ deploymentId: e.deploymentId, spec: e.spec! })));
      let next = 0;
      // Bounded concurrent loads; each plan reserves capacity before dispatching.
      await Promise.all(Array.from({ length: Math.min(4, run.entries.length) }, async () => {
        while (!this.closed && next < run.entries.length) {
          const entry = run.entries[next++]!; entry.phase = 'starting'; save();
          try { await this.start(entry.deploymentId, false, token); entry.phase = 'ready'; }
          catch (error) { entry.phase = 'failed'; entry.error = String(error); }
          save();
        }
      }));
      if (this.closed) return;
      run.status = run.entries.every(e => e.phase === 'ready') ? 'succeeded' : 'partial';
    } catch (error) {
      if (this.closed) return;
      run.status = 'partial'; run.error = String(error);
      for (const entry of run.entries) if (entry.phase !== 'ready' && entry.phase !== 'failed') { entry.phase = 'failed'; entry.error = run.error; }
    } finally {
      try { save(); } finally { if (this.fleetToken === token) this.fleetToken = null; }
    }
  }

  private distributionSpec(id: string, value: unknown): DeploymentSpec {
    const dep = this.must(id);
    if (dep.spec.allocations) throw new Error('Use Fleet allocation to change a deployment with shared resource budgets.');
    if (dep.spec.kind !== "split") throw new Error("Layer distribution requires a split deployment.");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A layer distribution is required.");
    const d = value as Record<string, unknown>;
    if (Object.keys(d).some(k => !["coordinatorNodeId", "workerNodeIds", "workerLayers"].includes(k)) ||
        typeof d.coordinatorNodeId !== "string" || !d.coordinatorNodeId || !Array.isArray(d.workerNodeIds) || !Array.isArray(d.workerLayers)) {
      throw new Error("Distribution needs coordinatorNodeId, workerNodeIds and workerLayers only.");
    }
    return { ...dep.spec, coordinatorNodeId: d.coordinatorNodeId, workerNodeIds: [...d.workerNodeIds] as string[], workerLayers: [...d.workerLayers] as number[] };
  }

  saveDistribution(id: string, value: unknown): { deployment: Deployment; plan: Plan } {
    this.assertFleetAccess();
    if (this.closed || this.distributionApplications.has(id)) throw new Error("Distribution apply is in progress; retry after it finishes.");
    const spec = this.distributionSpec(id, value);
    const plan = this.plan(spec, this.usedPorts(), id);
    this.deps.reg.saveDistribution(id, { coordinatorNodeId: spec.coordinatorNodeId!, workerNodeIds: spec.workerNodeIds!, workerLayers: spec.workerLayers! });
    this.deps.reg.event("deployment", "layer distribution saved; active placement unchanged", { deploymentId: id });
    return { deployment: this.must(id), plan };
  }

  /** Admission is synchronous; reloading follows the existing asynchronous Start API. */
  applyDistribution(id: string): { accepted: true; id: string } {
    this.assertFleetAccess();
    if (this.closed || this.distributionApplications.has(id) || this.operations.has(id)) throw new Error("Deployment operation already in progress.");
    if (this.inflight.get(id)) throw new Error("Deployment has active requests; wait for them to finish before applying.");
    const spec = this.distributionSpec(id, this.must(id).savedDistribution);
    this.plan(spec, this.usedPorts(), id); // Reject invalid/offline/over-capacity layouts before stopping anything.
    this.distributionApplications.add(id);
    void (async () => {
      const stopping = this.stop(id);
      const generation = this.generations.get(id);
      await stopping;
      if (this.closed) throw new Error("Control is shutting down; saved distribution retained.");
      if (generation !== this.generations.get(id)) throw new Error("Apply cancelled by another deployment operation; saved distribution retained.");
      this.plan(spec, this.usedPorts(), id); // Offers may have changed during teardown.
      this.deps.reg.applyDistributionSpec(id, spec);
      await this.start(id);
    })().catch((error: unknown) => {
      if (this.deps.reg.getDeployment(id)) {
        this.deps.reg.updateDeployment(id, { error: `Apply distribution: ${String(error)}` });
        this.deps.reg.event("deployment", `distribution apply failed: ${String(error)}`, { deploymentId: id });
      }
    }).finally(() => this.distributionApplications.delete(id));
    return { accepted: true, id };
  }

  async start(id: string, recovering = false, fleetToken?: symbol, opts: { abandonOfflineCleanup?: boolean; fromReady?: boolean } = {}): Promise<void> {
    this.assertFleetAccess(fleetToken);
    const dep = this.must(id);
    if (this.closed) throw new Error("control is shutting down");
    if (this.updatingNode()) throw new Error("node update in progress; retry after recovery");
    if (this.operations.has(id)) throw new Error("deployment operation already in progress");
    // A re-placement is the one caller allowed to restart a healthy deployment: the plan it is
    // replacing is its own, the route is withdrawn first, and teardown still proves the old engine
    // stopped before anything new starts. Every other caller keeps the stricter rule.
    const restartable = ["planned", "stopped", "failed"].includes(dep.state)
      || (recovering && this.reconnecting.has(id) && dep.state === "loading")
      || (opts.fromReady === true && ["ready", "placing", "loading"].includes(dep.state));
    if (!restartable) throw new Error(`cannot start from state ${dep.state}`);
    if (dep.spec.kind === "external") { this.assertExternalOptions(dep.spec); this.assertUniqueExternal(dep.spec, id); }
    this.reconnecting.delete(id);
    this.deps.reg.setDeploymentIntent(id, { running: true, ...(recovering ? {} : { attempts: 0, retryAt: 0 }) });
    const generation = this.generations.get(id) ?? 0;
    this.deps.reg.updateDeployment(id, { state: "placing", error: null, endpoint: null });
    return this.enqueue(id, async () => {
      try {
        // Starting tolerates cleanup it cannot prove on a node that is gone; stopping does not (a stop must
        // prove what it reports). Without this, one node leaving mid-teardown makes a deployment
        // unrestartable - every attempt refuses to proceed past an acknowledgement that cannot arrive.
        await this.teardown(id, { abandonOfflineCleanup: opts.abandonOfflineCleanup ?? true });
        this.assertRunning(id, generation);
        if (dep.spec.kind === "external") await this.startExternal(dep, generation);
        else if (dep.spec.kind === "replica") await this.startReplica(dep, generation);
        else if (dep.spec.kind === "stages" || dep.spec.kind === "prefill-decode") await this.startNative(dep, generation);
        else await this.startSplit(dep, generation);
      } catch (e) {
        if (!this.closed && generation === (this.generations.get(id) ?? 0)) {
          this.recordFailure(id, (e as Error).message);
          await this.teardown(id, { abandonOfflineCleanup: opts.abandonOfflineCleanup ?? true }).catch(() => {});
        }
        throw e;
      }
    });
  }

  async stop(id: string, fleetToken?: symbol): Promise<void> {
    this.assertFleetAccess(fleetToken);
    this.must(id);
    this.reconnecting.delete(id);
    // An explicit stop is the owner saying "start again from scratch": forget what crashed.
    this.blocked.delete(id);
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
  routing(): Array<{ modelName: string; created: number; deployments: Array<{ id: string; name: string; kind: string; nodeId: string; port: number; nodes: string[]; inflight: number; tokPerSec?: number; rttMs?: number }> }> {
    const byModel = new Map<string, Array<{ id: string; name: string; kind: string; nodeId: string; port: number; nodes: string[]; inflight: number; tokPerSec?: number; rttMs?: number }>>();
    const created = new Map<string, number>();
    for (const dep of this.deps.reg.listDeployments()) {
      if (dep.state !== "ready" || !dep.endpoint) continue;
      const node = this.deps.reg.getNode(dep.endpoint.nodeId);
      const list = byModel.get(dep.endpoint.modelName) ?? [];
      const nodes = dep.plan ? planNodes(dep.plan) : [dep.endpoint.nodeId];
      if (nodes.includes(this.updatingNode() ?? "")) continue;
      list.push({ id: dep.id, name: dep.spec.name, kind: dep.spec.kind, nodeId: dep.endpoint.nodeId, port: dep.endpoint.port, nodes, inflight: this.inflight.get(dep.id) ?? 0, tokPerSec: this.liveTokPerSec(dep.id), rttMs: node?.caps?.net?.rttMs });
      byModel.set(dep.endpoint.modelName, list);
      const registered = Math.floor(Date.parse(dep.createdAt) / 1000);
      created.set(dep.endpoint.modelName, Math.min(created.get(dep.endpoint.modelName) ?? registered, registered));
    }
    return [...byModel].map(([modelName, deployments]) => ({ modelName, created: created.get(modelName)!, deployments }));
  }

  trackInflight(id: string, delta: number): void { this.inflight.set(id, Math.max(0, (this.inflight.get(id) ?? 0) + delta)); }

  nativeExecution(id: string): { plan: NativeExecutionPlan; signal: AbortSignal } | null {
    const dep = this.deps.reg.getDeployment(id), lifetime = this.nativeLifetimes.get(id);
    if (dep?.state !== "ready" || !dep.plan?.nativeExecution || !lifetime || lifetime.signal.aborted) return null;
    return { plan: dep.plan.nativeExecution, signal: lifetime.signal };
  }

  async nativeExecutionFailed(id: string, reason: string, expectedLifetime?: AbortSignal): Promise<void> {
    if (expectedLifetime && this.nativeLifetimes.get(id)?.signal !== expectedLifetime) return;
    await this.fail(id, reason);
  }

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
    const plan = this.planFor(dep);
    this.deps.reg.updateDeployment(dep.id, { plan, state: "loading" });
    const node = this.node(plan.coordinatorNodeId);
    const port = this.freePort(node.id, serverPortBase(), this.usedPorts());
    // Same darwin fit gate as a split coordinator: the whole model plus the host part must be free before
    // llama-server launches, and stopExternal names the production server on that node the agent may stop for it.
    const externals = dep.spec.stopExternal ? this.deps.reg.listDeployments().filter((d) => d.spec.kind === "external" && d.spec.external?.nodeId === node.id) : [];
    const a: ReplicaAssignment = {
      kind: "replica", id: newId("as"), deploymentId: dep.id, port,
      model: { path: plan.modelPath }, modelName: profile.modelName,
      ctx: plan.ctx, parallel: plan.parallel, device: plan.coordinatorDevice,
      mtp: plan.chain > 0 && plan.mtpPath ? { path: plan.mtpPath, chain: plan.chain } : undefined,
      speculation: plan.speculation, extraArgs: profile.extraArgs, allow: [],
      enforce: plan.allocations?.find(a => a.nodeId === node.id),
      fitMiB: node.os === "darwin" ? (dep.spec.allocations ? plan.allocations?.find(a => a.nodeId === node.id)?.ramMiB : profile.layers * profile.layerMiB + profile.coordinatorHostMiB) : undefined,
      stopExternal: externals[0]?.spec.name,
    };
    await this.dispatch(node.id, a, ["ready"], COORDINATOR_TIMEOUT_MS);
    this.assertRunning(dep.id, generation);
    this.deps.reg.updateDeployment(dep.id, { state: "ready", endpoint: { nodeId: node.id, port, modelName: profile.modelName } });
    this.deps.reg.event("deployment", `ready (replica on ${node.hostname})`, { deploymentId: dep.id });
  }

  private async startNative(dep: Deployment, generation: number): Promise<void> {
    const profile = this.deps.profiles.get(dep.spec.profile)!;
    const plan = this.plan(dep.spec, this.usedPorts(), dep.id);
    if (!plan.nativeExecution) throw new Error("native execution plan missing");
    this.deps.reg.updateDeployment(dep.id, { plan, state: "loading" });
    const assignments = plan.nativeExecution.endpoints.map(e => ({ nodeId: e.nodeId, a: {
      kind: "stage", id: newId("as"), deploymentId: dep.id,
      model: { path: e.modelPath, sha256: e.identity.model_sha256 }, port: e.port,
      ctx: plan.ctx, gpuLayers: 999, identity: e.identity, binarySha256: e.binarySha256,
      fitMiB: e.fitMiB, allow: [], enforce: e.enforce,
    } satisfies StageAssignment }));
    // Start all resident contexts, then wait for every node's loaded-identity check.
    for (const { nodeId, a } of assignments) {
      this.assertRunning(dep.id, generation);
      if (!this.deps.channel.assign(nodeId, a)) throw new Error(`node ${nodeId} is offline`);
    }
    await Promise.all(assignments.map(({ a }) => this.waitFor(a.id, ["ready"], COORDINATOR_TIMEOUT_MS)));
    this.assertRunning(dep.id, generation);
    const first = plan.nativeExecution.endpoints[0]!;
    this.nativeLifetimes.set(dep.id, new AbortController());
    this.deps.reg.updateDeployment(dep.id, { state: "ready", endpoint: { nodeId: first.nodeId, port: first.port, modelName: profile.modelName } });
    this.deps.reg.event("deployment", `ready (${dep.spec.kind}: ${assignments.map(a => this.node(a.nodeId).hostname).join(" > ")})`, { deploymentId: dep.id });
  }

  private async startSplit(dep: Deployment, generation: number): Promise<void> {
    const profile = this.deps.profiles.get(dep.spec.profile)!;
    const used = this.usedPorts();
    const plan = this.planFor(dep);
    this.deps.reg.updateDeployment(dep.id, { plan });
    const coord = this.node(plan.coordinatorNodeId);
    const workers = plan.workers.map((w) => ({ w, node: this.node(w.nodeId) }));
    const relayOnly = dep.spec.transport === "relay";
    // Reverse dial is behind a switch while its pairing is unproven end to end: with it on, a worker
    // offers inbound streams and the coordinator prefers them, and the engine currently fails to
    // complete a load on them (see docs/reports). Default off keeps every split on the relay it had
    // before; set SWARMLET_REVERSE_DIAL=1 to exercise the path.
    const reverseDial = process.env.SWARMLET_REVERSE_DIAL === "1";
    const endpointFor = (node: NodeRow, port: number): Endpoint => ({
      nodeId: node.id, certFp: node.certFp, port,
      direct: relayOnly ? [] : [
        ...(node.caps?.privateIps ?? []).map((host) => ({ host, port: node.caps?.dataPort ?? AGENT_DATA_PORT })),
        ...(node.caps?.publicIp ? [{ host: node.caps.publicIp, port: node.caps.dataPort ?? AGENT_DATA_PORT }] : []),
        // A node behind a router nobody here administers can still be dialled directly: it asked its
        // own gateway for a mapping (node-agent/nat.ts). These come last so a peer on the same LAN
        // never leaves it, and they carry their own port because the router picks the external one.
        ...(node.caps?.publicEndpoints ?? [])
          .filter((e) => e && typeof e.host === "string" && e.host.length > 0 && Number.isInteger(e.port) && e.port > 0 && e.port < 65536)
          .map((e) => ({ host: e.host, port: e.port })),
      ],
      relay: true,
    });
    // workers first, in ring order; worker i pushes to worker i+1 (peerPort) when forwarding is on
    const assignments: Array<{ nodeId: string; a: WorkerAssignment }> = workers.map(({ w, node }, i) => {
      const next = workers[i + 1];
      const prev = workers[i - 1];
      const allow = [coord.certFp, ...(prev ? [prev.node.certFp] : [])];
      const peers = next && w.peerPort && next.w.peerPort ? [{ index: i + 1, endpoint: endpointFor(next.node, next.w.peerPort) }] : undefined;
      const allocation = plan.allocations?.find(a => a.nodeId === node.id);
      // Offer the worker a reverse path to the coordinator. Set unconditionally rather than trying to
      // detect reachability at plan time: control cannot know which of the coordinator's addresses the
      // worker can reach, and an unused offer costs the worker a few idle sockets while a missing one
      // costs the whole ring its direct path.
      const serve = reverseDial ? endpointFor(coord, w.port) : undefined;
      const a: WorkerAssignment = { kind: "worker", id: newId("as"), deploymentId: dep.id, port: w.port, device: w.device, threads: w.threads, memCapMiB: w.memCapMiB, peerPort: w.peerPort, peers, allow, serve, enforce: { ramMiB: allocation?.ramMiB ?? node.offer?.ramMiB, cpuCores: allocation?.cpuCores ?? node.offer?.cpuCores }, layers: w.layers, modelLayers: profile.layers };
      return { nodeId: node.id, a };
    });
    for (const { nodeId, a } of assignments) { if (!this.deps.channel.assign(nodeId, a)) throw new Error(`node ${nodeId} is offline`); }
    await Promise.all(assignments.map(({ a }) => this.waitFor(a.id, ["listening"], WORKER_TIMEOUT_MS)));
    this.assertRunning(dep.id, generation);
    this.deps.reg.updateDeployment(dep.id, { state: "loading" });
    const coordLayers = plan.tensorSplit[plan.tensorSplit.length - 1] ?? 0;
    const externals = dep.spec.stopExternal ? this.deps.reg.listDeployments().filter((d) => d.spec.kind === "external" && d.spec.external?.nodeId === coord.id) : [];
    const port = this.freePort(coord.id, serverPortBase(), this.usedPorts());
    const c: CoordinatorAssignment = {
      kind: "coordinator", id: newId("as"), deploymentId: dep.id, model: { path: plan.modelPath },
      // Marked inbound: each worker was given a serve target, so these addresses are only a fallback.
      rpc: workers.map(({ w, node }) => ({ ...endpointFor(node, w.port), inbound: reverseDial })), devices: [...workers.map((_, i) => `RPC${i}`), plan.coordinatorDevice],
      tensorSplit: plan.engineTensorSplit ?? plan.tensorSplit, ctx: plan.ctx, parallel: plan.parallel,
      mtp: plan.chain > 0 && plan.mtpPath ? { path: plan.mtpPath, chain: plan.chain } : undefined,
      speculation: plan.speculation,
      env: plan.engineTensorSplit ? { ...plan.env, LLAMA_ARG_LOG_VERBOSITY: "4" } : plan.env,
      extraArgs: profile.extraArgs, port, modelName: profile.modelName,
      fitMiB: coord.os === "darwin" ? (dep.spec.allocations ? plan.allocations!.find(a => a.nodeId === coord.id)!.ramMiB : coordLayers * profile.layerMiB + profile.coordinatorHostMiB) : undefined,
      stopExternal: externals[0]?.spec.name, allow: [], enforce: { ramMiB: plan.allocations?.find(a => a.nodeId === coord.id)?.ramMiB ?? coord.offer?.ramMiB, cpuCores: plan.allocations?.find(a => a.nodeId === coord.id)?.cpuCores ?? coord.offer?.cpuCores },
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

  private observeReconnect(id: string): void {
    const reconnect = this.reconnecting.get(id);
    if (!reconnect || reconnect.cleanupDeadline !== undefined || Date.now() >= reconnect.deadline) return;
    if (reconnect.nodes.some(n => !this.deps.channel.isOnline(n) || !this.deps.reg.getNode(n)?.online)) return;
    // Reconnection met its deadline. Existing sequential stop acknowledgements have their
    // own bounded budget; a slow clean shutdown must not be mislabeled as a missing node.
    // Set this once, so later flaps cannot extend recovery indefinitely.
    const pending = this.deps.reg.listAssignments(id).filter(a => a.state !== "stopped").length;
    reconnect.cleanupDeadline = Date.now() + Math.max(1, pending) * (this.deps.stopTimeoutMs ?? STOP_TIMEOUT_MS);
  }

  private recordFailure(id: string, why: string): void {
    this.reconnecting.delete(id);
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

  private async teardown(id: string, opts: { abandonOfflineCleanup?: boolean } = {}): Promise<void> {
    if (this.closed) throw new Error("control is shutting down");
    const rows = this.deps.reg.listAssignments(id).filter((r) => r.state !== "stopped");
    // coordinator first (it holds the client sockets), then workers
    const order = [...rows.filter((r) => r.body.kind === "coordinator"), ...rows.filter((r) => r.body.kind !== "coordinator")];
    for (const r of order) {
      this.deps.reg.retireAssignment(r.id);
      const stop: Assignment = { kind: "stop", id: r.body.id, deploymentId: id };
      this.deps.channel.send(r.nodeId, { t: "assign", assignment: stop });
      // An offline node cannot answer, so its cleanup can never be proven - and a re-placement must not
      // be blocked forever by that. The assignment is already retired, so control reissues the stop the
      // moment the node reconnects; until then its route is withdrawn and it serves nothing. Everything
      // that CAN answer is still waited for, unchanged: no second engine on a node we can reach.
      if (opts.abandonOfflineCleanup && !this.deps.channel.isOnline(r.nodeId)) {
        const host = this.deps.reg.getNode(r.nodeId)?.hostname ?? r.nodeId;
        this.deps.log.info("abandoning cleanup on an offline node for a re-placement", { deploymentId: id, nodeId: r.nodeId });
        this.deps.reg.event("deployment", `${host} is offline; its cleanup is unprovable, retired and will be stopped on reconnect`, { deploymentId: id });
        continue;
      }
      // Offline nodes may reconnect inside this budget. Hello reissues the stop or confirms
      // absence; a failed send is not grounds to skip waiting for that acknowledgement.
      // A failed engine can still own ports or have cleanup in progress. Only stopped/hello absence proves release.
      await this.waitFor(r.id, ["stopped"], this.deps.stopTimeoutMs ?? STOP_TIMEOUT_MS, false).catch(() => {});
      if (this.closed) throw new Error("control is shutting down");
    }
    const pending = this.deps.reg.listAssignments(id).filter((r) => r.state !== "stopped"
      && !(opts.abandonOfflineCleanup && !this.deps.channel.isOnline(r.nodeId)));
    if (pending.length) throw new Error(`cleanup pending acknowledgement: ${pending.map((r) => r.id).join(", ")}`);
  }

  // ---------- helpers ----------

  private assertExternalOptions(spec: DeploymentSpec): void {
    if (spec.workerLayers !== undefined || spec.speculation !== undefined || (spec.chain !== undefined && spec.chain !== 0)) {
      throw new Error("external deployments cannot configure workerLayers, speculation or an MTP chain");
    }
  }

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
    this.nativeLifetimes.get(id)?.abort(new Error("native deployment retired"));
    this.nativeLifetimes.delete(id);
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    for (const row of this.deps.reg.listAssignments(id)) {
      for (const w of [...(this.waiters.get(row.id) ?? [])]) w("failed", "deployment operation cancelled");
    }
  }

  private assertRunning(id: string, generation: number): void {
    if (this.closed || !this.deps.reg.deploymentIntent(id).running || generation !== (this.generations.get(id) ?? 0)) throw new Error("deployment operation cancelled");
  }

  private plan(spec: DeploymentSpec, usedPorts: Map<string, Set<number>>, replacingId?: string, opts: { exclude?: Set<string> } = {}): Plan {
    const profile = this.deps.profiles.get(spec.profile);
    if (!profile) throw new Error(`unknown profile ${spec.profile}`);
    try {
      const input = this.fleetInput();
      // A node that just failed to hold this deployment is not a candidate again: excluding it is what
      // turns a failed move back into a placement that works, and what stops the ordinary recovery from
      // walking into the same node it just bounced off.
      const remembered = replacingId ? this.moveExcluded.get(replacingId) : undefined;
      const fresh = !!remembered && Date.now() - remembered.at <= 10 * 60_000;
      if (remembered && !fresh) this.moveExcluded.delete(replacingId!);
      const exclude = new Set<string>([...(opts.exclude ?? []), ...(fresh ? remembered!.nodes : [])]);
      const nodes = exclude.size ? input.nodes.filter((n) => !exclude.has(n.id)) : input.nodes;
      const reserved = reservedResources(input.deployments, input.assignments, input.nodes, new Set(replacingId ? [replacingId] : []));
      return planWithResources({ spec, profile, nodes, reserved, usedPorts, nativeQualifications: this.deps.nativeQualifications });
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
      if (b.kind === "coordinator" || b.kind === "replica" || b.kind === "stage") s.add(b.port);
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
      const remove = () => {
        const l = this.waiters.get(assignmentId);
        if (!l) return;
        const i = l.indexOf(cb); if (i >= 0) l.splice(i, 1);
        if (!l.length) this.waiters.delete(assignmentId);
      };
    });
  }
}
