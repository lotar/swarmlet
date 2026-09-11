import { describe, expect, test } from 'bun:test';
import { loadProfiles, planDeployment } from '../planner.ts';
import { hostMemoryErrors, parseFleetRequest, previewFleet, fleetRevision, type FleetInput, type FleetRequest } from '../fleet.ts';
import { addAllocations, availableNodes, planWithResources, reservedResources } from '../resources.ts';
import type { AssignmentRow, NodeRow } from '../registry.ts';
import type { Deployment, NodeAllocation } from '../../protocol/types.ts';

const profiles = loadProfiles(), profile = profiles.get('qwen35-2b-q8')!, now = Date.now(), ts = new Date(now).toISOString();
import { fleetNode, fleetDeployment } from './fleet-fixture.ts';
const input = (nodes: NodeRow[], deployments: Deployment[]): FleetInput => ({ nodes, deployments, assignments: [], profiles, now });
const request = (i: FleetInput): FleetRequest => ({ items: i.deployments.map(d => ({ deploymentId: d.id, mode: 'balanced' })), poolNodeIds: i.nodes.map(n => n.id) });
const budget = (nodeId: string): NodeAllocation => ({ nodeId, ramMiB: 4000, cpuCores: 4, gpu: [{ id: 'cuda:0', memMiB: 3000 }] });

test('balanced allocation spreads deployments and prefers whole-model GPU replicas over extra hops', () => {
  const i = input([fleetNode('a'), fleetNode('b'), fleetNode('c')], [fleetDeployment('one'), fleetDeployment('two')]);
  const p = previewFleet(request(i), i);
  expect(p.canApply).toBe(true); expect(p.plannedCount).toBe(2);
  expect(p.entries.every(e => e.spec?.kind === 'replica')).toBe(true);
  expect(new Set(p.entries.map(e => e.plan?.coordinatorNodeId)).size).toBe(2);
  expect(p.entries.every(e => e.plan!.allocations![0]!.gpu.length === 1)).toBe(true);
  expect(previewFleet(request(i), i)).toEqual(p);
});

test('one node can serve two deployments with explicit, non-overlapping RAM/CPU/GPU budgets', () => {
  const i = input([fleetNode('shared')], [fleetDeployment('one'), fleetDeployment('two')]);
  const p = previewFleet(request(i), i);
  expect(p.canApply).toBe(true);
  expect(p.entries.map(e => e.plan!.allocations![0]!.cpuCores)).toEqual([5, 5]);
  expect(p.allocations[0]!.cpuCores).toBe(10);
  expect(p.allocations[0]!.ramMiB).toBeLessThanOrEqual(12288);
  expect(p.allocations[0]!.gpu[0]!.memMiB).toBeLessThanOrEqual(8192);
});

test('manual layouts preserve layer order, enforce qualified counts and refuse a node outside the pool', () => {
  const i = input([fleetNode('c'), fleetNode('w')], [fleetDeployment('one')]);
  const r: FleetRequest = { ...request(i), items: [{ deploymentId: 'one', mode: 'manual', cpuCores: 3, placement: { kind: 'split', coordinatorNodeId: 'c', workerNodeIds: ['w'], workerLayers: [3] } }] };
  let p = previewFleet(r, i); expect(p.canApply).toBe(true); expect(p.entries[0]!.plan!.tensorSplit).toEqual([3, 21]); expect(p.entries[0]!.plan!.workers[0]!.threads).toBe(3);
  r.items[0]!.placement!.workerLayers = [4]; p = previewFleet(r, i); expect(p.canApply).toBe(false); expect(p.entries[0]!.error).toContain('envelope');
  r.items[0]!.placement!.workerLayers = [3]; r.poolNodeIds = ['c']; p = previewFleet(r, i); expect(p.canApply).toBe(false); expect(p.entries[0]!.error).toContain('hardware pool');
});

test('legacy reservations and retired processes are not released before stop acknowledgement', () => {
  const n = fleetNode('n'), d = fleetDeployment('existing'); d.state = 'failed';
  const row = { id: 'a', deploymentId: d.id, nodeId: n.id, state: 'failed', retired: true, detail: null, updatedAt: ts,
    body: { kind: 'replica', id: 'a', deploymentId: d.id, port: 8100, allow: [] } } satisfies AssignmentRow;
  let used = reservedResources([d], [row], [n]); expect(used.get('n')!.ramMiB).toBe(12288);
  expect(availableNodes([n], used)[0]!.offer!.enabled).toBe(false);
  used = reservedResources([d], [{ ...row, state: 'stopped' }], [n]); expect(used.size).toBe(0);
  const i = input([n], [d, fleetDeployment('new')]); i.assignments = [row];
  expect(previewFleet({ poolNodeIds: ['n'], items: [{ deploymentId: 'new', mode: 'balanced' }] }, i).canApply).toBe(false);
});

