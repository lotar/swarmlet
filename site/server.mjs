// Minimal dependency-free static server for the Swarmlet teaser.
// Precompresses in memory (brotli + gzip), sets immutable cache headers, and
// serves the same content-encoding negotiation a CDN would use in production.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { brotliCompressSync, gzipSync, constants as z } from 'node:zlib';

const ROOT = new URL('.', import.meta.url).pathname;
const PORT = Number(process.env.PORT || 8123);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const cache = new Map(); // path -> { buf, ext, mtime, br, gz }

async function load(pathname) {
  let p = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  if (p === '/' || p === '/index.html') p = '/index.html';
  let file = join(ROOT, p);
  let st = await stat(file).catch(() => null);
  if (st && st.isDirectory()) { file = join(file, 'index.html'); st = await stat(file).catch(() => null); }
  if (!st) return null;
  const key = p;
  const hit = cache.get(key);
  if (hit && hit.mtime === st.mtimeMs) return hit;
  const buf = await readFile(file);
  const entry = {
    buf, mtime: st.mtimeMs, ext: extname(file),
    br: brotliCompressSync(buf, { params: { [z.BROTLI_PARAM_QUALITY]: 11 } }),
    gz: gzipSync(buf, { level: 9 }),
  };
  cache.set(key, entry);
  return entry;
}

function negotiate(req, entry) {
  const ae = req.headers['accept-encoding'] || '';
  const compressible = /\.(html|js|css|svg|xml|txt|webmanifest|json)$/.test(entry.ext);
  if (!compressible) return { body: entry.buf, enc: null };
  if (ae.includes('br')) return { body: entry.br, enc: 'br' };
  if (ae.includes('gzip')) return { body: entry.gz, enc: 'gzip' };
  return { body: entry.buf, enc: null };
}

createServer(async (req, res) => {
  const entry = await load(new URL(req.url, 'http://x').pathname);
  if (!entry) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
    return;
  }
  const { body, enc } = negotiate(req, entry);
  const etag = 'W/"' + entry.mtime.toString(36) + '-' + body.length.toString(36) + '"';
  if (req.headers['if-none-match'] === etag) { res.writeHead(304).end(); return; }
  res.writeHead(200, {
    'content-type': TYPES[entry.ext] || 'application/octet-stream',
    'content-length': body.length,
    'content-encoding': enc || 'identity',
    etag,
    // dev server: always revalidate (ETag makes it a free 304). Production CDNs get
    // immutable caching via _headers / the deploy notes in README.md.
    'cache-control': process.env.SITE_CACHE || 'no-store',
    'x-content-type-options': 'nosniff',
    vary: 'Accept-Encoding',
  });
  res.end(body);
}).listen(PORT, '127.0.0.1', () => console.log(`swarmlet teaser → http://localhost:${PORT}  (root ${ROOT})`));
