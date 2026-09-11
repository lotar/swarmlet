// PLAYWRIGHT_MODULE=/path/to/playwright node swarmlet/e2e/chat-scroll-browser.cjs
// Start chat-scroll-fixture.ts first. Supports installed node assets via its LIVE_ASSETS mode.
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = process.env.SCROLL_FIXTURE_URL || 'http://host.docker.internal:47831';
(async () => {
  for (const [engine, browserType] of Object.entries({ chromium, webkit })) {
    const browser = await browserType.launch({ headless: true });
    try {
      for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
        const page = await browser.newPage({ viewport, hasTouch: viewport.width < 600 });
        page.setDefaultTimeout(15000);
        console.log('RUN', engine, viewport.width);
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => localStorage.setItem('swarmlet.node.chat.v1', JSON.stringify({ messages: [{ role: 'assistant', content: Array.from({ length: 70 }, (_, i) => 'Earlier paragraph ' + i + '\n\n').join('') }] })));
        await page.goto(base + '/#chat');
        await page.waitForFunction(() => !document.getElementById('chat-send').disabled);
        const transcript = page.locator('#chat-transcript');
        const state = () => transcript.evaluate(el => ({ top: el.scrollTop, gap: el.scrollHeight - el.clientHeight - el.scrollTop, height: el.scrollHeight }));
        const bottom = async label => { await page.waitForFunction(() => { const el = document.getElementById('chat-transcript'); return el.scrollHeight - el.clientHeight - el.scrollTop <= 1; }); assert.ok((await state()).gap <= 1, label); };
        let n = 0;
        async function chunk(lines = 8, done = false) {
          const marker = 'Chunk ' + (++n);
          const response = await page.request.post(base + '/fixture/chunk', { data: { content: Array.from({ length: lines }, (_, i) => marker + ' paragraph ' + i + '\n\n').join(''), done } });
          assert.ok(response.ok(), await response.text());
          await page.waitForFunction(marker => document.querySelector('#chat-transcript .chat-message:last-child').textContent.includes(marker), marker);
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        }
        await transcript.evaluate(el => { el.scrollTop = 100; });
        await page.locator('#chat-input').fill('Follow this reply');
        await page.locator('#chat-send').click();
        await page.waitForFunction(() => document.getElementById('chat-transcript').getAttribute('aria-busy') === 'true');
        await bottom('Send jumps from history to bottom');
        for (let i = 0; i < 3; i++) { await chunk(); await bottom('Each streamed chunk follows'); }
        await transcript.scrollIntoViewIfNeeded();
        const bounds = await transcript.boundingBox();
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.mouse.wheel(0, -45);
        await page.waitForFunction(() => { const el = document.getElementById('chat-transcript'); return el.scrollHeight - el.clientHeight - el.scrollTop > 10; });
        await page.waitForTimeout(350); // Let native wheel animation settle before measuring a held position.
        const held = await state();
        assert.ok(held.gap < 100, 'Small counter-scroll covers old 100px heuristic');
        for (let i = 0; i < 3; i++) { await chunk(); assert.ok(Math.abs((await state()).top - held.top) <= 1, 'Counter-scroll preserves reading position: ' + JSON.stringify({ held, current: await state() })); }
        await transcript.evaluate(el => { el.scrollTop = el.scrollHeight; });
        await bottom('Returning to bottom resumes');
        await chunk(); await bottom('Following resumes on next chunk');
        // Scroll events also cover scrollbar dragging, keyboard and touch (no wheel event).
        await transcript.evaluate(el => { el.scrollTop -= 180; });
        await page.waitForTimeout(50);
        const dragged = await state();
        await chunk(30, true);
        await page.waitForFunction(() => document.getElementById('chat-transcript').getAttribute('aria-busy') === 'false');
        assert.ok(Math.abs((await state()).top - dragged.top) <= 1, 'Non-wheel scroll and completion preserve position');
        await page.locator('#chat-input').fill('Start following again');
        await page.locator('#chat-input').press('Enter');
        await bottom('Next Send resets opt-out');
        await chunk(30, true); await bottom('Large final chunk stays visible');
        await page.waitForFunction(() => document.getElementById('chat-transcript').getAttribute('aria-busy') === 'false');
        assert.deepEqual(errors, []);
        if (process.env.SCROLL_SCREENSHOTS) await page.screenshot({ path: process.env.SCROLL_SCREENSHOTS + '/' + engine + '-' + viewport.width + '.png' });
        console.log('PASS', engine, viewport.width, 'send / stream / small counter-scroll / hold / resume / non-wheel / completion / next send');
        await page.close();
      }
    } finally { await browser.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
