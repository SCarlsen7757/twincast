import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

const image = process.argv[2] || 'twincast:smoke';
const platform = process.argv[3] || 'linux/amd64';
const directory = mkdtempSync(join(tmpdir(), 'twincast-smoke-'));
// This disposable directory contains synthetic test data only. Real deployments
// should assign ownership to UID 1000 instead of granting world write access.
chmodSync(directory, 0o777);
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', timeout: 120000 }).trim();
let container;
let base;
async function start() {
  container = docker(
    'run',
    '-d',
    '--platform',
    platform,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    '--mount',
    `type=bind,source=${directory},target=/data`,
    '-p',
    '127.0.0.1::8080',
    '-e',
    'POLL_ON_START=false',
    image,
  );
  const port = docker('port', container, '8080/tcp').split(':').at(-1);
  base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`${base}/tv`, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      /* Wait for boot. */
    }
    await setTimeout(500);
  }
  throw new Error('Container did not become ready');
}
async function status(path, expected) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, expected, path);
  return response;
}
try {
  await start();
  assert.match(await (await status('/tv', 200)).text(), /Beckhoff Automation/);
  await status('/', 200);
  await status('/healthz', 503);
  for (const path of ['/%', '/%FF', '/%2']) await status(path, 400);
  await status('/api/news', 200);
  const css = await status('/board.css', 200);
  assert.match(css.headers.get('content-security-policy'), /script-src 'self'/);
  docker(
    'exec',
    container,
    'node',
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    import { accessSync, constants } from 'node:fs';
    import { openDb, closeDb, upsertItems, setMeta } from '/app/dist/src/db.js';
    assert.equal(process.getuid(), 1000);
    assert.throws(() => accessSync('/app/dist/src/server.js', constants.W_OK));
    openDb();
    upsertItems(Array.from({length:105}, (_, i) => ({guid:'smoke-'+i,title:'New version of TF1000 Fixture',
      name:'Fixture',codes:'TF1000',family:'TF',version:'1.0.'+i,channel:'stable',
      link:i===0?'https://example.invalid/'+ 'x'.repeat(5000):'https://example.invalid/download',
      description:'Synthetic smoke fixture',pub_date:1800000000-i})));
    setMeta({last_success:Math.floor(Date.now()/1000)}); closeDb();
  `,
  );
  docker('rm', '-f', container);
  container = undefined;
  // Recreate with the same bind mount to prove persistence and poisoned-QR recovery.
  await start();
  await status('/healthz', 200);
  const api = await (await status('/api/news?limit=100', 200)).json();
  assert.equal(api.itemCount, 105);
  assert.equal(api.items.length, 100);
  assert.match(api.contentRevision, /^[a-f0-9]{64}$/);
  assert.equal((await (await status('/api/news', 200)).json()).items.length, 25);
  assert.match(await (await status('/tv', 200)).text(), /Download link unavailable/);
  console.log(
    `${platform}: empty, malformed-request, populated, non-root and bind-persistence smoke passed`,
  );
} catch (error) {
  if (container) {
    try {
      console.error(docker('logs', container));
    } catch {
      /* Preserve original failure. */
    }
  }
  throw error;
} finally {
  if (container) docker('rm', '-f', container);
  // directory comes directly from mkdtemp; never delete a configured data path.
  rmSync(directory, { recursive: true, force: true });
}
