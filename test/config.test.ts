import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

describe('loadConfig defaults', () => {
  test('matches the table documented in the README', () => {
    const c = loadConfig({});
    assert.equal(c.port, 8080);
    assert.equal(c.feedUrl, 'https://www.beckhoff.com/english/rss/beckhoff-twincat-rss-feed.xml');
    assert.equal(c.pollIntervalMin, 30);
    assert.equal(c.pollOnStart, true);
    assert.equal(c.dbPath, './data/board.db');
    assert.equal(c.heroCount, 6);
    assert.equal(c.railCount, 8);
    assert.equal(c.rotateSeconds, 25);
    assert.equal(c.staleAfterMin, 120);
    assert.match(c.userAgent, /^Twincast\//);
  });
});

describe('numeric coercion', () => {
  test('accepts a positive integer', () => {
    assert.equal(loadConfig({ PORT: '9000' }).port, 9000);
  });

  // The guard is `> 0`, so zero and negatives fall back rather than binding to
  // an ephemeral port or a nonsensical interval.
  test('falls back on zero, negatives and non-numbers', () => {
    assert.equal(loadConfig({ PORT: '0' }).port, 8080);
    assert.equal(loadConfig({ PORT: '-5' }).port, 8080);
    assert.equal(loadConfig({ PORT: 'abc' }).port, 8080);
    assert.equal(loadConfig({ PORT: '' }).port, 8080);
  });

  test('accepts a fractional value', () => {
    assert.equal(loadConfig({ POLL_INTERVAL_MIN: '0.5' }).pollIntervalMin, 0.5);
  });
});

describe('boolean coercion', () => {
  test('accepts every documented truthy spelling', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'Yes', 'on', 'ON']) {
      assert.equal(loadConfig({ POLL_ON_START: v }).pollOnStart, true, v);
    }
  });

  // CI runs the container with POLL_ON_START=false, so this one is load-bearing.
  test('treats anything else as false once the variable is set', () => {
    for (const v of ['0', 'false', 'no', 'off', '']) {
      assert.equal(loadConfig({ POLL_ON_START: v }).pollOnStart, false, v);
    }
  });

  test('uses the default only when the variable is absent', () => {
    assert.equal(loadConfig({}).pollOnStart, true);
  });
});

describe('string passthrough', () => {
  test('takes overrides verbatim and falls back on empty', () => {
    assert.equal(
      loadConfig({ FEED_URL: 'https://example.invalid/f.xml' }).feedUrl,
      'https://example.invalid/f.xml',
    );
    assert.equal(loadConfig({ USER_AGENT: 'Mine/1.0' }).userAgent, 'Mine/1.0');
    assert.match(loadConfig({ USER_AGENT: '' }).userAgent, /^Twincast\//);
  });
});
