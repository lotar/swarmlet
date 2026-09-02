const { chromium } = require('playwright-chromium');
const assert = require('node:assert/strict');

const URL = 'http://host.docker.internal:8124/?gl=force';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  const errors = [];
  const tagRequests = [];
  const wishlistRequests = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.route('https://www.googletagmanager.com/**', (route) => {
    tagRequests.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
  });
  await page.route(/https:\/\/([^/]+\.)?google-analytics\.com\/.*/, (route) => route.fulfill({ status: 204, body: '' }));
  await page.route('**/api/wishlist', (route) => {
    const request = route.request();
    wishlistRequests.push({
      method: request.method(),
      contentType: request.headers()['content-type'],
      body: request.postDataJSON(),
    });
    return route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1200);

  assert.equal(await page.locator('#analytics-consent').isVisible(), true);
  assert.equal(tagRequests.length, 0);
  await page.screenshot({ path: '/screenshots/swarmlet-analytics-consent.png' });
  await page.locator('#analytics-deny').click();
  assert.equal(await page.locator('#analytics-consent').isHidden(), true);
  assert.equal(await page.evaluate(() => localStorage.getItem('swarmlet.analytics-consent.v1')), 'denied');
  assert.equal(tagRequests.length, 0);

  assert.equal((await page.locator('h1').innerText()).replace(/\s+/g, ' '), 'ONE LARGE MODEL. MANY ORDINARY MACHINES.');
  assert.equal(await page.locator('.road-item').count(), 7);
  assert.equal(await page.locator('.road-item[data-state="now"] h3').innerText(), 'Adaptive split planner');
  await page.screenshot({ path: '/screenshots/swarmlet-hero-desktop.png' });

  for (const target of ['split', 'proof', 'roadmap', 'product', 'join']) {
    await page.locator(`#${target}`).scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);
    if (['split', 'roadmap', 'product'].includes(target)) {
      await page.screenshot({ path: `/screenshots/swarmlet-${target}-desktop.png` });
    }
  }

  const graphState = await page.evaluate(() => ({
    scenes: window.__sw.views.map((view) => view.canvas.dataset.scene).sort(),
    errors: window.__sw.err,
  }));
  assert.deepEqual(graphState.scenes, ['adaptive', 'federation', 'split']);
  assert.deepEqual(graphState.errors, []);

  await page.locator('a[href="#roadmap"]').first().click();
  await page.waitForTimeout(1400);
  assert.equal(await page.evaluate(() => location.hash), '#roadmap');
  const roadmapTop = await page.locator('#roadmap').evaluate((el) => el.getBoundingClientRect().top);
  assert.ok(roadmapTop >= 100 && roadmapTop <= 120, `roadmap anchor landed at ${roadmapTop}px`);

  await page.locator('#analytics-settings').click();
  await page.locator('#analytics-allow').click();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => localStorage.getItem('swarmlet.analytics-consent.v1')), 'granted');
  assert.equal(tagRequests.length, 1);
  const analyticsConfig = await page.evaluate(() => window.dataLayer
    .map((item) => Array.from(item))
    .find((item) => item[0] === 'config'));
  assert.equal(analyticsConfig[2].page_location, 'http://host.docker.internal:8124/');
  assert.equal(analyticsConfig[2].page_location.includes('gl=force'), false);

  await page.locator('#wishlist-email').fill('not-an-email');
  await page.locator('#wishlist-form button').click();
  assert.equal(await page.locator('#wishlist-email').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('#wishlist-error').innerText(), 'Enter a complete email address.');
  await page.locator('#wishlist-email').fill('builder@example.com');
  await page.locator('#wishlist-form button').click();
  assert.equal(await page.locator('#wishlist-form').getAttribute('class'), 'join-form is-ready');
  assert.equal(await page.locator('#wishlist-status h3').innerText(), "You're on the wishlist.");
  const analyticsEvents = await page.evaluate(() => window.dataLayer
    .map((item) => Array.from(item))
    .filter((item) => item[0] === 'event'));
  assert.deepEqual(analyticsEvents, [['event', 'wishlist_signup', { form_location: 'homepage' }]]);
  assert.equal(JSON.stringify(analyticsEvents).includes('builder@example.com'), false);
  assert.deepEqual(wishlistRequests, [{
    method: 'POST',
    contentType: 'application/json',
    body: { email: 'builder@example.com' },
  }]);

  const widths = [320, 375, 768, 1024, 1440];
  const overflow = {};
  for (const width of widths) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(250);
    overflow[width] = await page.evaluate(() => { window.scrollTo(999, 0); const x = window.scrollX; window.scrollTo(0, 0); return x; });
    assert.equal(overflow[width], 0, `horizontal overflow at ${width}px`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.screenshot({ path: '/screenshots/swarmlet-hero-mobile.png' });
  await page.locator('#roadmap').scrollIntoViewIfNeeded();
  await page.waitForTimeout(350);
  await page.screenshot({ path: '/screenshots/swarmlet-roadmap-mobile.png' });

  const reduced = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });
  const reducedPage = await reduced.newPage();
  await reducedPage.addInitScript(() => {
    window.__rafCalls = 0;
    const original = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => { window.__rafCalls += 1; return original(callback); };
  });
  await reducedPage.goto(URL, { waitUntil: 'networkidle' });
  await reducedPage.locator('#product').scrollIntoViewIfNeeded();
  await reducedPage.waitForTimeout(400);
  assert.equal(await reducedPage.evaluate(() => window.__rafCalls), 0);
  await reduced.close();

  const noScript = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const noScriptPage = await noScript.newPage();
  await noScriptPage.goto('http://host.docker.internal:8124/', { waitUntil: 'networkidle' });
  assert.equal(await noScriptPage.locator('.hero-copy').evaluate((el) => getComputedStyle(el).opacity), '1');
  assert.ok((await noScriptPage.locator('main').innerText()).length > 3000);
  await noScript.close();

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ scenes: graphState.scenes, overflow, errors, wishlist: 'invalid + valid', analytics: 'opt-in + wishlist_signup without PII', reducedMotionRaf: 0, noScript: true }, null, 2));
  await context.close();
  await browser.close();
})().catch((error) => { console.error(error); process.exit(1); });
