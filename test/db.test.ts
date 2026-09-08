import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb,
  closeDb,
  upsertItems,
  countItems,
  getLatest,
  setMeta,
  getMeta,
} from '../src/db.js';
import type { ParsedItem } from '../src/types.js';

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
  pub_date: 1_800_000_000,
  ...over,
});

// openDb memoises into a module-level handle, and upsertItems calls it with no
// argument -- so the memo has to be primed with the in-memory database.
beforeEach(() => {
  closeDb();
  openDb(':memory:');
});

after(() => {
  closeDb();
});

describe('upsertItems', () => {
  test('inserts and reports how many rows were new', () => {
    const n = upsertItems([item({ guid: 'a' }), item({ guid: 'b' }), item({ guid: 'c' })]);
    assert.equal(n, 3);
    assert.equal(countItems(), 3);
  });

  test('is idempotent: re-upserting the same guids adds nothing', () => {
    const items = [item({ guid: 'a' }), item({ guid: 'b' })];
    assert.equal(upsertItems(items), 2);
    assert.equal(upsertItems(items), 0);
    assert.equal(countItems(), 2);
  });

  test('counts only the genuinely new rows in a mixed batch', () => {
    upsertItems([item({ guid: 'a' })]);
    assert.equal(upsertItems([item({ guid: 'a' }), item({ guid: 'b' })]), 1);
  });

  test('updates the mutable columns of an existing row', () => {
    upsertItems([item({ guid: 'a', version: '1.0.0' })]);
    upsertItems([item({ guid: 'a', version: '2.0.0', name: 'Renamed' })]);
    const [row] = getLatest(1);
    assert.equal(row?.version, '2.0.0');
    assert.equal(row?.name, 'Renamed');
  });

  /**
   * The invariant the UPSERT comment documents in prose: `first_seen` is absent
   * from the DO UPDATE clause, so re-polling must never move it. Written against
   * a pinned past value rather than wall-clock time, so it fails loudly if anyone
   * adds `first_seen=excluded.first_seen`.
   */
  test('never moves first_seen on re-upsert', () => {
    upsertItems([item({ guid: 'a', title: 'original' })]);
    const db = openDb();
    db.exec("UPDATE items SET first_seen = 1000 WHERE guid = 'a'");

    upsertItems([item({ guid: 'a', title: 'changed' })]);

    const [row] = getLatest(1);
    assert.equal(row?.first_seen, 1000, 'first_seen must survive a re-upsert');
    assert.equal(row?.title, 'changed', 'but the mutable columns must still update');
  });

  test('rolls the whole batch back when one row violates the schema', () => {
    upsertItems([item({ guid: 'a' })]);
    const bad = item({ guid: 'b', title: null as unknown as string });
    assert.throws(() => upsertItems([item({ guid: 'c' }), bad]));
    assert.equal(countItems(), 1, 'the valid row in the failed batch must not persist');
  });

  test('accepts an empty batch', () => {
    assert.equal(upsertItems([]), 0);
  });
});

describe('getLatest', () => {
  test('orders by pub_date descending, breaking ties on insertion order', () => {
    upsertItems([
      item({ guid: 'old', pub_date: 100 }),
      item({ guid: 'tie-a', pub_date: 300 }),
      item({ guid: 'tie-b', pub_date: 300 }),
      item({ guid: 'mid', pub_date: 200 }),
    ]);
    assert.deepEqual(
      getLatest(10).map((r) => r.guid),
      ['tie-a', 'tie-b', 'mid', 'old'],
    );
  });

  test('respects the limit', () => {
    upsertItems([item({ guid: 'a' }), item({ guid: 'b' }), item({ guid: 'c' })]);
    assert.equal(getLatest(2).length, 2);
  });

  test('returns an empty array on an empty database', () => {
    assert.deepEqual(getLatest(10), []);
  });

  test('round-trips every column, including the nullable ones', () => {
    upsertItems([item({ guid: 'a', family: null, version: null, channel: null })]);
    const [row] = getLatest(1);
    assert.equal(row?.family, null);
    assert.equal(row?.version, null);
    assert.equal(row?.channel, null);
    assert.equal(row?.codes, 'TF3600');
  });
});

describe('meta', () => {
  test('round-trips values and overwrites on conflict', () => {
    setMeta({ etag: 'abc', last_success: 1234 });
    assert.deepEqual(getMeta(), { etag: 'abc', last_success: '1234' });
    setMeta({ etag: 'def' });
    assert.equal(getMeta().etag, 'def');
  });

  test('skips null and undefined but stores zero and empty string', () => {
    setMeta({ a: null, b: undefined, c: 0, d: '' });
    const m = getMeta();
    assert.ok(!('a' in m));
    assert.ok(!('b' in m));
    assert.equal(m.c, '0');
    assert.equal(m.d, '');
  });

  test('returns an empty object when nothing is stored', () => {
    assert.deepEqual(getMeta(), {});
  });
});
