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

  test('rejects invalid explicit settings with the variable name', () => {
    for (const value of ['0', '-5', 'abc', '', '65536', '80.5', 'Infinity']) {
      assert.throws(() => loadConfig({ PORT: value }), /PORT/);
    }
    for (const key of ['HERO_COUNT', 'RAIL_COUNT']) {
      for (const value of ['1.5', '9', '0'])
        assert.throws(() => loadConfig({ [key]: value }), new RegExp(key));
    }
    for (const [key, value] of [
      ['ROTATE_SECONDS', '4'],
      ['ROTATE_SECONDS', '301'],
      ['ROTATE_SECONDS', '5.5'],
      ['POLL_INTERVAL_MIN', '0.01'],
      ['POLL_INTERVAL_MIN', '1441'],
      ['STALE_AFTER_MIN', '10081'],
    ]) {
      assert.ok(key);
      assert.ok(value);
      assert.throws(() => loadConfig({ [key]: value }), new RegExp(key));
    }
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
