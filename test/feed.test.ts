import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { cacheLogo, fetchFeed, logoContentType, logoDigest, readLogo } from '../src/feed.js';
import { safeLink } from '../src/urls.js';

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const original = { dbPath: config.dbPath, feedUrl: config.feedUrl };
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'twincast-feed-'));
  config.dbPath = join(directory, 'board.db');
  config.feedUrl = 'https://feed.example/rss';
});
afterEach(() => {
  Object.assign(config, original);
  rmSync(directory, { recursive: true, force: true });
});

describe('feed transport limits', () => {
  test('keeps conditional requests and 304 responses', async (t) => {
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      assert.equal((init.headers as Record<string, string>)['If-None-Match'], 'version');
      return new Response(null, { status: 304 });
    });
    assert.deepEqual(await fetchFeed({ etag: 'version' }), { status: 304 });
  });

  test('reads a valid feed and response validators', async (t) => {
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Response('<rss/>', { headers: { etag: 'v1' } }),
    );
    const result = await fetchFeed();
    assert.equal(result.status, 200);
    if (result.status === 200) {
      assert.equal(result.xml, '<rss/>');
      assert.equal(result.etag, 'v1');
    }
  });

  test('rejects advertised oversized responses', async (t) => {
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Response('small', { headers: { 'content-length': String(6 * 1024 * 1024) } }),
    );
    await assert.rejects(fetchFeed(), /exceeds/);
  });

  test('cancels chunked oversized responses without a content length', async (t) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    t.mock.method(globalThis, 'fetch', async () => new Response(body));
    await assert.rejects(fetchFeed(), /exceeds/);
    assert.equal(cancelled, true);
  });
});

describe('logo trust boundary', () => {
  test('rejects unsafe origins, schemes, credentials and redirect targets before fetching', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(png));
    for (const url of [
      'http://feed.example/logo',
      'https://other.example/logo',
      'http://127.0.0.1/private',
      'file:///secret',
      'https://user:pass@feed.example/logo',
    ]) {
      assert.equal(await cacheLogo(url), null);
    }
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  test('disables redirects and uses byte signature rather than declared content type', async (t) => {
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      assert.equal(init.redirect, 'error');
      return new Response(png, { headers: { 'content-type': 'text/html' } });
    });
    assert.equal(await cacheLogo('https://feed.example/logo'), 'image/png');
    assert.deepEqual(readLogo(), Buffer.from(png));
    assert.match(logoDigest(), /^[a-f0-9]{64}$/);
  });

  test('rejects HTML, SVG, empty and oversized content', async (t) => {
    for (const body of [
      '',
      '<html><script>alert(1)</script></html>',
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      'x'.repeat(1024 * 1024 + 1),
    ]) {
      const fetchMock = t.mock.method(
        globalThis,
        'fetch',
        async () => new Response(body, { headers: { 'content-type': 'image/png' } }),
      );
      assert.equal(await cacheLogo('https://feed.example/logo'), null);
      fetchMock.mock.restore();
    }
    assert.equal(readLogo(), null);
  });

  test('rejects a redirect response without caching it', async (t) => {
    t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
    );
    assert.equal(await cacheLogo('https://feed.example/logo'), null);
    assert.equal(readLogo(), null);
  });

  test('identifies JPEG and rejects invalid cached bytes', () => {
    assert.equal(logoContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    writeFileSync(join(directory, 'logo.bin'), '<html>bad cache</html>');
    assert.equal(readLogo(), null);
    assert.equal(logoDigest(), '');
  });
});

test('safe links reject executable and malformed URLs', () => {
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,hi',
    'java\nscript:alert(1)',
    'https://user:pass@example.com',
    '/relative',
    'https://example.com/' + 'a'.repeat(2048),
  ]) {
    assert.equal(safeLink(value), '');
  }
  assert.equal(safeLink('HTTPS://Example.COM/path'), 'https://example.com/path');
  assert.equal(safeLink('http://example.com/'), 'http://example.com/');
});
