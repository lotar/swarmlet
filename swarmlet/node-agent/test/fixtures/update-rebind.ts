import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { agentPaths } from '../../paths.ts';
import { loadNodeConfig, saveNodeConfig } from '../../config.ts';
import { loadIdentity } from '../../identity.ts';
import { signObject } from '../../../protocol/sign.ts';
import { readUpdateState } from '../../update-state.ts';
import { supervise } from '../../supervisor.ts';
const root=await mkdtemp(join(tmpdir(),'swarmlet-rebind-repro-'));
process.env.SWARMLET_HOME=root;
const paths=agentPaths(); const identity=await loadIdentity(paths);
const a=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']) as CryptoKeyPair;
const b=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']) as CryptoKeyPair;
const pubA=await crypto.subtle.exportKey('jwk',a.publicKey), pubB=await crypto.subtle.exportKey('jwk',b.publicKey);
const cfg={...loadNodeConfig(paths),controlUrl:'http://controller-a.invalid',controlPubJwk:pubA};saveNodeConfig(paths,cfg);
const bytes='fake agent bytes never executed'; const now=Date.now();
const manifest=await signObject({kind:'swarmlet-release',schema:1,sequence:1,version:'a-1',platform:process.platform,arch:process.arch,issuedAt:now,expiresAt:now+600000,files:[{path:'swarmlet-node',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]},a.privateKey);
const phase=process.argv[2] || 'download';
const rebind=()=>{saveNodeConfig(paths,{...cfg,controlUrl:phase==='key'?cfg.controlUrl:'http://controller-b.invalid',controlPubJwk:pubB});rebound=true;};
let current:any, nextPid=400000, rebound=false, leaseHosts:string[]=[];
Bun.spawn=((args:any,opts:any)=>{let resolve:any;const exited=new Promise(r=>resolve=r);current={pid:++nextPid,exitCode:null,exited,release:Number(opts.env.SWARMLET_RELEASE_SEQUENCE),send(m:any){if(m.action==='stop'){this.exitCode=0;resolve(0);}else {if(m.action==='drain' && phase==='drain')rebind();opts.ipc({kind:'swarmlet-supervisor-result',id:m.id,ok:true});}},kill(){this.exitCode=0;resolve(0);}};return current;}) as any;
globalThis.fetch=(async(input:any,init:any)=>{const u=new URL(String(input)); if(u.pathname==='/api/status')return Response.json({pid:current.pid,nodeId:identity.nodeId,connected:true,releaseSequence:current.release});
if(u.pathname.endsWith('/manifest.json'))return Response.json(manifest);
if(u.pathname.endsWith('/swarmlet-node')){if(phase==='download'||phase==='key')rebind();return new Response(bytes);}
if(u.pathname==='/node-update-lease'){leaseHosts.push(u.hostname); const req=JSON.parse(init.body);if(req.action==='acquire'&&phase==='lease')rebind();return Response.json(await signObject({kind:'swarmlet-update-lease-result',nonce:req.nonce,nodeId:identity.nodeId,lease:req.action==='acquire'?{nodeId:identity.nodeId,token:crypto.randomUUID(),expiresAt:Date.now()+120000}:null},a.privateKey));}
throw Error('unexpected '+u);
}) as any;
const timer=setTimeout(()=>process.emit('SIGTERM'),1500);
try {await supervise(['unused'],{initialMs:0,checkMs:60000}); console.log(JSON.stringify({rebound,currentBinding:loadNodeConfig(paths).controlUrl,state:await readUpdateState(join(paths.stateDir,'updates.json')),leaseHosts}));}
finally{clearTimeout(timer);await rm(root,{recursive:true,force:true});}
