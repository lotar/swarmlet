/* CDP probe for the teaser site: load a URL in headless Chrome, collect console errors, evaluate an
   expression, optionally screenshot. No dependencies (Node 22+ has fetch + WebSocket).

   node tools/site/probe.mjs "http://localhost:8123/?gl=force" 'window.__sw.views.length'
   node tools/site/probe.mjs URL @expr.js          # expression from a file (multi-line)
   SHOT=/tmp/hero.png SCROLL=1250 node tools/site/probe.mjs URL ...   # screenshot after a scroll
   RM=1 MOBILE=1 W=390 H=844 DPR=3 ...             # emulate reduced motion / a phone
*/
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2];
let expr = process.argv[3] || 'document.readyState';
if (expr.startsWith('@')) expr = (await import('node:fs')).readFileSync(expr.slice(1), 'utf8');
const chrome = process.env.CHROME_BIN || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].find(existsSync);
if (!chrome) { console.error('Chrome/Chromium not found; set CHROME_BIN'); process.exit(2); }
const port = +(process.env.PROBE_PORT || 9337);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chromeProc = spawn(chrome, [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl',
  `--user-data-dir=${join(tmpdir(), `chrome-cdp-${port}`)}`, `--remote-debugging-port=${port}`,
  '--window-size=1440,900', 'about:blank'
], { stdio: 'ignore' });

let ws;
for (let i = 0; i < 60 && !ws; i++) {
  try {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
    const t = list.find(t => t.type === 'page');
    if (t) ws = new WebSocket(t.webSocketDebuggerUrl);
  } catch { await sleep(250); }
  if (!ws) await sleep(250);
}
if (!ws) { console.error('no devtools page target'); chromeProc.kill(); process.exit(1); }

await new Promise(r => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
const errors = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Inspector.targetCrashed') errors.push('TARGET CRASHED (renderer process died)');
  if (m.method === 'Runtime.executionContextDestroyed') errors.push('context destroyed');
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push((m.params.args || []).map(a => a.value || a.description).join(' '));
});
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

const watchdog = setTimeout(() => { console.error('PROBE TIMEOUT: page never settled (wedged main thread?)'); try { ws.close(); } catch {} chromeProc.kill('SIGKILL'); process.exit(2); }, (+(process.env.WAIT || 4200)) + 60000);
process.on('exit', () => { try { chromeProc.kill('SIGKILL'); } catch {} });
await send('Runtime.enable'); await send('Inspector.enable');
await send('Timeout.enable', { timeout: +(process.env.EXPR_TIMEOUT || 45000) });
if (process.env.SPY) await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__raf=0;const o=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=function(f){window.__raf++;return o(f);};' });
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: +(process.env.W || 1440), height: +(process.env.H || 900), deviceScaleFactor: +(process.env.DPR || 2), mobile: process.env.MOBILE === '1' });
if (process.env.RM === '1') await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await send('Page.navigate', { url });
await sleep(+(process.env.WAIT || 4200));
if (process.env.SPY) await sleep(2000);
const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
if (r.result) console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value ?? r.result, null, 1));
else console.log(JSON.stringify(r).slice(0, 500));
if (process.env.SCROLL) { await send('Runtime.evaluate', { expression: 'scrollTo(0,' + process.env.SCROLL + ')', returnByValue: true }); await sleep(+(process.env.SCROLLWAIT || 2200)); }
if (process.env.SHOT) {
  const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (!s.result || !s.result.data) { console.log('screenshot error:', JSON.stringify(s).slice(0, 300)); } else {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.SHOT, Buffer.from(s.result.data, 'base64'));
  console.log('shot:', process.env.SHOT);
  }
}
console.log('console/exceptions:', errors.length ? errors : 'none');
clearTimeout(watchdog); ws.close(); chromeProc.kill(); process.exit(0);
