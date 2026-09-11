import { afterEach, expect, test } from 'bun:test';
import { Registry } from '../registry.ts';
import { DeploymentManager } from '../deployments.ts';
import { loadProfiles } from '../planner.ts';
import type { AgentChannel } from '../channel.ts';
import type { Assignment, AssignmentState, ControlToAgent } from '../../protocol/types.ts';
import { fleetNode, fleetDeployment } from './fleet-fixture.ts';
const fixtures: Array<{ reg: Registry; manager: DeploymentManager }> = [];
afterEach(() => { for (const f of fixtures.splice(0)) { f.manager.dispose(); f.reg.close(); } });
function rig(count = 2) {
  const reg = new Registry(':memory:'), sent: Assignment[] = [];
  let manager: DeploymentManager, stops = true;
  const report = (node: string, id: string, state: AssignmentState) => { reg.setAssignmentState(id, state); manager.onAssignmentState(node, id, state); };
  const send = (node: string, m: ControlToAgent) => {
    if (m.t !== 'assign') return true;
    const a = m.assignment; sent.push(a);
    if (a.kind !== 'stop' || stops) queueMicrotask(() => report(node, a.id, a.kind === 'stop' ? 'stopped' : a.kind === 'worker' ? 'listening' : 'ready'));
    return true;
  };
  const channel = { isOnline: () => true, send, assign: (node: string, a: Assignment) => { reg.putAssignment(a, node); return send(node, { t: 'assign', assignment: a }); } } as unknown as AgentChannel;
  manager = new DeploymentManager({ reg, channel, profiles: loadProfiles(), log: { info() {}, warn() {}, debug() {}, error() {} }, stopTimeoutMs: 10 });
  for (let i = 0; i < count; i++) { const n = fleetNode('n' + i); reg.upsertNode({ ...n, caps: n.caps! }); reg.setOffer(n.id, n.offer!); reg.setModels(n.id, n.models); reg.setOnline(n.id, true); }
  for (const id of ['a', 'b']) reg.createDeployment(id, fleetDeployment(id).spec);
  fixtures.push({ reg, manager });
  const preview = () => manager.previewAllocation({ items: ['a', 'b'].map(deploymentId => ({ deploymentId, mode: 'balanced' })), poolNodeIds: reg.listNodes().map(n => n.id) });
  return { reg, manager, sent, preview, disableStops: () => { stops = false; } };
}
async function finish(f: ReturnType<typeof rig>, id: string) {
  for (let i = 0; i < 100 && f.reg.fleetRun(id)?.status === 'applying'; i++) await Bun.sleep(5);
  return f.reg.fleetRun(id)!;
}
test('apply persists exact budgets, blocks concurrent changes, and is idempotent', async () => {
  const f = rig(1), run = await f.preview(); expect(run.canApply).toBe(true);
  expect(f.manager.applyAllocation(run.id).status).toBe('applying');
  expect(f.manager.routing()).toEqual([]);
  await expect(f.manager.start('a')).rejects.toThrow('allocation is applying');
  expect(f.manager.applyAllocation(run.id).id).toBe(run.id);
  expect((await finish(f, run.id)).status).toBe('succeeded');
  expect(f.sent.filter(a => a.kind === 'replica')).toHaveLength(2);
  for (const entry of run.entries) {
    const a = f.sent.find(a => a.deploymentId === entry.deploymentId && a.kind === 'replica');
    if (!a || a.kind !== 'replica') throw new Error('missing replica');
    expect(a.enforce).toEqual(entry.spec!.allocations![0]!);
    expect(f.reg.getDeployment(entry.deploymentId)!.spec.allocations).toEqual(entry.spec!.allocations);
  }
  f.manager.applyAllocation(run.id); expect(f.sent.filter(a => a.kind === 'replica')).toHaveLength(2);
  expect(f.manager.routing()[0]!.deployments).toHaveLength(2);
});
test('stale offers and active requests reject before changing deployments', async () => {
  const f = rig(), run = await f.preview();
  f.manager.trackInflight('a', 1); expect(() => f.manager.applyAllocation(run.id)).toThrow('active requests');
  f.manager.trackInflight('a', -1);
  const node = f.reg.getNode('n0')!; f.reg.setOffer('n0', { ...node.offer!, cpuCores: 1 });
  expect(() => f.manager.applyAllocation(run.id)).toThrow('changed since');
  expect(f.reg.getDeployment('a')!.state).toBe('planned'); expect(f.sent).toEqual([]);
});
test('failed cleanup preserves original specs and records a durable partial result', async () => {
  const f = rig(); await f.manager.start('a');
  const original = f.reg.getDeployment('a')!.spec, run = await f.preview(); expect(run.canApply).toBe(true);
  f.disableStops(); f.manager.applyAllocation(run.id);
  const result = await finish(f, run.id);
  expect(result.status).toBe('partial'); expect(result.error).toContain('Cleanup was not acknowledged');
  expect(f.reg.getDeployment('a')!.spec).toEqual(original);
  expect(f.reg.listAssignments('a').some(a => a.state !== 'stopped')).toBe(true);
  expect(f.manager.fleetSnapshot().busy).toBe(false);
});
test('failed admission transaction rolls back routes and releases operation lock', async () => {
  const f = rig(), run = await f.preview();
  f.reg.db.exec("CREATE TRIGGER reject_fleet BEFORE UPDATE ON deployments WHEN NEW.state = 'draining' BEGIN SELECT RAISE(ABORT, 'test write failure'); END");
  expect(() => f.manager.applyAllocation(run.id)).toThrow('test write failure');
  expect(f.reg.fleetRun(run.id)!.status).toBe('preview'); expect(f.manager.fleetSnapshot().busy).toBe(false);
  expect(f.reg.getDeployment('a')!.state).toBe('planned'); expect(f.sent).toEqual([]);
});
test('large inventories use worker planning and return applicable plans', async () => {
  const f = rig(100), run = await f.preview(); expect(run.plannedCount).toBe(2); expect(run.canApply).toBe(true);
});

test('controller restore records interrupted allocation without replaying its apply', async () => {
  const f = rig(), run = await f.preview();
  run.status = 'applying'; run.entries.forEach(e => { e.phase = 'starting'; }); f.reg.saveFleetRun(run);
  f.manager.restore();
  expect(f.reg.fleetRun(run.id)!.status).toBe('interrupted');
  expect(f.reg.fleetRun(run.id)!.error).toContain('Control restarted');
  expect(f.sent).toEqual([]);
  expect(f.manager.applyAllocation(run.id).status).toBe('interrupted');
});