test('resource admission rejects overcommit, duplicate budgets, unsupported agents and GPU undersizing', () => {
  const n = fleetNode('n'), spec = { ...fleetDeployment('d').spec, replicaNodeId: 'n', allocations: [budget('n')] };
  const p = () => planWithResources({ spec, nodes: [n], profile, reserved: new Map(), usedPorts: new Map() });
  expect(p().allocations).toEqual(spec.allocations);
  spec.allocations = [budget('n'), budget('n')]; expect(p).toThrow('unique');
  spec.allocations = [{ ...budget('n'), cpuCores: 11 }]; expect(p).toThrow('only');
  spec.allocations = [{ ...budget('n'), gpu: [{ id: 'cuda:0', memMiB: 2000 }] }]; expect(p).toThrow('requirement');
  spec.allocations = [budget('n')]; n.caps!.allocationVersion = undefined; expect(p).toThrow('update the node');
});

test('unified RAM is not summed twice, and current host pressure blocks an otherwise fitting preview', () => {
  const n = fleetNode('mac'); n.os = 'darwin'; n.caps!.os = 'darwin';
  const spec = { ...fleetDeployment('d').spec, replicaNodeId: 'mac', allocations: [budget('mac')] };
  const p = planWithResources({ spec, nodes: [n], profile, usedPorts: new Map() });
  const ledger = new Map(); addAllocations(ledger, p.allocations!); expect(ledger.get('mac').ramMiB).toBe(4000);
  n.metrics = { ts, cpuPct: 0, rssMiB: 0, freeRamMiB: 1000 };
  const i = input([n], [fleetDeployment('d')]); const preview = previewFleet(request(i), i);
  expect(preview.plannedCount).toBe(0); expect(preview.canApply).toBe(false); expect(preview.entries[0]!.error).toContain('current free RAM');
});

test('revision ignores heartbeat timestamps but binds offers, placement and live orphan processes', () => {
  const i = input([fleetNode('n')], [fleetDeployment('d')]), revision = fleetRevision(i);
  i.nodes[0]!.lastSeen = 'later'; i.nodes[0]!.caps!.measuredAt = 'later'; expect(fleetRevision(i)).toBe(revision);
  i.nodes[0]!.offer!.cpuCores--; expect(fleetRevision(i)).not.toBe(revision);
});

test('request parser rejects malformed or ambiguous manual overrides', () => {
  expect(() => parseFleetRequest({ items: [], poolNodeIds: [] })).toThrow();
  expect(() => parseFleetRequest({ items: [{ deploymentId: 'x', mode: 'balanced', placement: {} }], poolNodeIds: ['n'] })).toThrow();
  expect(() => parseFleetRequest({ items: [{ deploymentId: 'x', mode: 'manual', placement: { kind: 'replica', replicaNodeId: 'n', workerNodeIds: ['n'] } }], poolNodeIds: ['n'] })).toThrow();
});

test('500-node pool and 20 concurrent deployments stay bounded and never spend capacity twice', () => {
  const i = input(Array.from({ length: 500 }, (_, k) => fleetNode(`node-${String(k).padStart(3, '0')}`)), Array.from({ length: 20 }, (_, k) => fleetDeployment(`dep-${k}`)));
  const started = performance.now(), p = previewFleet(request(i), i), elapsed = performance.now() - started;
  expect(p.canApply).toBe(true); expect(p.plannedCount).toBe(20);
  expect(p.allocations.every(a => a.cpuCores <= 10 && a.ramMiB <= 12288 && a.gpu.every(g => g.memMiB <= 8192))).toBe(true);
  expect(p.evaluatedCandidates).toBeLessThan(12000); expect(elapsed).toBeLessThan(5000);
  console.log(`FLEET_SCALE: 500 nodes / 20 deployments, ${p.evaluatedCandidates} candidates, ${Math.round(elapsed)}ms`);
}, 15000);


test('automatic sharing reaches one core per deployment when ten workloads fit one node', () => {
  const n = fleetNode('large'); n.offer!.ramMiB = 131072; n.offer!.gpu[0]!.memMiB = 65536; n.caps!.gpus[0]!.totalMiB = 65536;
  const i = input([n], Array.from({length: 10}, (_, k) => fleetDeployment('d' + k)));
  const p = previewFleet(request(i), i);
  expect(p.canApply).toBe(true); expect(p.plannedCount).toBe(10); expect(p.allocations[0]!.cpuCores).toBe(10);
});

