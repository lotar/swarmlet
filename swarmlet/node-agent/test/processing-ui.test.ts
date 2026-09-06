import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../../shared/ui/processing.js', import.meta.url), 'utf8');
class Element {
  children: Element[]=[]; textContent=''; className=''; style: Record<string,string>={}; dataset: Record<string,string>={}; hidden=false;
  ownerDocument: any;
  constructor(public tag='div') {}
  append(...nodes:Element[]) {this.children.push(...nodes);}
  replaceChildren(...nodes:Element[]) {this.children=nodes;}
  setAttribute() {}
  closest() {return this;}
  text():string {return this.textContent+' '+this.children.map(c=>c.text()).join(' ');}
}
function rig() {
  let now=0; const pending: Array<{url:string; resolve:(r:Response)=>void}>=[];
  const document={hidden:false,createElement:(tag:string)=>new Element(tag),addEventListener:()=>{}};
  const root=new Element(); root.ownerDocument=document;
  const window:any={addEventListener:()=>{}};
  new Function('window','performance','fetch','setInterval','clearInterval',source)(window,{now:()=>now},(url:string)=>new Promise<Response>(resolve=>pending.push({url,resolve})),()=>1,()=>{});
  const panel=window.SwarmletProcessing.create(root);
  const snapshot=(name:string)=>({sampledAt:new Date().toISOString(),deployment:{id:name,name,state:'ready'},totalLayers:24,nodes:[{name,id:name,role:'Worker',layers:3,sharePct:12.5,online:true,metricsState:'live',cpuPct:10,gpuUsedMiB:512}]});
  return {root,panel,pending,snapshot,stats:window.SwarmletProcessing.stats,time:(n:number)=>{now=n;}};
}
const drain=async()=>{await new Promise(resolve=>setTimeout(resolve,0));};
test('a late preview cannot relabel the actual serving deployment; stop never looks complete',async()=>{
  const r=rig(); r.panel.select('qwen','preview'); r.panel.begin('qwen','preview');
  r.panel.served(new Headers({'x-swarmlet-deployment':'actual'}));
  expect(r.pending[2]!.url).toContain('deployment=actual');
  r.pending[2]!.resolve(Response.json(r.snapshot('actual'))); await drain();
  r.pending[0]!.resolve(Response.json(r.snapshot('wrong'))); r.pending[1]!.resolve(Response.json(r.snapshot('wrong'))); await drain();
  expect(r.root.text()).toContain('actual'); expect(r.root.text()).not.toContain('wrong'); expect(r.root.text()).toContain('12.5%');
  r.time(1000);r.panel.feed({choices:[{delta:{reasoning_content:'thinking'}}]});
  r.time(2000);r.panel.feed({choices:[{delta:{content:'answer'}}]});
  expect(r.root.text()).toContain('≈ 1.0');
  r.panel.finish('stopped'); expect(r.root.text()).toContain('Response stopped'); expect(r.root.text()).not.toContain('Response complete');
});
test('response rates remain estimates until server timing; reported usage replaces delta counts',()=>{
  const r=rig(), s={state:'generating',chunks:5,first:1000,last:2000};
  expect(r.stats(s,3000)).toMatchObject({tokens:5,tps:2,estimated:true,exactTokens:false});
  expect(r.stats({...s,state:'complete',timings:{predicted_n:8,predicted_per_second:7.5}},3000)).toMatchObject({tokens:8,tps:7.5,estimated:false,exactTokens:true});
  expect(r.stats({...s,state:'complete',usage:{completion_tokens:8}},3000)).toMatchObject({tokens:8,estimated:true,exactTokens:true});
  expect(r.stats({state:'generating',chunks:0,first:null},1000).tps).toBeNull();
});
test('hidden chat does not poll; telemetry errors are visible without inventing CPU or activity',async()=>{
  const r=rig(); r.root.hidden=true; r.panel.select('qwen'); expect(r.pending).toHaveLength(0);
  r.root.hidden=false; r.panel.refresh(); expect(r.pending).toHaveLength(1);
  r.pending[0]!.resolve(new Response('unavailable',{status:503}));await drain();
  expect(r.root.text()).toContain('Telemetry unavailable'); expect(r.root.text()).not.toContain('Participating');
});

test('catalog refresh keeps the completed reply pinned to its actual deployment',async()=>{
  const r=rig();r.panel.begin('qwen');r.panel.served(new Headers({'x-swarmlet-deployment':'actual'}));
  r.pending[1]!.resolve(Response.json(r.snapshot('actual')));await drain();
  r.panel.finish('complete');r.panel.select('qwen');
  expect(r.root.text()).toContain('Response complete');expect(r.root.text()).toContain('actual');
  const count=r.pending.length;r.panel.refresh();expect(r.pending).toHaveLength(count);
});
