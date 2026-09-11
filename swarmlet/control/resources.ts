// Shared capacity for admission, fleet previews and runtime assignments. A stopped
// process releases capacity only after its agent acknowledges cleanup.
import type { Deployment, DeploymentSpec, ModelProfile, NodeAllocation, Plan } from '../protocol/types.ts';
import type { AssignmentRow, NodeRow } from './registry.ts';
import { planDeployment } from './planner.ts';
import type { Qwen35NativeQualification } from './profiles/qwen35-native.ts';

export type ResourceLedger = Map<string, NodeAllocation>;
export const emptyAllocation = (nodeId: string): NodeAllocation => ({ nodeId, ramMiB: 0, cpuCores: 0, gpu: [] });
export function addAllocations(ledger: ResourceLedger, values: NodeAllocation[]): void {
  for (const value of values) {
    const current = ledger.get(value.nodeId) ?? emptyAllocation(value.nodeId);
    current.ramMiB += value.ramMiB; current.cpuCores += value.cpuCores;
    for (const gpu of value.gpu) {
      const existing = current.gpu.find(g => g.id === gpu.id);
      if (existing) existing.memMiB += gpu.memMiB; else current.gpu.push({ ...gpu });
    }
    ledger.set(value.nodeId, current);
  }
}
export function copyLedger(ledger: ResourceLedger): ResourceLedger {
  return new Map([...ledger].map(([id, value]) => [id, structuredClone(value)]));
}
export function offeredAllocation(node: NodeRow): NodeAllocation {
  return { nodeId: node.id, ramMiB: node.offer?.ramMiB ?? 0, cpuCores: node.offer?.cpuCores ?? 0, gpu: node.offer?.gpu.map(g => ({ ...g })) ?? [] };
}
export function planNodeIds(plan: Plan): string[] {
  return plan.nativeExecution ? [...new Set(plan.nativeExecution.endpoints.map(e => e.nodeId))]
    : [plan.coordinatorNodeId, ...plan.workers.map(w => w.nodeId)];
}
const healthWatch = (row: AssignmentRow) => row.body.kind === 'replica' && !!row.body.external;

export function reservedResources(deployments: Deployment[], assignments: AssignmentRow[], nodes: NodeRow[], exclude = new Set<string>()): ResourceLedger {
  const ledger: ResourceLedger = new Map(), known = new Set(deployments.map(d => d.id)), byId = new Map(nodes.map(n => [n.id, n]));
  const live = new Map<string, AssignmentRow[]>();
  for (const row of assignments) if (row.state !== 'stopped' && !healthWatch(row)) {
    const rows = live.get(row.deploymentId) ?? []; rows.push(row); live.set(row.deploymentId, rows);
  }
  for (const dep of deployments) {
    if (exclude.has(dep.id) || dep.spec.kind === 'external') continue;
    const rows = live.get(dep.id) ?? [];
    const active = ['placing', 'loading', 'ready', 'draining'].includes(dep.state);
    if (!active && !rows.length) continue;
    if (dep.plan?.allocations) {
      addAllocations(ledger, dep.plan.allocations);
      // Older/orphaned processes on different nodes still occupy their old offer.
      const planned = new Set(dep.plan.allocations.map(a => a.nodeId));
      for (const id of new Set(rows.filter(r => !planned.has(r.nodeId)).map(r => r.nodeId))) {
        const n = byId.get(id); if (n) addAllocations(ledger, [offeredAllocation(n)]);
      }
    } else {
      // Legacy assignments were given the whole offer. Do not pretend unused parts
      // are safe to lend before those assignments have been replaced.
      const ids = new Set([...rows.map(r => r.nodeId), ...(active && dep.plan ? planNodeIds(dep.plan) : [])]);
      for (const id of ids) { const n = byId.get(id); if (n) addAllocations(ledger, [offeredAllocation(n)]); }
    }
  }
  for (const [id, rows] of live) if (!known.has(id) && !exclude.has(id)) {
    for (const nodeId of new Set(rows.map(r => r.nodeId))) { const n = byId.get(nodeId); if (n) addAllocations(ledger, [offeredAllocation(n)]); }
  }
  return ledger;
}

export function availableNodes(nodes: NodeRow[], reserved: ResourceLedger): NodeRow[] {
  return nodes.map(node => {
    if (!node.offer) return node;
    const used = reserved.get(node.id) ?? emptyAllocation(node.id);
    const offer = { ...node.offer, ramMiB: Math.max(0, node.offer.ramMiB - used.ramMiB), cpuCores: Math.max(0, node.offer.cpuCores - used.cpuCores),
      gpu: node.offer.gpu.map(g => ({ ...g, memMiB: Math.max(0, g.memMiB - (used.gpu.find(v => v.id === g.id)?.memMiB ?? 0)) })).filter(g => g.memMiB > 0) };
    offer.enabled = offer.enabled && offer.ramMiB > 0 && offer.cpuCores >= 1;
    return { ...node, offer, caps: node.caps ? { ...node.caps, gpus: node.caps.gpus.filter(g => offer.gpu.some(v => v.id === g.id)) } : null };
  });
}