test('fresh GPU pressure steers placement to another eligible GPU', () => {
  const a = fleetNode('a'), b = fleetNode('b');
  a.metrics = { ts, cpuPct: 0, gpu: [{ id: 'cuda:0', usedMiB: 8000 }] };
  const i = input([a,b], [fleetDeployment('d')]); const p = previewFleet(request(i), i);
  expect(p.canApply).toBe(true); expect(p.entries[0]!.plan!.coordinatorNodeId).toBe('b');
  expect(p.entries[0]!.plan!.coordinatorDevice).toBe('CUDA0');
});


// Owner rule: CPU-only placement is allowed only on nodes without a usable GPU. The balanced allocator
// used to hide a node's GPU to try a CPU replica there when the GPU was full; it must not anymore.
test('balanced allocation never places a replica on the CPU of a node that has a GPU', () => {
  const a = fleetNode('a');
  a.metrics = { ts, cpuPct: 0, gpu: [{ id: 'cuda:0', usedMiB: 8000 }] }; // GPU full, plenty of RAM
  const i = input([a], [fleetDeployment('d')]); const p = previewFleet(request(i), i);
  expect(p.canApply).toBe(false);
  expect(p.entries[0]!.plan).toBeUndefined();
  expect(p.entries[0]!.error ?? '').not.toMatch(/on CPU/);

  // The same deployment on a node without any GPU is placed on the CPU with the RAM offer.
  const laptop = fleetNode('laptop', { os: 'win32' });
  laptop.caps = { ...laptop.caps!, os: 'win32', ramMiB: 7857, ramReserveMiB: 2750, cpuCores: 8, gpus: [] };
  laptop.offer = { ...laptop.offer!, roles: { worker: false, coordinator: false, replica: true }, gpu: [], ramMiB: 3072, cpuCores: 6 };
  const j = input([laptop], [fleetDeployment('d')]); const q = previewFleet(request(j), j);
  expect(q.canApply).toBe(true);
  expect(q.entries[0]!.plan).toMatchObject({ coordinatorNodeId: 'laptop', coordinatorDevice: 'CPU' });
  expect(q.entries[0]!.plan!.allocations![0]!.gpu).toEqual([]);
});

test('GPU reservations cannot stand in for attributable reclaimed memory', () => {
  const n = fleetNode('n'), d = fleetDeployment('d');
  n.metrics = { ts, gpu: [{ id: 'cuda:0', usedMiB: 8000 }] };
  const plan = planWithResources({ spec: { ...d.spec, replicaNodeId: n.id, allocations: [budget(n.id)] }, profile, nodes: [n], reserved: new Map(), usedPorts: new Map() });
  d.state = 'ready'; d.plan = plan;
  const i = input([n], [d]);
  const entry = { deploymentId: d.id, name: d.id, before: { kind: 'replica' as const }, reasons: [], plan };
  expect(hostMemoryErrors(i, [entry], new Set([d.id]))[0]).toContain('only 192 MiB');
});

test('infeasible early nodes do not consume the replica candidate quota', () => {
  const nodes = Array.from({ length: 25 }, (_, k) => {
    const n = fleetNode(`n${k}`);
    n.offer!.roles = { replica: true, worker: false, coordinator: false };
    if (k < 24) n.offer!.ramMiB = 500;
    n.caps!.net!.rttMs = k;
    return n;
  });
  const i = input(nodes, [fleetDeployment('d')]), p = previewFleet(request(i), i);
  expect(p.canApply).toBe(true);
  expect(p.entries[0]!.plan!.coordinatorNodeId).toBe('n24');
});

test('infeasible early coordinators do not consume the split candidate quota', () => {
  const nodes = Array.from({ length: 13 }, (_, k) => {
    const n = fleetNode(`c${k}`);
    n.offer!.roles = { replica: false, worker: false, coordinator: true };
    if (k < 12) n.offer!.ramMiB = 500;
    n.caps!.net!.rttMs = k;
    return n;
  });
  const worker = fleetNode('worker'); worker.models = [];
  worker.offer!.roles = { replica: false, worker: true, coordinator: false };
  nodes.push(worker);
  const i = input(nodes, [fleetDeployment('d')]), p = previewFleet(request(i), i);
  expect(p.canApply).toBe(true); expect(p.entries[0]!.plan!.coordinatorNodeId).toBe('c12');
});
