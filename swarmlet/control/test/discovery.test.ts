import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSocket } from 'node:dgram';
import { bootControl } from '../server.ts';
import { loadControlConfig } from '../config.ts';
import { ensureKeys, readPublicJwk, signObject } from '../../protocol/sign.ts';
import { verifyAnnouncement, type ControlAnnouncement } from '../../protocol/discovery.ts';
import { discoverControl } from '../../node-agent/discovery.ts';
import { agentPaths } from '../../node-agent/paths.ts';
import { loadIdentity } from '../../node-agent/identity.ts';
import { enroll, AgentClient } from '../../node-agent/agent.ts';
import { defaultOffer } from '../../node-agent/config.ts';
import { makeLogger } from '../log.ts';
import type { Capabilities, EnrollResponse } from '../../protocol/types.ts';
const caps:Capabilities={os:'linux',arch:'x64',hostname:'new-node',ramMiB:8192,ramReserveMiB:4096,cpuCores:4,gpus:[],diskFreeMiB:1000,privateIps:['127.0.0.1'],measuredAt:new Date().toISOString()};
test('real UDP announcement auto-enrolls a fresh identity and reconnects without a join code',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'swarmlet-discovery-'));
  const cfg=loadControlConfig({dataDir:join(dir,'control'),host:'127.0.0.1',port:0,logLevel:'warn',lanAutoEnroll:true});
  const ctl=await bootControl(cfg), url=`http://127.0.0.1:${ctl.server.port}/`;
  const id=await loadIdentity(agentPaths(join(dir,'node'))), key=await ensureKeys(join(cfg.dataDir,'keys')), pubJwk=await readPublicJwk(join(cfg.dataDir,'keys'));
  const announcement:ControlAnnouncement={t:'swarmlet-control',version:1,url,time:Date.now(),pubJwk};
  const bytes=Buffer.from(JSON.stringify(await signObject(announcement,key.priv)));
  const log=makeLogger('discovery-test','warn');let bound=false, count=0, result:EnrollResponse|undefined, client:AgentClient|undefined;
  let ready!:(port:number)=>void;const listening=new Promise<number>(r=>{ready=r});
  const stop=discoverControl({port:0,onListening:ready,bound:()=>bound,log,join:async (u,k)=>{result=await enroll(u,'',id,caps,k);bound=true;count++;}});
  const sender=createSocket('udp4');
  try {
    const port=await listening;sender.send(bytes,port,'127.0.0.1');
    for(let i=0;i<100&&!bound;i++) await Bun.sleep(10);
    expect(bound).toBe(true);expect(result!.nodeId).toBe(id.nodeId);expect(ctl.reg.getNode(id.nodeId)?.offer).toBeNull();
    sender.send(bytes,port,'127.0.0.1');await Bun.sleep(20);expect(count).toBe(1);
    const offer=defaultOffer(dir);
    client=new AgentClient(result!.agentUrl,id,{caps:()=>caps,offer:()=>offer,models:()=>[],metrics:()=>({ts:new Date().toISOString()}),assignments:()=>[],onAssign:()=>{},allowedPorts:()=>new Set()},log);
    client.start();await Promise.race([client.whenConnected(),Bun.sleep(2000).then(()=>{throw Error('connect timeout')})]);
    for(let i=0;i<50&&!ctl.reg.getNode(id.nodeId)?.offer;i++) await Bun.sleep(10);
    // The shipped default is contributing (enabled), not idle: the resources behind it are filled in
    // from measured capabilities, so `enabled` here is the owner's intent, not a resource claim.
    expect(ctl.reg.getNode(id.nodeId)?.offer?.enabled).toBe(true);
    expect((await enroll(url,'',id,caps,pubJwk)).nodeId).toBe(id.nodeId);
    cfg.lanAutoEnroll=false;const foreign=await loadIdentity(agentPaths(join(dir,'foreign')));
    await expect(enroll(url,'',foreign,caps,pubJwk)).rejects.toThrow('403');
    const forwarded=await fetch(url+'enroll',{method:'POST',headers:{'x-forwarded-for':'127.0.0.1','content-type':'application/json'},body:'{}'});
    expect(forwarded.status).toBe(404);
  } finally {client?.stop();stop();sender.close();ctl.channel.shuttingDown=true;ctl.deployments.dispose();ctl.server.stop(true);ctl.reg.close();}
});
test('discovery rejects forged, expired, public, redirected and differently pinned announcements',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'swarmlet-announcement-')),keys=await ensureKeys(dir),pubJwk=await readPublicJwk(dir);
  const msg:ControlAnnouncement={t:'swarmlet-control',version:1,url:'http://192.168.1.53:47900/',time:Date.now(),pubJwk};
  const encoded=async(m:ControlAnnouncement)=>Buffer.from(JSON.stringify(await signObject(m,keys.priv)));
  expect(await verifyAnnouncement(await encoded(msg),'192.168.1.53')).not.toBeNull();
  expect(await verifyAnnouncement(await encoded(msg),'8.8.8.8')).toBeNull();
  expect(await verifyAnnouncement(await encoded(msg),'192.168.1.52')).toBeNull();
  expect(await verifyAnnouncement(await encoded({...msg,time:Date.now()-60000}),'192.168.1.53')).toBeNull();
  expect(await verifyAnnouncement(await encoded({...msg,url:'http://192.168.1.53:47900/private'}),'192.168.1.53')).toBeNull();
  const signed=JSON.parse((await encoded(msg)).toString());signed.time++;
  expect(await verifyAnnouncement(Buffer.from(JSON.stringify(signed)),'192.168.1.53')).toBeNull();
  const other=mkdtempSync(join(tmpdir(),'swarmlet-other-'));await ensureKeys(other);
  expect(await verifyAnnouncement(await encoded(msg),'192.168.1.53',await readPublicJwk(other))).toBeNull();
});
