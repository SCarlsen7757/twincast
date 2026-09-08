import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { qrSvg } from '../src/qr.js';

describe('qrSvg', () => {
  test('returns an empty string for nothing to encode', () => {
    assert.equal(qrSvg(''), '');
    assert.equal(qrSvg(null), '');
    assert.equal(qrSvg(undefined), '');
  });

  test('emits a self-contained SVG', () => {
    const svg = qrSvg('https://example.invalid/download');
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /viewBox="0 0 \d+ \d+"/);
    assert.ok(svg.endsWith('</svg>'));
  });

  // A single <path> rather than one <rect> per module: ~26 kB -> ~3 kB per code,
  // which matters because every hero's QR is inlined into the page.
  test('draws a single path and lets CSS own the colour', () => {
    const svg = qrSvg('https://example.invalid/download');
    assert.equal(svg.match(/<path/g)?.length, 1);
    assert.ok(svg.includes('fill="currentColor"'));
    assert.ok(!svg.includes('<rect'));
  });

  test('memoises: the same URL returns an identical string', () => {
    const url = 'https://example.invalid/same';
    assert.equal(qrSvg(url), qrSvg(url));
  });

  test('encodes different URLs differently', () => {
    assert.notEqual(qrSvg('https://example.invalid/a'), qrSvg('https://example.invalid/bbbbb'));
  });

  test('auto-sizes for a long payload', () => {
    const small = qrSvg('a');
    const large = qrSvg('x'.repeat(300));
    const size = (s: string): number => Number(/viewBox="0 0 (\d+)/.exec(s)?.[1]);
    assert.ok(size(large) > size(small));
  });
});
