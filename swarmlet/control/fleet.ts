// Bounded, deterministic multi-deployment placement. Scores compare resource fit
// and network/contention costs; they are deliberately not predicted tokens/sec.
import { createHash } from 'node:crypto';
import type { Deployment, DeploymentSpec, ModelProfile, NodeAllocation, Plan } from '../protocol/types.ts';
import type { AssignmentRow, NodeRow } from './registry.ts';
import { MAX_WORKER_THREADS, planDeployment } from './planner.ts';
import { addAllocations, availableNodes, copyLedger, minimumAllocations, planNodeIds, planWithResources, reservedResources, type ResourceLedger } from './resources.ts';

export interface FleetPlacement {
  kind: 'replica' | 'split'; replicaNodeId?: string; coordinatorNodeId?: string; workerNodeIds?: string[]; workerLayers?: number[];
}
export interface FleetItem { deploymentId: string; mode: 'balanced' | 'keep' | 'manual'; cpuCores?: number; placement?: FleetPlacement }
export interface FleetRequest { items: FleetItem[]; poolNodeIds: string[] }
export interface FleetEntry {
  deploymentId: string; name: string; before: FleetPlacement; spec?: DeploymentSpec; plan?: Plan;
  score?: number; networkRttMs?: number; reasons: string[]; error?: string;
  phase?: 'queued' | 'stopping' | 'starting' | 'ready' | 'failed';
}
export interface FleetPreview {
  revision: string; entries: FleetEntry[]; canApply: boolean; plannedCount: number; selectedCount: number;
  allocations: NodeAllocation[]; warnings: string[]; evaluatedCandidates: number;
}
export interface FleetRun extends FleetPreview {
  id: string; request: FleetRequest; createdAt: string; updatedAt: string;
  status: 'preview' | 'applying' | 'succeeded' | 'partial' | 'interrupted'; error?: string;
}
export interface FleetInput { nodes: NodeRow[]; deployments: Deployment[]; assignments: AssignmentRow[]; profiles: Map<string, ModelProfile>; now?: number }
const keys = (value: object, allowed: string[]) => Object.keys(value).every(k => allowed.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;

export function parseFleetRequest(value: unknown): FleetRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !keys(value, ['items', 'poolNodeIds'])) throw new Error('A fleet request needs items and poolNodeIds.');
  const v = value as FleetRequest;
  if (!Array.isArray(v.items) || !v.items.length || v.items.length > 500 || !Array.isArray(v.poolNodeIds) || !v.poolNodeIds.length || v.poolNodeIds.length > 2000 || v.poolNodeIds.some(n => !id(n)) || new Set(v.poolNodeIds).size !== v.poolNodeIds.length) throw new Error('Choose 1–500 deployments and 1–2000 distinct pool nodes.');
  const seen = new Set<string>();
  for (const item of v.items) {
    if (!item || typeof item !== 'object' || !keys(item, ['deploymentId', 'mode', 'cpuCores', 'placement']) || !id(item.deploymentId) || seen.has(item.deploymentId) || !['balanced', 'keep', 'manual'].includes(item.mode)) throw new Error('Invalid or duplicate deployment selection.');
    seen.add(item.deploymentId);
    if (item.cpuCores !== undefined && (!Number.isSafeInteger(item.cpuCores) || item.cpuCores < 1 || item.cpuCores > 65536)) throw new Error('CPU budget must be a positive integer.');
    if (item.mode === 'manual') {
      const p = item.placement;
      if (!p || typeof p !== 'object' || !keys(p, ['kind', 'replicaNodeId', 'coordinatorNodeId', 'workerNodeIds', 'workerLayers']) || !['replica', 'split'].includes(p.kind)) throw new Error('Manual placement needs replica or split settings.');
      if (p.kind === 'replica' && (!id(p.replicaNodeId) || p.coordinatorNodeId !== undefined || p.workerNodeIds !== undefined || p.workerLayers !== undefined)) throw new Error('Replica placement needs only a replica node.');
      if (p.kind === 'split' && (!id(p.coordinatorNodeId) || p.replicaNodeId !== undefined || !Array.isArray(p.workerNodeIds) || !p.workerNodeIds.length || p.workerNodeIds.length > 1000 || p.workerNodeIds.some(n => !id(n)) || new Set(p.workerNodeIds).size !== p.workerNodeIds.length)) throw new Error('Split placement needs a coordinator and distinct workers.');
      if (p.workerLayers !== undefined && (!Array.isArray(p.workerLayers) || p.workerLayers.length !== p.workerNodeIds?.length || p.workerLayers.some(n => !Number.isSafeInteger(n) || n < 1))) throw new Error('Layer counts must match the worker list.');
    } else if (item.placement !== undefined) throw new Error('Placement overrides require manual mode.');
  }
  return structuredClone(v);
}

