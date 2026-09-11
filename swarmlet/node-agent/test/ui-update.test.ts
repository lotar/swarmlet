import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { serveUi } from '../ui/ui.ts';

const source = readFileSync(new URL('../ui/update.js', import.meta.url), 'utf8');
const initial = 'a'.repeat(64), next = 'b'.repeat(64);
function rig() {
  const document = new EventTarget() as EventTarget & Record<string, any>;
  document.hidden = false;
  document.querySelector = () => ({ content: initial });
  const note = { hidden: true };
  document.getElementById = () => note;
  let reloads = 0, calls = 0;
  const window: any = { location: { reload: () => reloads++ }, addEventListener() {} };
  let response = async () => Response.json({ version: next });
  new Function('document', 'window', 'fetch', 'setInterval', source)(document, window, () => { calls++; return response(); }, () => 0);
  const change = (field: any) => { const event = new Event('input'); Object.defineProperty(event, 'target', { value: field }); document.dispatchEvent(event); };
  return { document, note, update: window.SwarmletUiUpdate, change, reply: (fn: typeof response) => { response = fn; }, reloads: () => reloads, calls: () => calls };
}

test('unchanged UI and failed or malformed probes never reload; a valid update reloads once', async () => {
  const r = rig();
  for (const reply of [async () => Response.json({ version: initial }), async () => new Response('', { status: 503 }), async () => new Response('not json'), async () => Response.json({ version: 'bad' }), async () => { throw Error('agent restarting'); }]) {
    r.reply(reply); await r.update.check(); expect(r.reloads()).toBe(0);
  }
  r.reply(async () => Response.json({ version: next }));
  await r.update.check(); await r.update.check();
  expect(r.reloads()).toBe(1);
});

test('an in-flight version request is not duplicated', async () => {
  const r = rig(); let complete!: (value: Response) => void;
  r.reply(() => new Promise(resolve => { complete = resolve; }));
  const first = r.update.check(); await r.update.check();
  expect(r.calls()).toBe(1);
  complete(Response.json({ version: next })); await first;
  expect(r.reloads()).toBe(1);
});

test('settings edits and active mutations delay reload; saving cannot clear newer edits', async () => {
  const r = rig(), form = { id: 'offer-form' }, field = { form };
  r.change(field);
  const saved = r.update.checkpoint(form);
  const release = r.update.hold();
  await r.update.check(); expect(r.reloads()).toBe(0); expect(r.note.hidden).toBe(false);
  r.change(field); saved(); release(); release();
  await r.update.check(); expect(r.reloads()).toBe(0);
  r.update.clean(form); await r.update.check(); expect(r.reloads()).toBe(1);
});

test('saving an automatic checkbox change preserves other unsaved settings', async () => {
  const r = rig(), form = { id: 'offer-form' }, toggle = { form }, other = { form };
  r.change(other); r.change(toggle);
  r.update.checkpoint(toggle)();
  await r.update.check(); expect(r.reloads()).toBe(0);
  r.update.clean(form); await r.update.check(); expect(r.reloads()).toBe(1);
});

test('chat lifecycle can delay updates for streaming or failed draft storage', async () => {
  const r = rig(); const cancel = (event: Event) => event.preventDefault();
  r.change({ form: { id: 'chat-form' } });
  r.document.addEventListener('swarmlet:before-ui-update', cancel);
  await r.update.check(); expect(r.reloads()).toBe(0);
  r.document.removeEventListener('swarmlet:before-ui-update', cancel);
  await r.update.check(); expect(r.reloads()).toBe(1);
});

test('served HTML identifies its embedded UI and loads the update watcher before its consumers', async () => {
  const get = (path: string, method = 'GET') => serveUi(new Request('http://localhost' + path, { method }), path)!;
  const html = await get('/').text(), version = await get('/ui-version.json').json();
  expect(version.version).toMatch(/^[a-f0-9]{64}$/);
  expect(html).toContain('content="' + version.version + '"');
  expect(html).not.toContain('__SWARMLET_UI_VERSION__');
  expect(html.indexOf('src="/update.js"')).toBeLessThan(html.indexOf('src="/app.js"'));
  expect(await get('/update.js').text()).toContain('swarmlet:before-ui-update');
  expect(get('/ui-version.json').headers.get('cache-control')).toBe('no-store');
  expect(await get('/ui-version.json', 'HEAD').text()).toBe('');
  expect(get('/ui-version.json', 'POST').status).toBe(405);
});
