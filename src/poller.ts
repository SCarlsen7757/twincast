import { createHash } from 'node:crypto';
import { config } from './config.js';
import { fetchFeed, cacheLogo, readLogo, logoDigest } from './feed.js';
import { parseFeed } from './parse.js';
import { upsertItems, setMeta, getMeta, getLatest, countItems, openDb } from './db.js';
import { qrSvg } from './qr.js';
import { errMessage } from './errors.js';
import type { PollResult, Snapshot, StoredSnapshot } from './types.js';

const nowSec = () => Math.floor(Date.now() / 1000);

let snapshot: StoredSnapshot = {
  contentRevision: '',
  apiItems: [],
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
  const apiItems = getLatest(100);
  const items = apiItems.slice(0, Math.max(config.heroCount, config.railCount)).map((i, index) => ({
    ...i,
    qr: index < config.heroCount ? qrSvg(i.link) : '',
  }));
  snapshot = {
    contentRevision: createHash('sha256')
      .update(
        JSON.stringify({
          items,
          title: meta.channel_title,
          link: meta.channel_link,
          copyright: meta.channel_copyright,
          logo: logoDigest(),
        }),
      )
      .digest('hex'),
    apiItems,
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
const defaults = {
  fetchFeed,
  cacheLogo,
  readLogo,
  getMeta,
  setMeta,
  upsertItems,
  refreshSnapshot,
  nowSec,
};
type PollDependencies = typeof defaults;
let inFlight: Promise<PollResult> | null = null;

/** Manual and scheduled callers share one in-flight poll. */
export function pollOnce(overrides: Partial<PollDependencies> = {}): Promise<PollResult> {
  if (inFlight) return inFlight;
  inFlight = performPoll({ ...defaults, ...overrides }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function recoverLogo(deps: PollDependencies): Promise<void> {
  try {
    if (!deps.readLogo()) {
      const type = await deps.cacheLogo(deps.getMeta().channel_image);
      if (type) deps.setMeta({ logo_content_type: type });
    }
  } catch (err) {
    console.error('[logo] recovery failed:', errMessage(err));
  }
}

async function performPoll(deps: PollDependencies): Promise<PollResult> {
  const previous = snapshot;
  try {
    const meta = deps.getMeta();
    const res = await deps.fetchFeed({ etag: meta.etag, lastModified: meta.last_modified });
    const checked = deps.nowSec();

    if (res.status === 304) {
      deps.setMeta({ last_checked: checked, last_success: checked, last_error: '' });
      await recoverLogo(deps);
      deps.refreshSnapshot();
      return { status: 'not-modified' };
    }

    // Beckhoff ignores If-None-Match/If-Modified-Since (verified: both return a
    // full 200), so the 304 path above rarely fires. Hash the body ourselves to
    // avoid re-parsing and re-writing 386 rows every cycle -- that matters on a
    // Pi's SD card. The conditional headers stay in case they enable them later.
    const hash = createHash('sha256').update(res.xml).digest('hex');
    if (hash === meta.body_hash) {
      deps.setMeta({
        etag: res.etag || '',
        last_modified: res.lastModified || '',
        last_checked: checked,
        last_success: checked,
        last_error: '',
      });
      await recoverLogo(deps);
      deps.refreshSnapshot();
      return { status: 'unchanged' };
    }

    const { meta: channelMeta, items } = parseFeed(res.xml);
    const added = deps.upsertItems(items);

    deps.setMeta({
      ...channelMeta,
      etag: res.etag || '',
      last_modified: res.lastModified || '',
      body_hash: hash,
      last_checked: checked,
      last_success: checked,
      last_error: '',
    });

    await recoverLogo(deps);
    deps.refreshSnapshot();
    return { status: 'updated', parsed: items.length, added };
  } catch (err) {
    // A failed poll must never take the board down: keep serving what SQLite has.
    const error = errMessage(err);
    const checked = deps.nowSec();
    try {
      deps.setMeta({ last_checked: checked, last_error: error });
    } catch {
      /* Storage may be unavailable. */
    }
    snapshot = { ...previous, lastChecked: checked, lastError: error };
    return { status: 'error', error };
  }
}

export async function startPolling({
  immediate = config.pollOnStart,
  poll = pollOnce,
}: { immediate?: boolean; poll?: () => Promise<PollResult> } = {}): Promise<void> {
  if (running) return;
  openDb();
  refreshSnapshot();
  running = true;
  const current = ++generation;

  const schedule = () => {
    if (!running || current !== generation) return;
    timer = setTimeout(() => {
      void run();
    }, config.pollIntervalMin * 60_000);
    timer.unref();
  };

  const run = async () => {
    try {
      const r = await poll();
      const at = new Date().toISOString();
      if (r.status === 'error') console.error(`[poll] ${at} FAILED: ${r.error}`);
      else if (r.status === 'not-modified') console.log(`[poll] ${at} not modified (304)`);
      else if (r.status === 'unchanged') console.log(`[poll] ${at} unchanged (same content)`);
      else console.log(`[poll] ${at} updated: ${r.parsed} parsed, ${r.added} new`);
    } catch (err) {
      console.error('[poll] unexpected failure:', errMessage(err));
    } finally {
      schedule();
    }
  };

  if (immediate) await run();
  else schedule();
}

let running = false;
let generation = 0;

export function stopPolling(): void {
  running = false;
  generation++;
  if (timer) clearTimeout(timer);
  timer = null;
}
