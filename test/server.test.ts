import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { createBoardServer } from '../src/server.js';
import { openDb, closeDb, upsertItems } from '../src/db.js';
import { refreshSnapshot } from '../src/poller.js';
import type { Item } from '../src/types.js';

const server = createBoardServer();
let port: number;
before(async () => {
  openDb(':memory:');
  upsertItems(
    Array.from({ length: 105 }, (_, i) => ({
      guid: String(i),
      title: 'Fixture',
      name: 'Fixture',
      codes: 'TF1000',
      family: 'TF',
      version: '1.0',
      channel: null,
      link: 'https://example.invalid/',
      description: 'test',
      pub_date: 1800000000 - i,
    })),
  );
  refreshSnapshot();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  port = address.port;
});
after(async () => {
  server.close();
  await once(server, 'close');
  closeDb();
});

function get(
  path: string,
  method = 'GET',
): Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('malformed paths cannot terminate the server', async () => {
  for (const path of ['/%', '/%FF', '/%2', '/%00']) {
    assert.equal((await get(path)).status, 400, path);
    assert.equal((await get('/healthz')).status, 200);
  }
});
test('static traversal stays outside public files', async () => {
  for (const path of ['/..%2fsrc/server.js', '/%2e%2e%5csrc%5cserver.js', '/package.json']) {
    assert.ok([403, 404].includes((await get(path)).status), path);
  }
});
test('methods, static files and security headers', async () => {
  assert.equal((await get('/tv', 'POST')).status, 405);
  const head = await get('/tv', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  const board = await get('/tv');
  assert.match(String(board.headers['content-security-policy'] ?? ''), /object-src 'none'/);
  assert.equal(board.headers['x-content-type-options'], 'nosniff');
  assert.doesNotMatch(board.body, /onerror=/);
  assert.equal((await get('/board.js')).status, 200);
  assert.equal((await get('/board.css')).status, 200);
});
test('API limits are independent of display counts and omit QR markup', async () => {
  for (const [query, count] of [
    ['', 25],
    ['?limit=1', 1],
    ['?limit=100', 100],
    ['?limit=101', 100],
    ['?limit=0', 25],
    ['?limit=1.5', 25],
    ['?limit=no', 25],
    ['?limit=-1', 25],
  ] as const) {
    const response = await get('/api/news' + query);
    const data = JSON.parse(response.body) as {
      items: Item[];
      itemCount: number;
      contentRevision: string;
    };
    assert.equal(data.items.length, count, query);
    assert.equal(data.itemCount, 105);
    assert.match(data.contentRevision, /^[a-f0-9]{64}$/);
    assert.equal('qr' in (data.items[0] ?? {}), false);
  }
});
