import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { relDay, relTime } from '../src/render.js';

/**
 * `public/board.js` reimplements relTime() and relDay() because it is a plain ES5
 * script served verbatim -- it cannot import from src/, and giving it a build step
 * is exactly the complexity this project avoids. That leaves two copies of the same
 * logic, only one of which the type checker and the rest of the suite can see.
 *
 * This test is what keeps them in step: it runs board.js in a vm and diffs both
 * implementations across every tier boundary. If either side is changed alone, this
 * fails rather than the screen quietly disagreeing with the server.
 */

interface BoardTime {
  relTime: (epochSec: number) => string;
  relDay: (epochSec: number) => string;
}

/** Just enough DOM for the IIFE to reach its end without touching a real browser. */
function loadBoardScript(): BoardTime {
  // Two levels up, not one: this module runs as dist/test/board-parity.test.js,
  // so '../..' is the package root -- the same reasoning as PUBLIC_DIR in
  // src/server.ts. public/ is never compiled, so it is read from source.
  const src = readFileSync(new URL('../../public/board.js', import.meta.url), 'utf8');

  const el = {
    textContent: '',
    className: '',
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    getAttribute: () => null,
    setAttribute() {},
    removeAttribute() {},
    querySelector: () => el,
    querySelectorAll: () => [],
    addEventListener() {},
  };

  const win: Record<string, unknown> = {};
  const sandbox = {
    window: win,
    document: {
      body: el,
      getElementById: () => el,
      querySelector: () => el,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    // The script registers five intervals on startup; swallow them so the vm does
    // not hold timers open for the rest of the run.
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval() {},
    location: { reload() {} },
    fetch: () => Promise.reject(new Error('no network in this test')),
    console,
    Date,
    Math,
    parseInt,
    parseFloat,
    String,
    Number,
    Array,
    Object,
    isNaN,
  };

  runInContext(src, createContext(sandbox));

  const exposed = win.__twincastTime as BoardTime | undefined;
  assert.ok(
    exposed && typeof exposed.relTime === 'function' && typeof exposed.relDay === 'function',
    'public/board.js must expose window.__twincastTime for this test',
  );
  return exposed;
}

// Loaded eagerly rather than in a before() hook: the suites below build their
// case tables at module scope, so the helpers have to exist by then.
const board: BoardTime = loadBoardScript();

/**
 * The client reads the clock itself, so both sides are compared at "now". Ages are
 * given in seconds back from the same instant.
 */
const DAY = 86400;

describe('relTime parity with src/render.ts', () => {
  // Every threshold in the function, plus a step either side of each.
  const ages = [
    0,
    1,
    88,
    89,
    90,
    91,
    120,
    3599,
    3600,
    3601,
    5400,
    7200,
    35 * 3600,
    36 * 3600,
    37 * 3600,
    30 * DAY,
    31 * DAY,
    32 * DAY,
    17 * 30 * DAY,
    18 * 30 * DAY,
    19 * 30 * DAY,
    365 * DAY,
    3 * 365 * DAY,
  ];

  for (const age of ages) {
    test(`agrees at ${age} seconds`, () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const at = nowSec - age;
      assert.equal(board.relTime(at), relTime(at, nowSec));
    });
  }
});

describe('relDay parity with src/render.ts', () => {
  // 532/533 and 547/548 are the months->years boundary, where the years tier used
  // to emit "1 years ago" in both copies.
  const days = [0, 1, 2, 3, 29, 30, 31, 32, 45, 60, 200, 531, 532, 533, 540, 547, 548, 730, 1096];

  for (const d of days) {
    test(`agrees at ${d} days`, () => {
      // Anchor to local noon so neither side straddles midnight mid-test.
      const now = new Date();
      const noon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
      const at = Math.floor(noon.getTime() / 1000) - d * DAY;
      assert.equal(board.relDay(at), relDay(at, noon));
    });
  }
});

describe('the shared years-tier grammar', () => {
  test('says "1 year ago", not "1 years ago", on both sides', () => {
    const now = new Date();
    const noon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
    for (const d of [533, 540, 547]) {
      const at = Math.floor(noon.getTime() / 1000) - d * DAY;
      assert.equal(relDay(at, noon), '1 year ago', `server at ${d} days`);
      assert.equal(board.relDay(at), '1 year ago', `client at ${d} days`);
    }
  });

  test('still pluralises two years and beyond', () => {
    const now = new Date();
    const noon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
    const at = Math.floor(noon.getTime() / 1000) - 548 * DAY;
    assert.equal(relDay(at, noon), '2 years ago');
    assert.equal(board.relDay(at), '2 years ago');
  });
});
