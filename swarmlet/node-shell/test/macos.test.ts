import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
const source=readFileSync(new URL('../frontend/macos.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../frontend/macos.css',import.meta.url),'utf8');
function run(origin:string,readyState='complete') {
  const styleNodes:any[]=[],bodyNodes:any[]=[],footNodes:any[]=[],listeners:Record<string,Function>={};
  const status={id:'head-conn'},brand={textContent:''};
  const document={readyState,documentElement:{dataset:{}},head:{appendChild:(n:any)=>styleNodes.push(n)},body:{appendChild:(n:any)=>bodyNodes.push(n)},
    getElementById:(id:string)=>styleNodes.find(n=>n.id===id),createElement:()=>({attrs:{},setAttribute(k:string,v:string){this.attrs[k as keyof typeof this.attrs]=v as never;},addEventListener:()=>{}}),
    querySelector:(selector:string)=>selector==='.head-status'?status:selector==='.sidebar-foot'?{appendChild:(n:any)=>footNodes.push(n)}:selector==='.brand-sub'?brand:null,
    addEventListener:(type:string,cb:Function)=>{listeners[type]=cb;}};
  const url=new URL(origin);new Function('location','document',source.replace('__SWARMLET_NATIVE_CSS__',JSON.stringify(css)))(url,document);
  return {document,styleNodes,bodyNodes,footNodes,status,listeners};
}
test('native skin applies only to the exact owner UI and bundled splash',()=>{
  for(const url of ['http://127.0.0.1:47800/','tauri://localhost/index.html']) {
    const f=run(url);expect(f.styleNodes).toHaveLength(1);expect(f.styleNodes[0].textContent).toBe(css);
    expect(f.bodyNodes[0].attrs['data-tauri-drag-region']).toBe('true');expect(f.footNodes[0]).toBe(f.status);
  }
  for(const url of ['https://example.com/','http://127.0.0.1:47900/','https://127.0.0.1:47800/','http://127.0.0.1.evil.test:47800/']) {
    const f=run(url);expect(f.styleNodes).toHaveLength(0);expect(f.bodyNodes).toHaveLength(0);
  }
});
test('early native initialization waits for DOM and is idempotent',()=>{
  const f=run('http://127.0.0.1:47800/','loading');expect(f.styleNodes).toHaveLength(0);
  f.listeners.DOMContentLoaded!();f.listeners.DOMContentLoaded!();expect(f.styleNodes).toHaveLength(1);expect(f.bodyNodes).toHaveLength(1);
});
