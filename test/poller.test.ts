import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { openDb, closeDb, upsertItems, setMeta, getMeta } from '../src/db.js';
import {
  refreshSnapshot,
  getSnapshot,
  pollOnce,
  startPolling,
  stopPolling,
} from '../src/poller.js';
import { config, dataDir, loadConfig } from '../src/config.js';
import { errMessage } from '../src/errors.js';
import type { ParsedItem } from '../src/types.js';

const nowSec = (): number => Math.floor(Date.now() / 1000);

const item = (over: Partial<ParsedItem> = {}): ParsedItem => ({
  guid: 'g1',
  title: 'New version of TF3600 Analytics',
  name: 'Analytics',
  codes: 'TF3600',
  family: 'TF',
  version: '3.4.10',
  channel: 'stable',
  link: 'https://example.invalid/1',
  description: 'A release.',
  pub_date: nowSec(),
  ...over,
});

beforeEach(() => {
  closeDb();
  openDb(':memory:');
});

after(() => {
  closeDb();
  stopPolling();
});

describe('refreshSnapshot', () => {
  test('reports an empty board on a fresh database', () => {
    const snap = refreshSnapshot();
    assert.deepEqual(snap.items, []);
    assert.deepEqual(snap.meta, {});
    assert.equal(snap.itemCount, 0);
    assert.equal(snap.lastSuccess, null);
    assert.equal(snap.lastChecked, null);
    assert.equal(snap.lastError, null);
  });

  test('counts stored rows and attaches a QR to each item', () => {
    upsertItems([item({ guid: 'a' }), item({ guid: 'b' })]);
    const snap = refreshSnapshot();
    assert.equal(snap.itemCount, 2);
    assert.equal(snap.items.length, 2);
    for (const i of snap.items) {
      assert.match(i.qr, /^<svg /, 'every item needs its QR inlined before rendering');
    }
  });

  test('reads the poll bookkeeping back as numbers, not strings', () => {
    const t = nowSec();
    setMeta({ last_success: t, last_checked: t + 1, last_error: 'boom' });
    const snap = refreshSnapshot();
    assert.equal(snap.lastSuccess, t);
    assert.equal(snap.lastChecked, t + 1);
    assert.equal(typeof snap.lastSuccess, 'number');
    assert.equal(snap.lastError, 'boom');
  });

  test('treats a cleared error as no error', () => {
    setMeta({ last_error: '' });
    assert.equal(refreshSnapshot().lastError, null);
  });

  test('does not return more items than the board can show', () => {
    const many = Array.from({ length: 50 }, (_, n) => item({ guid: 'g' + String(n) }));
    upsertItems(many);
    const snap = refreshSnapshot();
    assert.equal(snap.itemCount, 50);
    assert.equal(snap.items.length, config.heroCount + config.railCount);
  });
});

/**
 * `stale` is what drives the amber status dot: it is computed per request rather
 * than stored, because it depends on elapsed time and not on the last poll's
 * outcome. Driven here by writing `last_success` directly, so no clock mocking is
 * needed, and read off `config` rather than hardcoding 120 minutes.
 */
describe('getSnapshot staleness', () => {
  const window = config.staleAfterMin * 60;

  test('is stale when there has never been a successful poll', () => {
    refreshSnapshot();
    const snap = getSnapshot();
    assert.equal(snap.ageSec, null);
    assert.equal(snap.stale, true);
  });

  test('is fresh immediately after a success', () => {
    setMeta({ last_success: nowSec() });
    refreshSnapshot();
    const snap = getSnapshot();
    assert.equal(snap.stale, false);
    assert.ok(snap.ageSec !== null && snap.ageSec >= 0 && snap.ageSec < 5);
  });

  test('is still fresh just inside the window', () => {
    setMeta({ last_success: nowSec() - (window - 60) });
    refreshSnapshot();
    assert.equal(getSnapshot().stale, false);
  });

  test('is stale just outside the window', () => {
    setMeta({ last_success: nowSec() - (window + 60) });
    refreshSnapshot();
    assert.equal(getSnapshot().stale, true);
  });

  test('carries the stored snapshot through unchanged', () => {
    upsertItems([item({ guid: 'a' })]);
    setMeta({ last_success: nowSec() });
    const stored = refreshSnapshot();
    const view = getSnapshot();
    assert.equal(view.itemCount, stored.itemCount);
    assert.deepEqual(view.items, stored.items);
    assert.equal(view.lastSuccess, stored.lastSuccess);
  });
});

/**
 * pollOnce is documented "Never throws" -- a failed poll must not take the board
 * down, because the screen keeps serving whatever SQLite already holds. Pointed at
 * a closed port on loopback so this stays offline and fast.
 */
describe('pollOnce never throws', () => {
  test('returns an error result and records it, rather than rejecting', async () => {
    const realUrl = config.feedUrl;
    config.feedUrl = 'http://127.0.0.1:1/not-a-feed';
    try {
      upsertItems([item({ guid: 'kept' })]);

      const r = await pollOnce();

      assert.equal(r.status, 'error');
      assert.ok(r.status === 'error' && r.error.length > 0, 'the reason must be reported');

      const meta = getMeta();
      assert.ok(meta.last_error, 'last_error must be persisted for the empty state to show');
      assert.ok(meta.last_checked, 'a failed attempt still counts as a check');
      assert.equal(meta.last_success, undefined, 'a failure must not claim success');

      assert.equal(getSnapshot().itemCount, 1, 'stored releases must survive a failed poll');
    } finally {
      config.feedUrl = realUrl;
    }
  });
});

describe('startPolling and stopPolling', () => {
  test('start without an immediate poll primes the snapshot and returns a timer', async () => {
    upsertItems([item({ guid: 'a' })]);
    const timer = await startPolling({ immediate: false });
    try {
      assert.ok(timer, 'a handle is returned so the caller can stop it');
      assert.equal(getSnapshot().itemCount, 1);
    } finally {
      stopPolling();
    }
  });

  test('stop is safe to call twice and when never started', () => {
    stopPolling();
    stopPolling();
  });
});

describe('errMessage', () => {
  test('prefers an Error message', () => {
    assert.equal(errMessage(new Error('feed responded HTTP 503')), 'feed responded HTTP 503');
  });

  test('stringifies whatever else was thrown', () => {
    assert.equal(errMessage('plain string'), 'plain string');
    assert.equal(errMessage(undefined), 'undefined');
    assert.equal(errMessage(null), 'null');
    assert.equal(errMessage(42), '42');
  });
});

describe('dataDir', () => {
  test('is the directory holding the database', () => {
    assert.equal(dataDir(), dirname(config.dbPath));
  });

  test('follows DB_PATH', () => {
    assert.equal(loadConfig({ DB_PATH: '/data/board.db' }).dbPath, '/data/board.db');
  });
});
