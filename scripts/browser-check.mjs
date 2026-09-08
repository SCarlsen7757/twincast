// Optional real-browser check. Start scripts/visual-check.mjs first and provide
// Playwright via PLAYWRIGHT_MODULE or a local installation (not a runtime dependency).
/* global document */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.SCREENSHOT_DIR || 'data/browser-check';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/.test(message.text())) errors.push(message.text());
  });
  for (const scene of ['default', 'empty', 'single', 'long', 'missing', 'stale']) {
    await page.goto(`${process.env.PREVIEW_URL || 'http://127.0.0.1:8097'}/tv?scene=${scene}`);
    await page
      .locator('#clock')
      .filter({ hasText: /\d\d:\d\d/ })
      .waitFor();
    assert.equal(await page.locator('.hero.is-active').count(), 1);
    assert.equal(
      await page.locator('.rail__row').count(),
      scene === 'empty' ? 0 : scene === 'single' ? 1 : 8,
    );
    if (scene === 'missing')
      assert.match(await page.locator('.hero.is-active').innerText(), /Download link unavailable/);
    if (scene === 'stale' || scene === 'empty')
      assert.equal(await page.locator('#feed-status').innerText(), 'Feed stale');
    const metrics = await page.evaluate(() => {
      const targets = [
        ...document.querySelectorAll('.hero.is-active .hero__foot,.attribution,.status,.rail__row'),
      ];
      return targets.map((element) => {
        const r = element.getBoundingClientRect();
        return {
          name: element.className,
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
        };
      });
    });
    for (const box of metrics) {
      assert.ok(
        box.left >= 0 && box.right <= 1920 && box.top >= 0 && box.bottom <= 1080,
        `${scene}: ${JSON.stringify(box)}`,
      );
    }
    await page.screenshot({ path: `${output}/${scene}.png` });
  }
  assert.deepEqual(errors, []);
  console.log('All six 1080p browser fixtures passed with no runtime or CSP errors');
} finally {
  await browser.close();
}
