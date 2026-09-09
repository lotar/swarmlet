import { expect, test } from "bun:test";
import { processingSnapshot } from "../processing.ts";
import type { ControlDeps } from "../server.ts";
const now = Date.now();
function fixture() {
  const dep = { id: 'split', spec: { name: 'shared', profile: 'qwen', kind: 'split' }, state: 'ready', endpoint: { modelName: 'qwen', nodeId: 'mac', port: 8100 }, plan: { coordinatorNodeId: 'mac', coordinatorDevice: 'MTL0', tensorSplit: [3,3,18], modelPath: '/private/model', workers: [{nodeId:'l1',device:'CUDA0',layers:3},{nodeId:'l2',device:'CUDA0',layers:3}] } };
  const nodes = new Map(['mac','l1','l2'].map(id => [id, { hostname:id, pubJwk:'secret', caps:{privateIps:['private']}, metrics:{ts:new Date(now).toISOString(),cpuPct:12,gpu:[{usedMiB:512}]} }]));
  const deps = {reg:{ getDeployment:(id:string)=>id===dep.id ? dep : null, getNode:(id:string)=>nodes.get(id)}, channel:{isOnline:(id:string)=>id!=='l2'}, profiles:new Map([['qwen',{layers:24,modelName:'qwen'}]]), deployments:{routing:()=>[{modelName:'qwen',deployments:[{id:'split',name:'shared',inflight:0}]}]}} as unknown as ControlDeps;
  return {deps,dep,nodes};
}
test('processing reports assigned layer shares, suppresses stale/offline host values and excludes private data',()=>{
  const f=fixture(); f.nodes.get('l1')!.metrics.ts = new Date(now-20000).toISOString();
  const out=processingSnapshot(f.deps,new URL('http://local/v1/mesh?model=qwen'),now)!;
  expect(out.nodes.map(n=>n.sharePct)).toEqual([75,12.5,12.5]);
  expect(out.nodes.map(n=>n.metricsState)).toEqual(['live','stale','offline']);
  expect(out.nodes.map(n=>n.cpuPct)).toEqual([12,null,null]);
  expect(out.nodes[0]!.gpuUsedMiB).toBe(512);
  expect(JSON.stringify(out)).not.toMatch(/secret|private|modelPath|8100|pubJwk/);
});
test('processing honors the actual deployment pin and refuses a mismatched model',()=>{
  const f=fixture();
  expect(processingSnapshot(f.deps,new URL('http://local/v1/mesh?model=qwen&deployment=missing'),now)).toBeNull();
  expect(processingSnapshot(f.deps,new URL('http://local/v1/mesh?model=other&deployment=split'),now)).toBeNull();
  f.dep.state='loading';
  expect(processingSnapshot(f.deps,new URL('http://local/v1/mesh?model=qwen&deployment=split'),now)!.deployment.state).toBe('loading');
});
test('external whole-model server has 100% share without invented layer counts',()=>{
  const f=fixture(); (f.dep as any).plan=undefined; (f.dep as any).spec.kind='external';
  const out=processingSnapshot(f.deps,new URL('http://local/v1/mesh?model=qwen'),now)!;
  expect(out.shareBasis).toBe('whole_model'); expect(out.nodes).toHaveLength(1); expect(out.nodes[0]!.sharePct).toBe(100); expect(out.nodes[0]!.layers).toBeNull();
});

test('native stages project all endpoints in plan order with their actual layer shares',()=>{
  const f=fixture();
  (f.dep.spec as any).kind='stages';
  Object.assign(f.dep.plan,{tensorSplit:[],workers:[],nativeExecution:{mode:'stages',endpoints:[
    {nodeId:'l1',device:'CUDA0',modelPath:'/private/first.gguf',port:50200,identity:{stage_start:'0',stage_end:'3'}},
    {nodeId:'l2',device:'CUDA0',modelPath:'/private/middle.gguf',port:50210,identity:{stage_start:'3',stage_end:'6'}},
    {nodeId:'mac',device:'MTL0',modelPath:'/private/last.gguf',port:50220,identity:{stage_start:'6',stage_end:'24'}},
  ]}});
  const out=processingSnapshot(f.deps,new URL('http://local/v1/mesh?model=qwen'),now)!;
  expect(out.nodes.map(n=>[n.id,n.role,n.layers,n.sharePct])).toEqual([
    ['l1','Stage 1',3,12.5],['l2','Stage 2',3,12.5],['mac','Stage 3',18,75],
  ]);
  expect(JSON.stringify(out)).not.toMatch(/private|modelPath|50200|identity|Coordinator/);
});

test('prefill/decode projects both whole-model roles without inventing a compute share',()=>{
  const f=fixture();
  (f.dep.spec as any).kind='prefill-decode';
  Object.assign(f.dep.plan,{tensorSplit:[],workers:[],nativeExecution:{mode:'prefill-decode',endpoints:[
    {nodeId:'l1',device:'CUDA0',identity:{stage_start:'',stage_end:''}},
    {nodeId:'mac',device:'MTL0',identity:{stage_start:'',stage_end:''}},
  ]}});
  const out=processingSnapshot(f.deps,new URL('http://local/v1/mesh?model=qwen'),now)!;
  expect(out.shareBasis).toBe('whole_model');
  expect(out.nodes.map(n=>[n.id,n.role,n.layers,n.sharePct])).toEqual([
    ['l1','Prefill',24,null],['mac','Decode',24,null],
  ]);
});
