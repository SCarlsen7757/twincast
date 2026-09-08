import { createServer } from 'node:http';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, sep } from 'node:path';

import { config } from './config.js';
import { openDb, closeDb, countItems, getMeta } from './db.js';
import { startPolling, stopPolling, getSnapshot, pollOnce, refreshSnapshot } from './poller.js';
import { readLogo } from './feed.js';
import { renderBoard } from './render.js';
import type { ItemWithQr, Item } from './types.js';

// Two levels up, not one: this module ships as dist/src/server.js, so '..' is
// dist/ and '../..' is the package root -- where public/ sits both locally and
// at /app in the image.
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const COMPRESSIBLE = /^(text\/|application\/(json|javascript)|image\/svg)/;

/** The QR SVG is a rendering detail; the JSON contract does not carry it. */
const stripQr = ({ qr: _qr, ...rest }: ItemWithQr): Item => rest;

function send(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  cacheControl?: string,
): void {
  let payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headers: OutgoingHttpHeaders = {
    'Content-Type': type,
    'Cache-Control': cacheControl || 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };

  if (
    COMPRESSIBLE.test(type) &&
    payload.length > 1024 &&
    /\bgzip\b/.test(req.headers['accept-encoding'] || '')
  ) {
    payload = gzipSync(payload);
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }

  headers['Content-Length'] = payload.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : payload);
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  // Resolve inside PUBLIC_DIR only; reject anything that escapes it.
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  const full = join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR + sep)) {
    send(req, res, 403, 'text/plain; charset=utf-8', 'forbidden');
    return;
  }

  const ext = full.slice(full.lastIndexOf('.'));
  const type = TYPES[ext];
  if (!type) {
    send(req, res, 404, 'text/plain; charset=utf-8', 'not found');
    return;
  }

  try {
    const buf = await readFile(full);
    send(req, res, 200, type, buf, 'public, max-age=300');
  } catch {
    send(req, res, 404, 'text/plain; charset=utf-8', 'not found');
  }
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(req, res, 405, 'text/plain; charset=utf-8', 'method not allowed');
    return;
  }

  // `/tv` is the canonical info-screen URL -- point Anthias at that one. `/` serves
  // the same board today but is reserved for the interactive view, at which point
  // only `/` changes and every screen already on /tv keeps working.
  if (p === '/tv' || p === '/tv/' || p === '/' || p === '/index.html') {
    send(req, res, 200, 'text/html; charset=utf-8', renderBoard(getSnapshot()));
    return;
  }

  if (p === '/healthz') {
    const snap = getSnapshot();
    const ok = snap.items.length > 0;
    send(
      req,
      res,
      ok ? 200 : 503,
      'application/json; charset=utf-8',
      JSON.stringify({
        ok,
        items: snap.itemCount,
        stale: snap.stale,
        ageSec: snap.ageSec,
        lastError: snap.lastError || null,
      }),
    );
    return;
  }

  if (p === '/api/news') {
    const snap = getSnapshot();
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 25, 1), 100);
    // The data contract the interactive mode will reuse. Never fails: it serves
    // whatever SQLite holds, flagged stale if the feed has not been reachable.
    send(
      req,
      res,
      200,
      'application/json; charset=utf-8',
      JSON.stringify({
        source: {
          title: snap.meta.channel_title || null,
          link: snap.meta.channel_link || null,
          copyright: snap.meta.channel_copyright || null,
        },
        stale: snap.stale,
        ageSec: snap.ageSec,
        lastSuccess: snap.lastSuccess,
        lastChecked: snap.lastChecked,
        lastError: snap.lastError || null,
        itemCount: snap.itemCount,
        items: snap.items.slice(0, limit).map(stripQr),
      }),
    );
    return;
  }

  if (p === '/logo') {
    const buf = readLogo();
    if (!buf) {
      send(req, res, 404, 'text/plain; charset=utf-8', 'no logo cached');
      return;
    }
    const type = getMeta().logo_content_type || 'image/jpeg';
    send(req, res, 200, type, buf, 'public, max-age=86400');
    return;
  }

  void serveStatic(req, res, p);
}

const server = createServer((req, res) => {
  try {
    handle(req, res);
  } catch (err) {
    console.error('[http] handler failed:', err);
    if (!res.headersSent) send(req, res, 500, 'text/plain; charset=utf-8', 'internal error');
  }
});

async function main(): Promise<void> {
  openDb();
  refreshSnapshot();

  // On a fresh install there is nothing to show, so wait for the first poll
  // rather than flashing an empty board. On restarts SQLite already has data,
  // so serve immediately and poll in the background.
  let didBootPoll = false;
  if (countItems() === 0 && config.pollOnStart) {
    console.log('[boot] empty database, running first poll before serving');
    const r = await pollOnce();
    console.log(`[boot] first poll: ${r.status}${r.status === 'error' ? ' - ' + r.error : ''}`);
    didBootPoll = true;
  }

  server.listen(config.port, () => {
    console.log(`[boot] board on http://0.0.0.0:${config.port}`);
    console.log(
      `[boot] feed=${config.feedUrl} every ${config.pollIntervalMin}min, ` +
        `hero=${config.heroCount} rail=${config.railCount} rotate=${config.rotateSeconds}s`,
    );
  });

  // Don't repeat the poll we already ran above.
  await startPolling({ immediate: config.pollOnStart && !didBootPoll });
}

function shutdown(signal: string): void {
  console.log(`[exit] ${signal}, shutting down`);
  stopPolling();
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  // Don't hang forever on a stuck connection.
  setTimeout(() => {
    closeDb();
    process.exit(0);
  }, 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  console.error('[boot] failed:', err);
  process.exit(1);
});