export function parseAllocations(value: unknown): NodeAllocation[] {
  if (!Array.isArray(value) || !value.length || value.length > 1000) throw new Error('Allocations must contain 1–1000 node budgets.');
  const ids = new Set<string>();
  return value.map(a => {
    if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(k => !['nodeId', 'ramMiB', 'cpuCores', 'gpu'].includes(k)) ||
      typeof a.nodeId !== 'string' || !a.nodeId || ids.has(a.nodeId) || !Number.isSafeInteger(a.ramMiB) || a.ramMiB < 1 ||
      !Number.isSafeInteger(a.cpuCores) || a.cpuCores < 1 || !Array.isArray(a.gpu) || a.gpu.length > 64) throw new Error('Each allocation needs a unique node, positive integer RAM/CPU budgets and a GPU list.');
    ids.add(a.nodeId); const gpuIds = new Set<string>();
    const gpu = a.gpu.map((g: any) => {
      if (!g || typeof g !== 'object' || Object.keys(g).some(k => !['id', 'memMiB'].includes(k)) || typeof g.id !== 'string' || !g.id || gpuIds.has(g.id) || !Number.isSafeInteger(g.memMiB) || g.memMiB < 1) throw new Error('Invalid or duplicate GPU allocation.');
      gpuIds.add(g.id); return { id: g.id as string, memMiB: g.memMiB as number };
    });
    return { nodeId: a.nodeId, ramMiB: a.ramMiB, cpuCores: a.cpuCores, gpu };
  });
}

export function assertFits(allocation: NodeAllocation, node: NodeRow): void {
  const offer = node.offer;
  if (!node.online || !offer?.enabled) throw new Error(`${node.hostname}: node is offline or not offering resources.`);
  if (allocation.ramMiB > offer.ramMiB || allocation.cpuCores > offer.cpuCores) throw new Error(`${node.hostname}: allocation needs ${allocation.ramMiB} MiB RAM / ${allocation.cpuCores} CPU, but only ${offer.ramMiB} MiB / ${offer.cpuCores} remain.`);
  for (const gpu of allocation.gpu) {
    const free = offer.gpu.find(g => g.id === gpu.id)?.memMiB ?? 0;
    if (gpu.memMiB > free) throw new Error(`${node.hostname}: ${gpu.id} needs ${gpu.memMiB} MiB, but only ${free} MiB remain.`);
  }
}

/** Profile admission minima, plus host staging for worker tensors. Unified GPU RAM
 * is represented in both budgets but is never added twice to physical RAM usage. */
export function minimumAllocations(plan: Plan, profile: ModelProfile, nodes: NodeRow[]): NodeAllocation[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  if (plan.nativeExecution) return plan.nativeExecution.endpoints.map(e => ({ nodeId: e.nodeId, ramMiB: e.enforce.ramMiB, cpuCores: e.enforce.cpuCores, gpu: offeredAllocation(byId.get(e.nodeId)!).gpu }));
  return planNodeIds(plan).map(id => {
    const n = byId.get(id)!; const worker = plan.workers.find(w => w.nodeId === id);
    const layers = worker?.layers ?? (plan.workers.length ? plan.tensorSplit.at(-1)! : profile.layers);
    const device = worker?.device ?? plan.coordinatorDevice;
    const gpu = n.caps?.gpus.find(g => g.engineName === device);
    const draft = !worker && plan.mtpPath ? Math.ceil((n.models.find(m => m.path === plan.mtpPath)?.sizeBytes ?? 0) / 1048576) : 0;
    const resident = layers * profile.layerMiB + draft;
    const gpuMiB = gpu ? resident + profile.workerMarginMiB : 0;
    const ramMiB = worker ? Math.max(1024, gpuMiB) : (n.os === 'darwin' || !gpu ? resident : Math.max(resident, profile.coordinatorHostMiB)) + profile.coordinatorHostMiB;
    return { nodeId: id, ramMiB, cpuCores: 1, gpu: gpu ? [{ id: gpu.id, memMiB: gpuMiB }] : [] };
  });
}

export function planWithResources(options: { spec: DeploymentSpec; profile: ModelProfile; nodes: NodeRow[]; reserved?: ResourceLedger; usedPorts: Map<string, Set<number>>; nativeQualifications?: readonly Qwen35NativeQualification[] }): Plan {
  const available = availableNodes(options.nodes, options.reserved ?? new Map());
  const explicit = options.spec.allocations === undefined ? undefined : parseAllocations(options.spec.allocations);
  const byId = new Map(available.map(n => [n.id, n]));
  if (explicit) for (const a of explicit) {
    const n = byId.get(a.nodeId); if (!n) throw new Error(`Unknown allocation node ${a.nodeId}.`);
    if (n.caps?.allocationVersion !== 1) throw new Error(`${n.hostname}: update the node agent before assigning fleet budgets.`);
    assertFits(a, n);
  }
  const bounded = explicit ? available.map(n => {
    const a = explicit.find(a => a.nodeId === n.id);
    if (!a || !n.offer) return { ...n, online: false };
    return { ...n, offer: { ...n.offer, ramMiB: a.ramMiB, cpuCores: a.cpuCores, gpu: a.gpu }, caps: n.caps ? { ...n.caps, gpus: n.caps.gpus.filter(g => a.gpu.some(a => a.id === g.id)) } : null };
  }) : available;
  const plan = planDeployment({ ...options, nodes: bounded });
  const ids = new Set(planNodeIds(plan));
  if (explicit) {
    if (ids.size !== explicit.length || explicit.some(a => !ids.has(a.nodeId))) throw new Error('Allocations must match every placement node exactly.');
    for (const minimum of minimumAllocations(plan, options.profile, bounded)) {
      const a = explicit.find(a => a.nodeId === minimum.nodeId)!;
      if (a.ramMiB < minimum.ramMiB || minimum.gpu.some(g => (a.gpu.find(v => v.id === g.id)?.memMiB ?? 0) < g.memMiB)) throw new Error(`${byId.get(a.nodeId)!.hostname}: budget is below the model's RAM/GPU requirement.`);
    }
  }
  plan.allocations = explicit ?? [...ids].map(id => offeredAllocation(byId.get(id)!));
  if (explicit) plan.reasons.push('Fleet RAM/CPU budgets are sent to each process; GPU memory is reserved against the node offer. GPU compute is shared, not partitioned.');
  return plan;
}
