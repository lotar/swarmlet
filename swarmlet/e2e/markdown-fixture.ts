// Read-only API proxy; chat POSTs return the deterministic fixture without running inference.
// bun swarmlet/e2e/markdown-fixture.ts; open :47820/#chat and :47920/#chat, send a message,
// then run browse eval swarmlet/e2e/markdown-browser-check.js. Override upstream URLs/config via env.
import { serveUi as nodeUi } from '../node-agent/ui/ui.ts';
import { serveUi as controlUi } from '../control/ui/ui.ts';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
const cfg=JSON.parse(readFileSync(process.env.SWARMLET_FIXTURE_CONTROL_CONFIG || join(homedir(), '.swarmlet/control/control.json'),'utf8'));
const markdown=readFileSync(new URL('./fixtures/chat-markdown.md', import.meta.url),'utf8');
for(const [port,ui,base] of [[47820,nodeUi,process.env.SWARMLET_FIXTURE_NODE_URL || 'http://127.0.0.1:47800'],[47920,controlUi,process.env.SWARMLET_FIXTURE_CONTROL_URL || 'http://127.0.0.1:47900']] as const){
 let lastRequest:unknown=null,tracking=0;
 Bun.serve({hostname:'127.0.0.1',port,async fetch(req){
  const url=new URL(req.url),path=url.pathname;
  if(path==='/fixture-state')return Response.json({lastRequest,tracking,markdown});
  if(path==='/tracking'){tracking++;return new Response('unexpected image request');}
  if(path==='/v1/chat/completions' && req.method==='POST'){
   lastRequest=await req.json();
   const stream=new ReadableStream({async start(controller){
    const enc=new TextEncoder();
    controller.enqueue(enc.encode('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'**Reasoning check**'}}]})+'\n\n'));
    for(let i=0;i<markdown.length;i+=19){controller.enqueue(enc.encode('data: '+JSON.stringify({choices:[{delta:{content:markdown.slice(i,i+19)}}]})+'\n\n'));await Bun.sleep(25);}
    controller.enqueue(enc.encode('data: [DONE]\n\n'));controller.close();
   }});
   return new Response(stream,{headers:{'content-type':'text/event-stream','x-swarmlet-route':'mesh'}});
  }
  const asset=ui(req,path);if(asset)return asset;
  if(req.method==='GET'){
   const r=await fetch(base+path+url.search,{headers:port === 47920?{Authorization:'Bearer '+cfg.adminToken,'User-Agent':'Swarmlet/0.1'}:{}});
   return new Response(r.body,{status:r.status,headers:{'content-type':r.headers.get('content-type')||'application/json'}});
  }
  return new Response('fixture only',{status:405});
 }});
 console.log('Markdown fixture',port);
}
