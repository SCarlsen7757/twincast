import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { relDay, relTime, shortDate, renderBoard } from '../src/render.js';
import type { ItemWithQr, Snapshot } from '../src/types.js';

/** Epoch seconds for a local wall-clock time, so these tests are timezone-agnostic. */
const at = (y: number, m: number, d: number, h = 12, min = 0): number =>
  Math.floor(new Date(y, m, d, h, min).getTime() / 1000);

describe('relDay', () => {
  const now = new Date(2026, 8, 8, 10, 0); // 8 Sep 2026, 10:00 local

  test('counts whole calendar days, not elapsed hours', () => {
    assert.equal(relDay(at(2026, 8, 8, 1), now), 'Today');
    // The case the implementation exists for: published at 23:00 last night reads
    // as "Yesterday", not "11 hours ago".
    assert.equal(relDay(at(2026, 8, 7, 23), now), 'Yesterday');
    assert.equal(relDay(at(2026, 8, 5, 23), now), '3 days ago');
  });

  test('never reports the future as anything but Today', () => {
    assert.equal(relDay(at(2026, 8, 9, 10), now), 'Today');
  });

  test('switches to months and years at the documented thresholds', () => {
    assert.equal(relDay(at(2026, 7, 9, 12), now), '30 days ago');
    assert.equal(relDay(at(2026, 6, 9, 12), now), '2 months ago');
    assert.equal(relDay(at(2024, 8, 8, 12), now), '2 years ago');
  });

  test('uses the singular for exactly one month', () => {
    assert.equal(relDay(at(2026, 7, 4, 12), now), '1 month ago');
  });

  /**
   * The months tier divides by 30.44 and the years tier by 365.25, which leaves a
   * window at 533-547 days where the years branch yields 1. It used to read
   * "1 years ago" on the screen. These are the four days either side of it.
   */
  test('uses the singular across the months-to-years boundary', () => {
    const day = (n: number): number =>
      Math.floor(new Date(2026, 8, 8, 12, 0).getTime() / 1000) - n * 86400;
    const at12 = new Date(2026, 8, 8, 12, 0);
    assert.equal(relDay(day(532), at12), '17 months ago');
    assert.equal(relDay(day(533), at12), '1 year ago');
    assert.equal(relDay(day(547), at12), '1 year ago');
    assert.equal(relDay(day(548), at12), '2 years ago');
  });
});

describe('relTime', () => {
  const now = 1_800_000_000;

  test('reports anything under 90 seconds as just now', () => {
    assert.equal(relTime(now, now), 'just now');
    assert.equal(relTime(now - 89, now), 'just now');
  });

  test('pluralises each tier correctly', () => {
    assert.equal(relTime(now - 90, now), '2 minutes ago');
    assert.equal(relTime(now - 60 * 60, now), '1 hour ago');
    assert.equal(relTime(now - 2 * 60 * 60, now), '2 hours ago');
    // Deliberately stays in hours until 36, so 24h is still hours.
    assert.equal(relTime(now - 24 * 60 * 60, now), '24 hours ago');
    assert.equal(relTime(now - 48 * 60 * 60, now), '2 days ago');
    assert.equal(relTime(now - 60 * 24 * 60 * 60, now), '2 months ago');
  });

  test('clamps a future timestamp rather than going negative', () => {
    assert.equal(relTime(now + 5000, now), 'just now');
  });
});

describe('shortDate', () => {
  test('formats as day, short month, year', () => {
    assert.equal(shortDate(at(2026, 8, 8)), '8 Sep 2026');
    assert.equal(shortDate(at(2026, 0, 1)), '1 Jan 2026');
    assert.equal(shortDate(at(2026, 11, 31)), '31 Dec 2026');
  });
});

const item = (over: Partial<ItemWithQr> = {}): ItemWithQr => ({
  guid: 'g1',
  title: 'New version of TF3600 Analytics',
  name: 'Analytics',
  codes: 'TF3600',
  family: 'TF',
  version: '3.4.10',
  channel: 'stable',
  link: 'https://example.invalid/1',
  description: 'A release.',
  pub_date: at(2026, 8, 8),
  first_seen: at(2026, 8, 8),
  qr: '<svg id="qr"></svg>',
  ...over,
});

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  items: [item()],
  meta: {},
  itemCount: 1,
  lastSuccess: at(2026, 8, 8),
  lastChecked: at(2026, 8, 8),
  lastError: null,
  ageSec: 10,
  stale: false,
  ...over,
});

describe('renderBoard', () => {
  test('escapes interpolated content rather than emitting raw markup', () => {
    const html = renderBoard(snapshot({ items: [item({ name: '<script>alert(1)</script>' })] }));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(!html.includes('<script>alert(1)</script>'));
  });

  test('escapes all five characters, including inside attributes', () => {
    const html = renderBoard(snapshot({ items: [item({ family: '"><x' })] }));
    assert.ok(html.includes('&quot;&gt;&lt;x'));
  });

  test('inlines the QR markup unescaped, because it is our own SVG', () => {
    assert.ok(renderBoard(snapshot()).includes('<svg id="qr"></svg>'));
  });

  test('renders the release content', () => {
    const html = renderBoard(snapshot());
    assert.ok(html.includes('Analytics'));
    assert.ok(html.includes('3.4.10'));
    assert.ok(html.includes('Stable feed'));
    assert.ok(html.includes('Function'));
  });

  // Mirrors the CI smoke assertion at unit speed: attribution must survive every
  // render, including the empty state.
  test('always carries the Beckhoff attribution', () => {
    assert.ok(renderBoard(snapshot()).includes('Beckhoff Automation'));
    assert.ok(renderBoard(snapshot({ items: [], itemCount: 0 })).includes('Beckhoff Automation'));
  });

  test('renders the empty state and surfaces the last error', () => {
    const html = renderBoard(
      snapshot({ items: [], itemCount: 0, lastError: 'feed responded HTTP 503' }),
    );
    assert.ok(html.includes('No releases stored yet'));
    assert.ok(html.includes('feed responded HTTP 503'));
  });

  test('explains itself when there has been no successful poll at all', () => {
    const html = renderBoard(snapshot({ items: [], itemCount: 0, lastSuccess: null }));
    assert.ok(html.includes('Waiting for the first successful poll.'));
    assert.ok(html.includes('never updated'));
  });

  test('flags staleness on the body element for the client script', () => {
    assert.ok(renderBoard(snapshot({ stale: true })).includes('data-stale="1"'));
    assert.ok(renderBoard(snapshot({ stale: false })).includes('data-stale="0"'));
  });

  test('prefers the channel metadata over the hardcoded fallbacks', () => {
    const html = renderBoard(
      snapshot({ meta: { channel_title: 'Custom Feed', channel_copyright: 'Someone Else' } }),
    );
    assert.ok(html.includes('Custom Feed'));
    assert.ok(html.includes('Someone Else'));
  });
});
