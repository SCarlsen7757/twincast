import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const revision = 'a'.repeat(64);
const changedRevision = 'b'.repeat(64);
const script = readFileSync(new URL('../../public/board.js', import.meta.url), 'utf8');
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function board(count = 2, lastSuccess: number | null = 1800000000) {
  let now = 1800000000000;
  let reloads = 0;
  let requests = 0;
  let signal: AbortSignal | undefined;
  let response: () => Promise<unknown> = () =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ contentRevision: revision, lastSuccess, stale: false }),
    });
  const intervals = new Map<number, () => void>();
  const timeouts = new Map<number, () => void>();
  let nextTimer = 0;
  function element(active = false) {
    const attributes: Record<string, string> = {};
    const classes = new Set(active ? ['is-active'] : []);
    const handlers = new Map<string, () => void>();
    return {
      attributes,
      classes,
      handlers,
      textContent: '',
      style: {} as Record<string, string>,
      offsetWidth: 100,
      complete: true,
      naturalWidth: 0,
      getAttribute: (key: string) => attributes[key] ?? null,
      setAttribute: (key: string, value: string) => {
        attributes[key] = value;
      },
      addEventListener: (event: string, handler: () => void) => handlers.set(event, handler),
      classList: {
        add: (value: string) => classes.add(value),
        remove: (value: string) => classes.delete(value),
      },
    };
  }
  const body = element();
  Object.assign(body.attributes, {
    'data-rotate': '25',
    'data-content-revision': revision,
    'data-last-success': lastSuccess === null ? '' : String(lastSuccess),
    'data-stale-after': '120',
  });
  const heroes = Array.from({ length: count }, (_, i) => element(i === 0));
  const rows = Array.from({ length: count }, (_, i) => element(i === 0));
  const updated = element();
  const status = element();
  const progress = element();
  const logo = element();
  class Clock extends Date {
    constructor(value?: number) {
      super(value ?? now);
    }
    static override now(): number {
      return now;
    }
  }
  runInNewContext(script, {
    window: {},
    Date: Clock,
    AbortController,
    document: {
      body,
      getElementById: (id: string) =>
        id === 'updated'
          ? updated
          : id === 'feed-status'
            ? status
            : id === 'progress'
              ? progress
              : null,
      querySelectorAll: (selector: string) =>
        selector === '.hero' ? heroes : selector === '.rail__row' ? rows : [],
      querySelector: (selector: string) => (selector === '.brand__logo' ? logo : null),
    },
    setInterval: (fn: () => void, ms: number) => intervals.set(ms, fn),
    setTimeout: (fn: () => void) => {
      timeouts.set(++nextTimer, fn);
      return nextTimer;
    },
    clearTimeout: (id: number) => timeouts.delete(id),
    fetch: (_url: string, options: { signal: AbortSignal }) => {
      requests++;
      signal = options.signal;
      return response();
    },
    location: { reload: () => reloads++ },
  });
  return {
    body,
    heroes,
    rows,
    updated,
    status,
    progress,
    logo,
    get reloads() {
      return reloads;
    },
    get requests() {
      return requests;
    },
    get signal() {
      return signal;
    },
    tick: (ms: number) => {
      const callback = intervals.get(ms);
      assert.ok(callback);
      callback();
    },
    elapse: (ms: number) => {
      now += ms;
    },
    timeout: () => {
      for (const callback of timeouts.values()) callback();
    },
    respond: (data: unknown, ok = true) => {
      response = () => Promise.resolve({ ok, json: () => Promise.resolve(data) });
    },
    fail: () => {
      response = () => Promise.reject(new Error('offline'));
    },
    malformed: () => {
      response = () =>
        Promise.resolve({ ok: true, json: () => Promise.reject(new Error('invalid JSON')) });
    },
    hang: () => {
      response = () => new Promise(() => {});
    },
  };
}

