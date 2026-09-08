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
import { SINGLE_ITEM_XML } from './fixture.js';

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
  stopPolling();
  closeDb();
  openDb(':memory:');
});

test('revision tracks rendered content but excludes polling timestamps', () => {
  upsertItems([item(), item({ guid: 'second', pub_date: nowSec() - 100 })]);
  const first = refreshSnapshot().contentRevision;
  setMeta({ last_checked: nowSec(), last_success: nowSec() });
  assert.equal(refreshSnapshot().contentRevision, first);
  upsertItems([item({ guid: 'second', version: '2.0', pub_date: nowSec() - 100 })]);
  const second = refreshSnapshot().contentRevision;
  assert.notEqual(second, first);
  upsertItems([item({ guid: 'new-release', version: '3.0', pub_date: nowSec() + 100 })]);
  const third = refreshSnapshot().contentRevision;
  assert.notEqual(third, second);
  setMeta({ channel_title: 'Changed source' });
  assert.notEqual(refreshSnapshot().contentRevision, third);
});

test('QR overflow leaves stored text and the rest of the snapshot usable', () => {
  upsertItems([item({ link: 'https://example.invalid/' + 'x'.repeat(5000) })]);
  const snap = refreshSnapshot();
  assert.equal(snap.items[0]?.name, 'Analytics');
  assert.equal(snap.items[0]?.qr, '');
});

test('successful, unchanged and 304 polls recover missing logos', async () => {
  let attempts = 0;
  const fetchFeed = async () => ({
    status: 200 as const,
    xml: SINGLE_ITEM_XML,
    etag: 'v1',
    lastModified: null,
  });
  const cacheLogo = async () => {
    attempts++;
    return null;
  };
  const readLogo = () => null;
  assert.equal((await pollOnce({ fetchFeed, cacheLogo, readLogo })).status, 'updated');
  const revision = getSnapshot().contentRevision;
  assert.equal((await pollOnce({ fetchFeed, cacheLogo, readLogo })).status, 'unchanged');
  assert.equal(
    (await pollOnce({ fetchFeed: async () => ({ status: 304 }), cacheLogo, readLogo })).status,
    'not-modified',
  );
  assert.equal(attempts, 3);
  assert.equal(getSnapshot().contentRevision, revision);
});

test('storage and refresh errors never discard the previous usable snapshot', async () => {
  upsertItems([item()]);
  refreshSnapshot();
  const previous = getSnapshot();
  const fail = () => {
    throw new Error('disk unavailable');
  };
  const result = await pollOnce({ getMeta: fail, setMeta: fail, refreshSnapshot: fail });
  assert.equal(result.status, 'error');
  assert.deepEqual(getSnapshot().items, previous.items);
  assert.equal(getSnapshot().lastError, 'disk unavailable');
});

test('manual callers share a single outstanding request', async () => {
  let resolve!: (value: { status: 304 }) => void;
  let calls = 0;
  const fetchFeed = () => {
    calls++;
    return new Promise<{ status: 304 }>((r) => {
      resolve = r;
    });
  };
  const first = pollOnce({ fetchFeed, readLogo: () => null, cacheLogo: async () => null });
  const second = pollOnce({ fetchFeed });
  assert.equal(first, second);
  assert.equal(calls, 1);
  resolve({ status: 304 });
  await first;
});

test('scheduler is idempotent, waits for completion and stays stopped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let finish!: (value: { status: 'unchanged' }) => void;
  const poll = () => {
    calls++;
    return new Promise<{ status: 'unchanged' }>((resolve) => {
      finish = resolve;
    });
  };
  await startPolling({ immediate: false, poll });
  await startPolling({ immediate: false, poll });
  t.mock.timers.tick(config.pollIntervalMin * 60000);
  assert.equal(calls, 1);
  t.mock.timers.tick(config.pollIntervalMin * 60000 * 3);
  assert.equal(calls, 1);
  stopPolling();
  finish({ status: 'unchanged' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(config.pollIntervalMin * 60000 * 3);
  assert.equal(calls, 1);
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
    assert.equal(snap.items.length, Math.max(config.heroCount, config.railCount));
    assert.equal(snap.apiItems.length, 50);
    assert.equal(snap.items[config.heroCount]?.qr, '');
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
      refreshSnapshot();

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
  test('start without an immediate poll primes the snapshot', async () => {
    upsertItems([item({ guid: 'a' })]);
    await startPolling({ immediate: false });
    try {
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
