import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { startWishlistServer } from './wishlist.mjs';

const ORIGIN = 'https://swarmlet.ai';

async function stop(running) {
  await new Promise((resolve, reject) => running.server.close((error) => error ? reject(error) : resolve()));
  running.service.close();
}

function rows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const result = db.prepare('SELECT email, created_at, consent_version FROM wishlist_subscribers ORDER BY email').all();
  db.close();
  return result.map((row) => ({ ...row }));
}

test('wishlist API validates, deduplicates, and persists', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'swarmlet-wishlist-'));
  const dbPath = join(directory, 'wishlist.sqlite');
  let running;

  try {
    running = await startWishlistServer({
      dbPath,
      host: '127.0.0.1',
      port: 0,
      now: () => '2026-09-01T12:00:00.000Z',
    });
    const address = running.server.address();
    const base = `http://127.0.0.1:${address.port}`;

    let response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);

    response = await fetch(`${base}/api/wishlist`);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');

    response = await fetch(`${base}/api/wishlist`, { method: 'POST', body: 'email=x' });
    assert.equal(response.status, 415);

    response = await fetch(`${base}/api/wishlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: '{not-json',
    });
    assert.equal(response.status, 400);

    response = await fetch(`${base}/api/wishlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ email: 'person@example.com', role: 'admin' }),
    });
    assert.equal(response.status, 400);

    response = await fetch(`${base}/api/wishlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
      body: JSON.stringify({ email: 'person@example.com' }),
    });
    assert.equal(response.status, 403);

    response = await fetch(`${base}/api/wishlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    assert.equal(response.status, 400);

    for (const email of [' Person@Example.com ', 'person@example.com']) {
      response = await fetch(`${base}/api/wishlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ email }),
      });
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { ok: true });
    }

    response = await fetch(`${base}/api/wishlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ email: 'autofilled@example.com', company: 'Autofilled Co' }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: 'invalid_request' });

    response = await fetch(`${base}/api/wishlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ email: `${'a'.repeat(1100)}@example.com` }),
    });
    assert.equal(response.status, 413);

    assert.deepEqual(rows(dbPath), [{
      email: 'person@example.com',
      created_at: '2026-09-01T12:00:00.000Z',
      consent_version: '2026-09-01',
    }]);

    await stop(running);
    running = await startWishlistServer({ dbPath, host: '127.0.0.1', port: 0 });
    assert.equal(rows(dbPath).length, 1);
  } finally {
    if (running?.server?.listening) await stop(running);
    rmSync(directory, { recursive: true, force: true });
  }
});