test('rotation synchronizes hero and rail; changes reload only at the wrap', async () => {
  const b = board();
  b.respond({ contentRevision: changedRevision, lastSuccess: 1800000000, stale: false });
  b.tick(120000);
  await settle();
  assert.equal(b.reloads, 0);
  b.tick(25000);
  assert.equal(b.heroes[1]?.classes.has('is-active'), true);
  assert.equal(b.rows[1]?.classes.has('is-active'), true);
  assert.equal(b.heroes[0]?.classes.has('is-active'), false);
  assert.equal(b.reloads, 0);
  b.tick(25000);
  assert.equal(b.reloads, 1);
});

test('identical revisions do not reload for polling timestamp changes', async () => {
  const b = board();
  b.respond({ contentRevision: revision, lastSuccess: 1800000010, stale: false });
  b.tick(120000);
  await settle();
  b.tick(25000);
  b.tick(25000);
  assert.equal(b.reloads, 0);
});

for (const count of [0, 1]) {
  test(`changed revision refreshes ${count}-item board on the next rotation tick`, async () => {
    const b = board(count);
    b.respond({ contentRevision: changedRevision, lastSuccess: 1800000000, stale: false });
    b.tick(120000);
    await settle();
    b.tick(25000);
    assert.equal(b.reloads, 1);
  });
}

test('freshness ages locally and connectivity recovers without losing cached content', async () => {
  const b = board();
  b.fail();
  b.tick(120000);
  await settle();
  assert.equal(b.status.textContent, 'Connection unavailable');
  b.elapse(180000);
  b.tick(60000);
  assert.equal(b.updated.textContent, 'updated 3 minutes ago');
  assert.equal(b.body.attributes['data-stale'], '1');
  assert.equal(b.heroes[0]?.classes.has('is-active'), true);
  b.respond({ contentRevision: revision, lastSuccess: 1800000000, stale: true });
  b.tick(120000);
  await settle();
  assert.equal(b.status.textContent, 'Feed stale');
  b.respond({ contentRevision: revision, lastSuccess: 1800000180, stale: false });
  b.tick(120000);
  await settle();
  assert.equal(b.status.textContent, 'Feed current');
  assert.equal(b.body.attributes['data-offline'], '0');
  assert.equal(b.body.attributes['data-stale'], '0');
  assert.equal(b.reloads, 0);
});

test('HTTP errors, malformed JSON and invalid response shapes are connection failures', async () => {
  for (const kind of ['http', 'json', 'shape']) {
    const b = board();
    if (kind === 'http') b.respond({}, false);
    else if (kind === 'json') b.malformed();
    else b.respond({ contentRevision: changedRevision, lastSuccess: 'yesterday', stale: false });
    b.tick(120000);
    await settle();
    assert.equal(b.status.textContent, 'Connection unavailable', kind);
    b.tick(25000);
    b.tick(25000);
    assert.equal(b.reloads, 0);
  }
});

test('hung requests cannot overlap and timeout aborts and permits retry', async () => {
  const b = board();
  b.hang();
  b.tick(120000);
  b.tick(120000);
  assert.equal(b.requests, 1);
  b.timeout();
  assert.equal(b.signal?.aborted, true);
  assert.equal(b.status.textContent, 'Connection unavailable');
  b.respond({ contentRevision: revision, lastSuccess: 1800000000, stale: false });
  b.tick(120000);
  await settle();
  assert.equal(b.requests, 2);
  assert.equal(b.status.textContent, 'Feed current');
});

test('never-polled board is stale, failed logo is hidden without an inline handler', () => {
  const b = board(1, null);
  assert.equal(b.status.textContent, 'Feed stale');
  assert.equal(b.updated.textContent, 'never updated');
  assert.equal(b.logo.style.display, 'none');
  assert.ok(b.logo.handlers.has('error'));
});

test('24-hour recycle still waits for cycle boundary', () => {
  const b = board();
  b.elapse(86400001);
  b.tick(25000);
  assert.equal(b.reloads, 0);
  b.tick(25000);
  assert.equal(b.reloads, 1);
});
