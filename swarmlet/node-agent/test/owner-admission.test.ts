import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AssignmentRunner } from '../assignments.ts';
import type { Offer } from '../../protocol/types.ts';

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'swarmlet-owner-'));
  const offer: Offer={enabled:true,roles:{worker:true,coordinator:true,replica:true},gpu:[],ramMiB:100,cpuCores:2,diskMiB:0,modelsDir:dir};
  const runner=new AssignmentRunner({stateDir:dir,cfg:()=>({offer}),log:{warn(){},info(){},debug(){},error(){}},report(){},logLine(){}} as never);
  return {dir,offer,runner,async close(){await runner.stopAll();rmSync(dir,{recursive:true,force:true});}};
}
const assignment={kind:'worker',id:'owner-test',deploymentId:'dep-test',port:12345,device:'cpu',threads:1,allow:[]} as const;

test('disabled and revoked roles reject before role startup; valid owner still starts', async()=>{
  for(const mode of ['disabled','revoked','valid']) {
    const f=fixture(); let starts=0;
    (f.runner as any).startWorker=async()=>{starts++;};
    if(mode==='disabled') f.offer.enabled=false;
    if(mode==='revoked') f.offer.roles.worker=false;
    try {f.runner.handle(assignment as any); await Bun.sleep(5); expect(starts).toBe(mode==='valid'?1:0);}
    finally {await f.close();}
  }
});
test('owner revoked during pending startup is checked again before continuing',async()=>{
  const f=fixture(); let entered!:()=>void, release!:()=>void;
  const waiting=new Promise<void>(r=>entered=r), gate=new Promise<void>(r=>release=r);
  let admitted=false;
  (f.runner as any).startWorker=async(x:any)=>{entered();await gate;(f.runner as any).assertStarting(x);admitted=true;};
  try {f.runner.handle(assignment as any);await waiting;f.offer.enabled=false;release();await Bun.sleep(5);expect(admitted).toBe(false);expect(f.runner.snapshot()[0]?.state).toBe('failed');}
  finally {release();await f.close();}
});
test('active managed work rejects owner reductions and disable but permits increases',async()=>{
  const f=fixture();(f.runner as any).startWorker=async()=>{};
  try {
    f.runner.handle(assignment as any);await Bun.sleep(5);
    expect(()=>f.runner.assertOfferChange({...f.offer,enabled:false})).toThrow('owner offer');
    expect(()=>f.runner.assertOfferChange({...f.offer,ramMiB:99})).toThrow('stop managed');
    expect(()=>f.runner.assertOfferChange({...f.offer,cpuCores:1})).toThrow('stop managed');
    expect(()=>f.runner.assertOfferChange({...f.offer,ramMiB:101})).not.toThrow();
    await f.runner.stopAll();expect(()=>f.runner.assertOfferChange({...f.offer,enabled:false,ramMiB:0})).not.toThrow();
  } finally {await f.close();}
});
test('CLI rejected offer leaves disk unchanged and returns failure',async()=>{
  const f=fixture();const server=Bun.serve({port:0,fetch:()=>Response.json({errors:['refused']},{status:400})});
  const path=join(f.dir,'node.json');writeFileSync(path,JSON.stringify({uiPort:server.port,offer:f.offer}));const before=readFileSync(path,'utf8');
  try {
    const child=Bun.spawn([process.execPath,resolve(import.meta.dir,'../main.ts'),'offer','set','ramMiB=-1'],{env:{...process.env,SWARMLET_HOME:f.dir},stdout:'pipe',stderr:'pipe'});
    expect(await child.exited).toBe(1);expect(await new Response(child.stderr).text()).toContain('offer rejected (400)');expect(readFileSync(path,'utf8')).toBe(before);
  } finally {server.stop(true);await f.close();}
});
test('missing Linux systemd fails closed without starting an engine',async()=>{
  const code=`import {enforce} from ${JSON.stringify(resolve(import.meta.dir,'../enforce/index.ts'))};Object.defineProperty(process,'platform',{value:'linux'});Bun.spawn=()=>{throw Error('ENOENT')};try{await enforce('test',['never-start'],{ramMiB:100,cpuCores:1},{warn(){}});process.exit(2)}catch(e){console.log(e.message)}`;
  const child=Bun.spawn([process.execPath,'--eval',code],{stdout:'pipe',stderr:'pipe'});
  expect(await child.exited).toBe(0);expect(await new Response(child.stdout).text()).toContain('systemd-run is required');
});
