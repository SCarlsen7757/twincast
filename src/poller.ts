import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { config, dataDir } from './config.js';
import { fetchFeed, cacheLogo } from './feed.js';
import { parseFeed } from './parse.js';
import { upsertItems, setMeta, getMeta, getLatest, countItems, openDb } from './db.js';
import { qrSvg } from './qr.js';
import { errMessage } from './errors.js';
import type { PollResult, Snapshot, StoredSnapshot } from './types.js';

const nowSec = () => Math.floor(Date.now() / 1000);

let snapshot: StoredSnapshot = {
  items: [],
  meta: {},
  itemCount: 0,
  lastSuccess: null,
  lastChecked: null,
  lastError: null,
};

let timer: NodeJS.Timeout | null = null;

/** Rebuild the in-memory view the HTTP layer renders from. */
export function refreshSnapshot(): StoredSnapshot {
  const meta = getMeta();
  const items = getLatest(config.heroCount + config.railCount).map((i) => ({
    ...i,
    qr: qrSvg(i.link),
  }));
  snapshot = {
    items,
    meta,
    itemCount: countItems(),
    lastSuccess: meta.last_success ? Number(meta.last_success) : null,
    lastChecked: meta.last_checked ? Number(meta.last_checked) : null,
    lastError: meta.last_error || null,
  };
  return snapshot;
}

/**
 * Read model for the HTTP layer. `stale` is computed per call rather than stored,
 * because it depends on elapsed time, not on the last poll's outcome.
 */
export function getSnapshot(): Snapshot {
  const ageSec = snapshot.lastSuccess ? nowSec() - snapshot.lastSuccess : null;
  return {
    ...snapshot,
    ageSec,
    stale: ageSec === null || ageSec > config.staleAfterMin * 60,
  };
}

/** Never throws. Returns a short result describing what happened. */
export async function pollOnce(): Promise<PollResult> {
  const meta = getMeta();
  try {
    const res = await fetchFeed({ etag: meta.etag, lastModified: meta.last_modified });
    const checked = nowSec();

    if (res.status === 304) {
      setMeta({ last_checked: checked, last_success: checked, last_error: '' });
      refreshSnapshot();
      return { status: 'not-modified' };
    }

    // Beckhoff ignores If-None-Match/If-Modified-Since (verified: both return a
    // full 200), so the 304 path above rarely fires. Hash the body ourselves to
    // avoid re-parsing and re-writing 386 rows every cycle -- that matters on a
    // Pi's SD card. The conditional headers stay in case they enable them later.
    const hash = createHash('sha256').update(res.xml).digest('hex');
    if (hash === meta.body_hash) {
      setMeta({
        etag: res.etag || '',
        last_modified: res.lastModified || '',
        last_checked: checked,
        last_success: checked,
        last_error: '',
      });
      refreshSnapshot();
      return { status: 'unchanged' };
    }

    const { meta: channelMeta, items } = parseFeed(res.xml);
    const added = upsertItems(items);

    setMeta({
      ...channelMeta,
      etag: res.etag || '',
      last_modified: res.lastModified || '',
      body_hash: hash,
      last_checked: checked,
      last_success: checked,
      last_error: '',
    });

    // Best effort, and only when we don't already hold it.
    if (channelMeta.channel_image && !existsSync(join(dataDir(), 'logo.bin'))) {
      const type = await cacheLogo(channelMeta.channel_image);
      if (type) setMeta({ logo_content_type: type });
    }

    refreshSnapshot();
    return { status: 'updated', parsed: items.length, added };
  } catch (err) {
    // A failed poll must never take the board down: keep serving what SQLite has.
    setMeta({ last_checked: nowSec(), last_error: errMessage(err) });
    refreshSnapshot();
    return { status: 'error', error: errMessage(err) };
  }
}

export async function startPolling({
  immediate = config.pollOnStart,
}: { immediate?: boolean } = {}): Promise<NodeJS.Timeout> {
  openDb();
  refreshSnapshot();

  const run = async () => {
    const r = await pollOnce();
    const at = new Date().toISOString();
    if (r.status === 'error') console.error(`[poll] ${at} FAILED: ${r.error}`);
    else if (r.status === 'not-modified') console.log(`[poll] ${at} not modified (304)`);
    else if (r.status === 'unchanged') console.log(`[poll] ${at} unchanged (same content)`);
    else console.log(`[poll] ${at} updated: ${r.parsed} parsed, ${r.added} new`);
  };

  if (immediate) await run();
  timer = setInterval(() => {
    void run();
  }, config.pollIntervalMin * 60_000);
  timer.unref();
  return timer;
}

export function stopPolling(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