export function currentPlacement(dep: Deployment): FleetPlacement {
  if (dep.spec.kind === 'replica') return { kind: 'replica', replicaNodeId: dep.plan?.coordinatorNodeId ?? dep.spec.replicaNodeId };
  return { kind: 'split', coordinatorNodeId: dep.plan?.coordinatorNodeId ?? dep.spec.coordinatorNodeId,
    workerNodeIds: dep.plan?.workers.map(w => w.nodeId) ?? dep.spec.workerNodeIds,
    // Preserve historical automatic tensor weights unless the spec explicitly opted into exact counts.
    ...(dep.spec.workerLayers ? { workerLayers: dep.spec.workerLayers } : {}) };
}
export function placementSpec(base: DeploymentSpec, placement: FleetPlacement): DeploymentSpec {
  const { coordinatorNodeId, replicaNodeId, workerNodeIds, workerLayers, allocations, ...rest } = base;
  return { ...rest, ...placement };
}

/** Structural revision deliberately excludes transient throughput and heartbeat timestamps. */
export function fleetRevision(input: FleetInput): string {
  const body = {
    nodes: [...input.nodes].sort((a, b) => a.id.localeCompare(b.id)).map(n => ({ id: n.id, online: n.online, offer: n.offer,
      caps: n.caps ? { allocationVersion: n.caps.allocationVersion, os: n.caps.os, gpus: n.caps.gpus.map(g => ({ id: g.id, engineName: g.engineName, totalMiB: g.totalMiB })), engine: n.caps.engine } : null,
      models: n.models.map(m => ({ path: m.path, sizeBytes: m.sizeBytes, sha256: m.sha256 })).sort((a, b) => a.path.localeCompare(b.path)) })),
    deployments: [...input.deployments].sort((a, b) => a.id.localeCompare(b.id)).map(d => ({ id: d.id, spec: d.spec, state: d.state, plan: d.plan, savedDistribution: d.savedDistribution })),
    assignments: input.assignments.filter(a => a.state !== 'stopped').map(a => ({ id: a.id, nodeId: a.nodeId, deploymentId: a.deploymentId, retired: a.retired, body: a.body })).sort((a, b) => a.id.localeCompare(b.id)),
    profiles: [...input.profiles.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
function rtt(node: NodeRow, now: number): number | undefined {
  const m = node.metrics?.link ?? node.caps?.net;
  return m && Number.isFinite(m.rttMs) && m.rttMs >= 0 && now - Date.parse(m.measuredAt) < 3600000 ? m.rttMs : undefined;
}
function modelOn(node: NodeRow, profile: ModelProfile): boolean {
  const pattern = new RegExp(profile.ggufPattern);
  return node.models.some(m => m.kind === 'gguf' && pattern.test(m.name));
}
function gpuMemory(node: NodeRow): number { return Math.max(0, ...(node.offer?.gpu.map(g => g.memMiB) ?? [])); }
function usedPorts(assignments: AssignmentRow[], exclude: Set<string>): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const a of assignments) {
    if (a.state === 'stopped' || exclude.has(a.deploymentId)) continue;
    const body = a.body; if (!('port' in body)) continue;
    const ports = result.get(a.nodeId) ?? new Set<number>(); ports.add(body.port);
    if (body.kind === 'worker' && body.peerPort) ports.add(body.peerPort);
    result.set(a.nodeId, ports);
  }
  return result;
}
function occupyPorts(ports: Map<string, Set<number>>, plan: Plan): void {
  for (const w of plan.workers) { const p = ports.get(w.nodeId) ?? new Set<number>(); p.add(w.port); if (w.peerPort) p.add(w.peerPort); ports.set(w.nodeId, p); }
}

/** Fresh host memory is an additional admission bound, not a source of invented
 * free capacity. Only this agent's observed RSS can be reclaimed by replacing its
 * selected deployments; unselected reservations are charged separately. */
export function hostMemoryErrors(input: FleetInput, entries: FleetEntry[], selected: Set<string>): string[] {
  const totals: ResourceLedger = new Map();
  for (const entry of entries) if (entry.plan?.allocations) addAllocations(totals, entry.plan.allocations);
  const outside = reservedResources(input.deployments, input.assignments, input.nodes, selected);
  const selectedReservations = reservedResources(input.deployments.filter(d => selected.has(d.id)), input.assignments.filter(a => selected.has(a.deploymentId)), input.nodes);
  const errors: string[] = [], now = input.now ?? Date.now();
  for (const [id, value] of totals) {
    const node = input.nodes.find(n => n.id === id)!; const metrics = node.metrics;
    if (!metrics || !Number.isFinite(Date.parse(metrics.ts)) || now - Date.parse(metrics.ts) > 15000) continue;
    for (const gpu of value.gpu) {
      const device = node.caps?.gpus.find(g => g.id === gpu.id);
      const observed = metrics.gpu?.find(g => g.id === gpu.id);
      if (!device || !observed || !Number.isFinite(observed.usedMiB)) continue;
      // A reservation is not measured GPU usage attributable to a selected process.
      const available = Math.max(0, device.totalMiB - observed.usedMiB);
      if (gpu.memMiB > available) errors.push(`${node.hostname}: ${gpu.id} needs ${gpu.memMiB} MiB; current measured GPU availability is only ${Math.floor(available)} MiB.`);
    }
    if (!Number.isFinite(metrics.freeRamMiB)) continue;
    // Shared Linux file-backed pages / GPU host staging vary by model. OS fit checks
    // remain authoritative; this bound is particularly important for unified RAM.
    if (node.os !== 'darwin') continue;
    const hasSelected = input.assignments.some(a => a.nodeId === id && selected.has(a.deploymentId) && a.state !== 'stopped' && !(a.body.kind === 'replica' && a.body.external));
    const reclaim = hasSelected ? Math.min(selectedReservations.get(id)?.ramMiB ?? 0, Math.max(0, metrics.rssMiB ?? 0)) : 0;
    const future = value.ramMiB + (outside.get(id)?.ramMiB ?? 0);
    const available = Math.min(node.offer!.ramMiB, Math.max(0, metrics.freeRamMiB!) + reclaim);
    if (future > available) errors.push(`${node.hostname}: plan needs ${future} MiB RAM; current free RAM plus reclaimable agent RSS is only ${Math.floor(available)} MiB.`);
  }
  return errors;
}

export function previewFleet(request: FleetRequest, input: FleetInput): FleetPreview {
  const now = input.now ?? Date.now(), selected = new Set(request.items.map(i => i.deploymentId)), pool = new Set(request.poolNodeIds);
  const deploymentById = new Map(input.deployments.map(d => [d.id, d]));
  for (const id of selected) if (!deploymentById.has(id)) throw new Error(`Unknown deployment ${id}.`);
  for (const id of pool) if (!input.nodes.some(n => n.id === id)) throw new Error(`Unknown pool node ${id}.`);
  const baseline = reservedResources(input.deployments, input.assignments, input.nodes, selected);
  const poolNodes = input.nodes.filter(n => pool.has(n.id) && n.online && n.offer?.enabled && n.caps?.allocationVersion === 1);
  const scarcity = (item: FleetItem) => {
    const profile = input.profiles.get(deploymentById.get(item.deploymentId)!.spec.profile);
    return profile ? poolNodes.filter(n => modelOn(n, profile)).length : 0;
  };
  const order = [...request.items].sort((a, b) => Number(b.mode !== 'balanced') - Number(a.mode !== 'balanced') || scarcity(a) - scarcity(b) ||
    (input.profiles.get(deploymentById.get(b.deploymentId)!.spec.profile)?.layerMiB ?? 0) - (input.profiles.get(deploymentById.get(a.deploymentId)!.spec.profile)?.layerMiB ?? 0) || a.deploymentId.localeCompare(b.deploymentId));
  let evaluatedCandidates = 0;
  let best: { entries: FleetEntry[]; ledger: ResourceLedger; score: number; count: number } | undefined;
  // Bounded CPU-sharing budgets include a one-core fallback. Prefer complete plans, then lower
  // balanced cost; do not starve a deployment merely to improve another's score.
  for (const sharing of [...new Set([1, 2, 4, Math.max(1, request.items.length)])]) {
    const ledger = copyLedger(baseline), ports = usedPorts(input.assignments, selected), entries: FleetEntry[] = [];
    for (const item of order) {
      const dep = deploymentById.get(item.deploymentId)!, profile = input.profiles.get(dep.spec.profile);
      const entry: FleetEntry = { deploymentId: dep.id, name: dep.spec.name, before: currentPlacement(dep), reasons: [] };
      entries.push(entry);
      if (!profile || !['split', 'replica'].includes(dep.spec.kind)) { entry.error = 'External and qualified native deployments keep their existing placement; select replicas or splits.'; continue; }
      if (dep.spec.stopExternal) { entry.error = 'This deployment requires external-service maintenance. Complete that maintenance separately before fleet allocation.'; continue; }
      const free = availableNodes(poolNodes, ledger).filter(n => n.offer?.enabled);
      let winner: { spec: DeploymentSpec; plan: Plan; score: number; networkRttMs?: number; reasons: string[] } | undefined;
      const failures = new Set<string>();
      const attempt = (placement: FleetPlacement, cpuOnly = false) => {
        evaluatedCandidates++;
        try {
          const spec = placementSpec(dep.spec, placement);
          const ids = new Set([placement.replicaNodeId ?? placement.coordinatorNodeId!, ...(placement.workerNodeIds ?? [])]);
          if ([...ids].some(id => !pool.has(id))) throw new Error('Every assigned node must be in the selected hardware pool.');
          const nodes = free.filter(n => ids.has(n.id)).map(n => cpuOnly && n.id === (placement.replicaNodeId ?? placement.coordinatorNodeId) ? { ...n, offer: { ...n.offer!, gpu: [] }, caps: n.caps ? { ...n.caps, gpus: [] } : null } : n);
          const base = planDeployment({ spec, profile, nodes, usedPorts: ports });
          const minima = minimumAllocations(base, profile, nodes);
          spec.allocations = minima.map(a => {
            const n = nodes.find(n => n.id === a.nodeId)!;
            const cpuCores = item.cpuCores ?? Math.max(1, Math.min(n.offer!.cpuCores, base.workers.some(w => w.nodeId === a.nodeId) ? MAX_WORKER_THREADS : n.offer!.cpuCores, Math.floor((input.nodes.find(x => x.id === n.id)!.offer!.cpuCores) / sharing)));
            const round = (v: number) => Math.ceil(v / 64) * 64;
            return { ...a, cpuCores, ramMiB: Math.min(n.offer!.ramMiB, round(a.ramMiB * 1.2)), gpu: a.gpu.map(g => ({ id: g.id, memMiB: Math.min(n.offer!.gpu.find(v => v.id === g.id)!.memMiB, round(g.memMiB * 1.1)) })) };
          });
          const plan = planWithResources({ spec, profile, nodes: input.nodes, reserved: ledger, usedPorts: ports });
          const budget = plan.allocations!;
          let pressure = 0, contention = 0, cpuPenalty = 0;
          for (const a of budget) {
            const n = input.nodes.find(n => n.id === a.nodeId)!, used = ledger.get(a.nodeId);
            pressure += 15 * Math.pow((a.ramMiB + (used?.ramMiB ?? 0)) / n.offer!.ramMiB, 2);
            pressure += a.gpu.reduce((sum, g) => sum + 15 * Math.pow((g.memMiB + (used?.gpu.find(v => v.id === g.id)?.memMiB ?? 0)) / n.offer!.gpu.find(v => v.id === g.id)!.memMiB, 2), 0);
            if (used?.cpuCores) contention += 10;
            cpuPenalty += 12 * (1 - a.cpuCores / n.offer!.cpuCores);
          }
          const times = planNodeIds(plan).map(id => rtt(input.nodes.find(n => n.id === id)!, now));
          const known = times.every(t => t !== undefined), networkRttMs = known ? times.reduce<number>((sum, t) => sum + t!, 0) : undefined;
          const network = plan.workers.length * 12 + times.reduce<number>((sum, t) => sum + Math.min(t ?? 100, 1000) / 10, 0);
          const same = JSON.stringify(placement) === JSON.stringify(entry.before);
          const score = pressure + contention + cpuPenalty + network + (plan.coordinatorDevice === 'CPU' ? 60 : 0) + (same ? 0 : 3);
          const reasons = [plan.workers.length ? `${plan.workers.length} worker hop${plan.workers.length === 1 ? '' : 's'}; only qualified layer counts used.` : 'Whole model on one node avoids inter-node token transfers.',
            `${budget.reduce((s, a) => s + a.cpuCores, 0)} CPU cores budgeted across ${budget.length} node${budget.length === 1 ? '' : 's'}; all concurrent reservations fit.`,
            known ? `${Math.round(networkRttMs!)} ms total measured RTT to the controller; used as a network ranking signal.` : 'Some network measurements are unavailable or stale; ranking includes an uncertainty penalty.',
            contention ? 'Shares hardware with other deployments within their budgets.' : 'Avoids already-reserved compute capacity.'];
          if (!winner || score < winner.score) {
            const pressureErrors = hostMemoryErrors(input, [...entries.filter(e => e.plan), { ...entry, plan }], selected);
            if (pressureErrors.length) throw new Error(pressureErrors.join(' '));
            winner = { spec, plan, score, networkRttMs, reasons };
          }
          return true;
        } catch (e) { if (failures.size < 3) failures.add((e as Error).message); return false; }
      };
      if (item.mode !== 'balanced') attempt(item.mode === 'manual' ? item.placement! : entry.before);
      else {
        const rank = (a: NodeRow, b: NodeRow) => (rtt(a, now) ?? 100) - (rtt(b, now) ?? 100) || gpuMemory(b) - gpuMemory(a) || b.offer!.ramMiB - a.offer!.ramMiB || a.id.localeCompare(b.id);
        const holders = free.filter(n => modelOn(n, profile)).sort(rank);
        let feasibleReplicas = 0;
        if (!(dep.spec.chain ?? 0)) for (const n of holders.filter(n => n.offer!.roles.replica)) {
          let feasible = attempt({ kind: 'replica', replicaNodeId: n.id });
          if (gpuMemory(n)) feasible = attempt({ kind: 'replica', replicaNodeId: n.id }, true) || feasible;
          if (feasible && ++feasibleReplicas >= 24) break;
        }
        const rows = profile.envelope.filter(r => (dep.spec.ctx ?? 1536) <= r.maxCtx && (dep.spec.parallel ?? 1) <= r.maxParallel && (dep.spec.chain ?? 0) <= r.maxChain).map(r => r.workerLayers).filter(n => n > 0).sort((a, b) => b - a);
        let feasibleCoordinators = 0;
        if (rows.length) for (const coord of holders.filter(n => n.offer!.roles.coordinator)) {
          let feasible = false;
          const workers = free.filter(n => n.id !== coord.id && n.offer!.roles.worker && gpuMemory(n) >= rows.at(-1)! * profile.layerMiB + profile.workerMarginMiB).sort(rank);
          const max = Math.min(workers.length, 64, Math.floor((profile.layers - 1) / rows.at(-1)!));
          const counts = [...new Set([1, 2, 3, 4, 8, 12, 16, 32, max])].filter(n => n > 0 && n <= max);
          for (const count of counts) {
            const group = workers.slice(0, count); const placement: FleetPlacement = { kind: 'split', coordinatorNodeId: coord.id, workerNodeIds: group.map(n => n.id) };
            if (!(dep.spec.chain ?? 0)) {
              let left = profile.layers - 1; const layers: number[] = [];
              for (const [i, n] of group.entries()) {
                const k = rows.find(k => k * profile.layerMiB + profile.workerMarginMiB <= gpuMemory(n) && k <= left - (count - i - 1) * rows.at(-1)!);
                if (!k) break; layers.push(k); left -= k;
              }
              if (layers.length !== count) continue;
              placement.workerLayers = layers;
            }
            feasible = attempt(placement) || feasible;
          }
          if (feasible && ++feasibleCoordinators >= 12) break;
        }
      }
      if (!winner) { entry.error = [...failures].join(' ') || 'No eligible nodes hold this model and have unreserved capacity. Include its current deployments to rebalance their resources, or expand the hardware pool.'; continue; }
      Object.assign(entry, winner); addAllocations(ledger, winner.plan.allocations!); occupyPorts(ports, winner.plan);
    }
    const count = entries.filter(e => e.plan).length, score = entries.reduce((sum, e) => sum + (e.score ?? 0), 0);
    if (!best || count > best.count || (count === best.count && score < best.score)) best = { entries, ledger, score, count };
  }
  const entries = request.items.map(i => best!.entries.find(e => e.deploymentId === i.deploymentId)!);
  const errors = hostMemoryErrors(input, entries, selected);
  const warnings = ['Balanced recommendations use capacity, model availability, network RTT and contention. Scores are estimates, not predicted tokens per second.', ...errors];
  if (poolNodes.length < pool.size) warnings.push('Offline nodes, disabled offers and agents without fleet-budget support are excluded.');
  return { revision: fleetRevision(input), entries, canApply: best!.count === request.items.length && !errors.length, plannedCount: best!.count, selectedCount: request.items.length,
    allocations: [...best!.ledger.values()], warnings, evaluatedCandidates };
}
