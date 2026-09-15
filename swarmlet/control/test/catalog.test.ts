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
  expect(result.data).toHaveLength(4);
  const tiny=result.data.find(x=>x.id==='qwen3.5-2b')!;
  expect(tiny.ready).toBe(1);expect(tiny.local_eligible).toBe(false);expect(tiny.local_reasons.join(' ')).toContain('1714');
  expect(result.data.filter(x=>x.ready===0)).toHaveLength(3);
});
test('the catalog carries how to obtain weights a node lacks, and omits it when a profile declares none',()=>{
  const result=modelCatalog(profiles.values(),[],node);
  const big=result.data.find(x=>x.id==='qwen3.8-27b')!;
  expect(big.download!.files.map(f=>f.name)).toEqual(['Qwen3.8-27B-Q8_0.gguf','mtp-Qwen3.8-27B-Q8_0.gguf']);
  // Announcing a source must never imply the weights are present.
  expect(big.local_eligible).toBe(false);
  expect(result.data.find(x=>x.id==='qwen3.5-2b')!.download).toBeUndefined();
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
