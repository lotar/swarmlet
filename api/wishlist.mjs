import { chmodSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const MAX_BODY_BYTES = 1024;
const CONSENT_VERSION = '2026-09-01';
const DEFAULT_ORIGIN = 'https://swarmlet.ai';

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Content-Type': 'application/json; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}

async function readJson(req) {
  const rawLength = req.headers['content-length'];
  if (rawLength !== undefined) {
    const length = Number(rawLength);
    if (!Number.isSafeInteger(length) || length < 0) throw new HttpError(400, 'invalid_request');
    if (length > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large');
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large');
    chunks.push(chunk);
  }

  if (length === 0) throw new HttpError(400, 'invalid_request');
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

export function normalizeEmail(input) {
  if (typeof input !== 'string') return null;
  const email = input.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || email.includes('..')) return null;

  const at = email.lastIndexOf('@');
  if (at < 1 || at > 64 || at === email.length - 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const localPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i;
  const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
  return localPattern.test(local) && domainPattern.test(domain) ? email : null;
}

export function createWishlistService({
  dbPath = process.env.WISHLIST_DB_PATH || '/data/wishlist.sqlite',
  allowedOrigin = process.env.WISHLIST_ALLOWED_ORIGIN || DEFAULT_ORIGIN,
  now = () => new Date().toISOString(),
} = {}) {
  const dataDirectory = dirname(dbPath);
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  chmodSync(dataDirectory, 0o700);

  const db = new DatabaseSync(dbPath, { timeout: 5000, defensive: true });
  const journal = db.prepare('PRAGMA journal_mode = DELETE').get();
  if (journal.journal_mode !== 'delete') throw new Error('SQLite rollback journal unavailable');
  db.exec(`
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS wishlist_subscribers (
      email TEXT PRIMARY KEY COLLATE NOCASE,
      created_at TEXT NOT NULL,
      consent_version TEXT NOT NULL,
      CHECK (length(email) BETWEEN 3 AND 254)
    ) STRICT;
  `);
  chmodSync(dbPath, 0o600);

  const insert = db.prepare(`
    INSERT INTO wishlist_subscribers (email, created_at, consent_version)
    VALUES (?, ?, ?)
    ON CONFLICT(email) DO NOTHING
  `);
  let closed = false;

  async function handle(req, res) {
    try {
      const pathname = new URL(req.url || '/', 'http://wishlist.internal').pathname;
      if (pathname === '/health') {
        if (req.method !== 'GET') return json(res, 405, { ok: false }, { Allow: 'GET' });
        return json(res, 200, { ok: true });
      }

      if (pathname !== '/api/wishlist') return json(res, 404, { ok: false });
      if (req.method !== 'POST') return json(res, 405, { ok: false }, { Allow: 'POST' });

      const origin = req.headers.origin;
      if (origin && origin !== allowedOrigin) return json(res, 403, { ok: false });

      const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'application/json') return json(res, 415, { ok: false });

      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_request');
      if (Object.keys(body).some((key) => key !== 'email')) {
        throw new HttpError(400, 'invalid_request');
      }

      const email = normalizeEmail(body.email);
      if (!email) throw new HttpError(400, 'invalid_email');
      insert.run(email, now(), CONSENT_VERSION);
      return json(res, 202, { ok: true });
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 413) req.resume();
        return json(res, error.status, { ok: false, error: error.code });
      }
      console.error('wishlist_request_failed', error instanceof Error ? error.name : 'unknown');
      return json(res, 500, { ok: false, error: 'server_error' });
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    db.close();
  }

  return { close, handle };
}

export async function startWishlistServer(options = {}) {
  const service = createWishlistService(options);
  const server = createServer((req, res) => {
    service.handle(req, res).catch((error) => {
      console.error('wishlist_handler_failed', error instanceof Error ? error.name : 'unknown');
      if (!res.headersSent) json(res, 500, { ok: false, error: 'server_error' });
      else res.destroy();
    });
  });

  server.headersTimeout = 6000;
  server.requestTimeout = 6000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 64;

  const host = options.host || process.env.HOST || '0.0.0.0';
  const port = Number(options.port ?? process.env.PORT ?? 3000);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  return { server, service };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const running = await startWishlistServer();
  const shutdown = () => {
    running.server.close(() => {
      running.service.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
