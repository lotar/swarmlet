/* Trace probe: what actually runs long on a throttled mobile load. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const url = process.argv[2];
const port = +(process.env.PROBE_PORT || 9361);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = process.env.CHROME_BIN || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].find(existsSync);
if (!chrome) { console.error('Chrome/Chromium not found; set CHROME_BIN'); process.exit(2); }
const p = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${join(tmpdir(), `chrome-cdp-${port}`)}`, `--remote-debugging-port=${port}`, '--window-size=390,844'], { stdio: 'ignore' });
let ws;
for (let i = 0; i < 60 && !ws; i++) {
  try { const l = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()); const t = l.find(t => t.type === 'page'); if (t) ws = new WebSocket(t.webSocketDebuggerUrl); } catch { }
  if (!ws) await sleep(250);
}
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pending = new Map(); const events = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Tracing.dataCollected') (m.params.value || []).forEach(ev => events.push(ev));
});
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Emulation.setCPUThrottlingRate', { rate: 4 });
await send('Tracing.start', { categories: 'devtools.timeline,v8,disabled-by-default-v8.compile', transferMode: 'ReportEvents' });
await send('Page.navigate', { url });
await sleep(6500);
await send('Tracing.end');
await sleep(1500);
const want = new Set(['RunTask', 'EvaluateScript', 'FunctionCall', 'v8.compile', 'CompileScript', 'TimerFire', 'RequestAnimationFrame', 'FireAnimationFrame', 'UpdateLayoutTree', 'Layout', 'Paint', 'CompileCode', 'v8.run']);
const long = events.filter(e => e.ph === 'X' && e.dur > 40000 && want.has(e.name))
  .map(e => ({ name: e.name, ms: +(e.dur / 1000).toFixed(1), at: +((e.ts - events[0].ts) / 1000).toFixed(0), url: (e.args && e.args.data && (e.args.data.url || e.args.data.typeName)) || '', fn: (e.args && e.args.data && (e.args.data.functionName || e.args.data.functionName === '' ? e.args.data.functionName : '')) || '' }))
  .sort((a, b) => b.ms - a.ms).slice(0, 14);
console.log(JSON.stringify(long, null, 1));
const byName = {};
events.filter(e => e.ph === 'X' && want.has(e.name)).forEach(e => { byName[e.name] = (byName[e.name] || 0) + e.dur / 1000; });
console.log('totals(ms):', Object.entries(byName).map(([k, v]) => k + '=' + v.toFixed(0)).join(' '));
ws.close(); p.kill(); process.exit(0);
