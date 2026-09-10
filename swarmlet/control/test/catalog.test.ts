import { expect, test } from 'bun:test';
import { modelCatalog } from '../catalog.ts';
import { loadProfiles } from '../planner.ts';
import type { NodeRow } from '../registry.ts';
const profiles = loadProfiles();
const node: NodeRow = { id:'win',pubJwk:{},certFp:'fp',hostname:'win',os:'win32',arch:'x64',enrolledAt:'',lastSeen:null,online:true,agentVersion:'test',caps:null,metrics:null,
  offer:{ enabled:true,roles:{replica:true,worker:false,coordinator:false},gpu:[],ramMiB:1714,cpuCores:2,diskMiB:0,modelsDir:'/models' },
  models:[{name:'Qwen3.5-2B-Q8_0.gguf',path:'/models/Qwen3.5-2B-Q8_0.gguf',sizeBytes:2200000000,kind:'gguf'}] };
test('catalog includes unserved profiles and planner refuses Windows RAM without concealing mesh availability',()=>{
  const result=modelCatalog(profiles.values(),[{modelName:'qwen3.5-2b',created:1,deployments:[{id:'d',name:'d',kind:'replica',nodeId:'mac',port:1,nodes:['mac'],inflight:0}]}],node);
  expect(result.data).toHaveLength(3);
  const tiny=result.data.find(x=>x.id==='qwen3.5-2b')!;
  expect(tiny.ready).toBe(1);expect(tiny.local_eligible).toBe(false);expect(tiny.local_reasons.join(' ')).toContain('1714');
  expect(result.data.filter(x=>x.ready===0)).toHaveLength(2);
});
test('local fit, missing weights, disabled offer and disconnected node use actual planner decisions',()=>{
  const n={...node,offer:{...node.offer!,ramMiB:4096}};
  const catalog=(n:NodeRow|null)=>modelCatalog(profiles.values(),[],n).data.find(x=>x.id==='qwen3.5-2b')!;
  expect(catalog(n).local_eligible).toBe(true);
  expect(catalog({...n,models:[]}).local_eligible).toBe(false);
  expect(catalog({...n,offer:{...n.offer,enabled:false}}).local_eligible).toBe(false);
  expect(catalog({...n,online:false}).local_eligible).toBe(false);
  expect(catalog(null).local_eligible).toBe(false);
});
