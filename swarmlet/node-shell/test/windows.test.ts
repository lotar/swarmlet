import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
const source=readFileSync(new URL('../frontend/windows.js',import.meta.url),'utf8');
// The shell ships macos.css re-targeted to the Windows shell plus windows.css; mirror that here.
const css=readFileSync(new URL('../frontend/macos.css',import.meta.url),'utf8').replaceAll("data-native-shell='macos'","data-native-shell='windows'")+'\n'+readFileSync(new URL('../frontend/windows.css',import.meta.url),'utf8');
type Node={tag:string;attrs:Record<string,string>;children:Node[];textContent:string;className:string;id:string;type:string;title:string;tabIndex:number;handlers:Record<string,Function>;setAttribute(k:string,v:string):void;getAttribute(k:string):string|null;appendChild(n:Node):Node;addEventListener(t:string,cb:Function):void};
function el(tag:string):Node { return {tag,attrs:{},children:[],textContent:'',className:'',id:'',type:'',title:'',tabIndex:0,handlers:{},setAttribute(k,v){this.attrs[k]=v;},getAttribute(k){return this.attrs[k]??null;},appendChild(n){this.children.push(n);return n;},addEventListener(t,cb){this.handlers[t]=cb;}}; }
function run(origin:string,backdrop='mica',readyState='complete') {
  const styleNodes:Node[]=[],bodyNodes:Node[]=[],footNodes:any[]=[],listeners:Record<string,Function>={},invoked:string[]=[],winListeners:Record<string,Function>={};
  const status={id:'head-conn'},brand={textContent:''};
  const document={readyState,documentElement:{dataset:{} as Record<string,string>},head:{appendChild:(n:Node)=>styleNodes.push(n)},body:{appendChild:(n:Node)=>bodyNodes.push(n)},
    getElementById:(id:string)=>styleNodes.find(n=>n.id===id),createElement:el,
    querySelector:(selector:string)=>selector==='.head-status'?status:selector==='.sidebar-foot'?{appendChild:(n:any)=>footNodes.push(n)}:selector==='.brand-sub'?brand:null,
    addEventListener:(type:string,cb:Function)=>{listeners[type]=cb;}};
  const window={__TAURI_INTERNALS__:{invoke:(cmd:string)=>{invoked.push(cmd);return Promise.resolve();}},outerWidth:1100,outerHeight:760,addEventListener:(t:string,cb:Function)=>{winListeners[t]=cb;}};
  const screen={availWidth:1920,availHeight:1040};
  const url=new URL(origin);
  new Function('location','document','window','screen',source.replace('__SWARMLET_NATIVE_CSS__',JSON.stringify(css)).replace('__SWARMLET_NATIVE_BACKDROP__',JSON.stringify(backdrop)))(url,document,window,screen);
  return {document,styleNodes,bodyNodes,footNodes,status,brand,listeners,invoked,window,screen,winListeners};
}
test('Windows skin applies only to the owner UI and the bundled splash (http://tauri.localhost)',()=>{
  for(const url of ['http://127.0.0.1:47800/','http://tauri.localhost/index.html','tauri://localhost/index.html']) {
    const f=run(url);expect(f.styleNodes).toHaveLength(1);expect(f.styleNodes[0]!.textContent).toBe(css);
    expect(f.document.documentElement.dataset.nativeShell).toBe('windows');expect(f.document.documentElement.dataset.nativeBackdrop).toBe('mica');
    expect(f.bodyNodes[0]!.attrs['data-tauri-drag-region']).toBe('true');expect(f.footNodes[0]).toBe(f.status);expect(f.brand.textContent).toBe('On this PC');
  }
  for(const url of ['https://example.com/','http://127.0.0.1:47900/','https://127.0.0.1:47800/','http://tauri.localhost.evil.test/','http://127.0.0.1.evil.test:47800/']) {
    const f=run(url);expect(f.styleNodes).toHaveLength(0);expect(f.bodyNodes).toHaveLength(0);
  }
});
test('caption buttons drive the window through the permitted window-plugin commands only',()=>{
  const f=run('http://127.0.0.1:47800/');
  const caption=f.bodyNodes[1]!;expect(caption.className).toBe('native-caption');
  const [min,max,close]=caption.children;
  expect([min!.textContent,max!.textContent,close!.textContent]).toEqual(['\uE921','\uE922','\uE8BB']);
  expect([min!.attrs['aria-label'],max!.attrs['aria-label'],close!.attrs['aria-label']]).toEqual(['Minimize','Maximize','Close']);
  min!.handlers.click!();max!.handlers.click!();close!.handlers.click!();
  expect(f.invoked).toEqual(['plugin:window|minimize','plugin:window|internal_toggle_maximize','plugin:window|close']);
  // Maximized geometry flips the glyph to Restore.
  f.window.outerWidth=1920;f.window.outerHeight=1040;f.winListeners.resize!();
  expect(max!.textContent).toBe('\uE923');expect(max!.attrs['aria-label']).toBe('Restore');
});
test('no backdrop is recorded so the stylesheet can fall back to opaque surfaces; init waits for DOM and is idempotent',()=>{
  expect(run('http://127.0.0.1:47800/','none').document.documentElement.dataset.nativeBackdrop).toBe('none');
  const f=run('http://127.0.0.1:47800/','acrylic','loading');expect(f.styleNodes).toHaveLength(0);
  f.listeners.DOMContentLoaded!();f.listeners.DOMContentLoaded!();expect(f.styleNodes).toHaveLength(1);expect(f.bodyNodes).toHaveLength(2);
  expect(css).toContain("[data-native-backdrop='none']");
});
