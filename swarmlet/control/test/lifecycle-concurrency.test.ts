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

test('concurrent split coordinators never share ports', async () => {
 const f=rig(2);
 const budget=(nodeId:string)=>({nodeId,ramMiB:5000,cpuCores:2,gpu:[{id:'cuda:0',memMiB:3500}]});
 for(const id of ['a','b']) f.reg.applyDistributionSpec(id,{name:id,kind:'split',profile:'qwen35-2b-q8',ctx:1024,parallel:1,chain:0,coordinatorNodeId:'n0',workerNodeIds:['n1'],workerLayers:[3],allocations:[budget('n0'),budget('n1')]});
 await Promise.all(['a','b'].map(id=>f.manager.start(id)));
 const coords=f.sent.filter(a=>a.kind==='coordinator');
 console.log('coordinator ports',coords.map(a=>({deployment:a.deploymentId,port:(a as any).port})));
 expect(new Set(coords.map(a=>(a as any).port)).size).toBe(2);
});

test('completed lifecycle releases waiter bookkeeping', async () => {
 const f=rig(1);
 for(let i=0;i<10;i++){await f.manager.start('a');await f.manager.stop('a');}
 const waiters=(f.manager as any).waiters;
 console.log('retained waiter keys',waiters.size,'callbacks',[...waiters.values()].reduce((n,v)=>n+v.length,0));
 expect(waiters.size).toBe(0);
});
