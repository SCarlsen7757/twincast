import { config } from './config.js';
import { familyLabel } from './parse.js';
import { safeLink } from './urls.js';
import type { Item, ItemWithQr, Snapshot } from './types.js';

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const esc = (s: string | number | null | undefined): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function shortDate(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()] ?? ''} ${d.getFullYear()}`;
}

/**
 * Calendar-day age for a release: "Today", "Yesterday", "3 days ago".
 *
 * Deliberately counts whole days across local midnight rather than elapsed hours --
 * something published at 23:00 last night reads as "Yesterday", not "2 hours ago",
 * which is what you actually want to know at a glance from across the room.
 */
export function relDay(epochSec: number, now: Date = new Date()): string {
  const then = new Date(epochSec * 1000);
  const midnightThen = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const midnightNow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((midnightNow.getTime() - midnightThen.getTime()) / 86400000);

  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 31) return `${days} days ago`;
  const months = Math.round(days / 30.44);
  if (months < 18) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.round(days / 365.25);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

/**
 * Elapsed-time age, used for the "updated ..." freshness label in the header.
 *
 * Note the tiers divide by 30 and 12 where relDay above uses 30.44 and 365.25, so
 * the two disagree by a step for some ages (45 days is "1 month" here, "2 months"
 * there). They measure different things -- feed freshness vs release age -- and are
 * never shown side by side, so the divisors are left as they are.
 */
export function relTime(epochSec: number, nowSec: number = Math.floor(Date.now() / 1000)): string {
  const s = Math.max(0, nowSec - epochSec);
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 31) return `${d} day${d === 1 ? '' : 's'} ago`;
  const mo = Math.round(d / 30);
  if (mo < 18) return `${mo} month${mo === 1 ? '' : 's'} ago`;
  return `${Math.round(mo / 12)} years ago`;
}

const chip = (channel: Item['channel']): string =>
  channel
    ? `<span class="chip chip--${esc(channel)}">${channel === 'testing' ? 'Testing feed' : 'Stable feed'}</span>`
    : '';

function heroArticle(item: ItemWithQr, idx: number): string {
  const codes = item.codes || '';
  const badge = codes
    ? `<span class="badge" data-family="${esc(item.family || '')}">${esc(codes)}</span>`
    : '';
  const version = item.version
    ? `<p class="hero__version"><span class="v">${esc(item.version)}</span></p>`
    : '';

  return `
    <article class="hero${idx === 0 ? ' is-active' : ''}">
      <div class="hero__body">
        <div class="hero__top">
          ${badge}
          <span class="family">${esc(familyLabel(item.family))}</span>
          ${chip(item.channel)}
        </div>
        <h1 class="hero__name">${esc(item.name)}</h1>
        ${version}
        <p class="hero__desc">${esc(item.description)}</p>
      </div>
      <div class="hero__foot">
        ${item.qr && safeLink(item.link) ? `<div class="qr">${item.qr}</div><p class="qr__label">Scan to open<br>the download page</p>` : '<p class="qr__label">Download link unavailable</p>'}
        <p class="when">
          <span class="ago" data-pub="${item.pub_date}">${esc(relDay(item.pub_date))}</span>
          <span class="date">${esc(shortDate(item.pub_date))}</span>
        </p>
      </div>
    </article>`;
}

function railRow(item: Item, idx: number): string {
  return `
    <li class="rail__row${idx === 0 ? ' is-active' : ''}">
      <span class="rail__code" data-family="${esc(item.family || '')}">${esc(item.codes || '—')}</span>
      <span class="rail__name">${esc(item.name)}</span>
      <span class="rail__meta">
        <span class="rail__version">${esc(item.version || '')}</span>
        <span class="rail__date">${esc(shortDate(item.pub_date).replace(/ \d{4}$/, ''))}</span>
      </span>
    </li>`;
}

function emptyState(snapshot: Snapshot): string {
  const reason = snapshot.lastError
    ? `Last attempt failed: ${esc(snapshot.lastError)}`
    : 'Waiting for the first successful poll.';
  return `
    <article class="hero is-active hero--empty">
      <h1 class="hero__name">No releases stored yet</h1>
      <p class="hero__desc">${reason}</p>
    </article>`;
}

export function renderBoard(snapshot: Snapshot): string {
  const { items, meta } = snapshot;
  const heroes = items.slice(0, config.heroCount);
  const rail = items.slice(0, config.railCount);

  const copyright = meta.channel_copyright || 'Beckhoff Automation GmbH & Co. KG';
  const sourceName = meta.channel_title || 'Beckhoff TwinCAT RSS Feed';
  const sourceLink = safeLink(meta.channel_link || '') || 'https://www.beckhoff.com/en-en/';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(sourceName)}</title>
<link rel="stylesheet" href="/board.css">
</head>
<body
  data-rotate="${config.rotateSeconds}"
  data-content-revision="${esc(snapshot.contentRevision)}"
  data-last-success="${snapshot.lastSuccess ?? ''}"
  data-stale-after="${config.staleAfterMin * 60}"
  data-stale="${snapshot.stale ? '1' : '0'}">

<div class="board">
  <header class="topbar">
    <div class="brand">
      <img class="brand__logo" src="/logo" alt="">
      <span class="brand__title">${esc(sourceName)}</span>
    </div>
    <div class="status">
      <span class="status__dot" aria-hidden="true"></span>
      <span id="feed-status">${snapshot.stale ? 'Feed stale' : 'Feed current'}</span>
      <span class="status__updated" id="updated">${
        snapshot.lastSuccess ? `updated ${esc(relTime(snapshot.lastSuccess))}` : 'never updated'
      }</span>
      <time class="status__clock" id="clock"></time>
    </div>
  </header>

  <main class="main">
    <section class="stage">
      ${heroes.length ? heroes.map(heroArticle).join('') : emptyState(snapshot)}
      <div class="progress"><span class="progress__bar" id="progress"></span></div>
    </section>

    <aside class="rail">
      <h2 class="rail__title">Latest releases</h2>
      <ol class="rail__list">${rail.map(railRow).join('')}</ol>
    </aside>
  </main>

  <footer class="attribution">
    <span>Source: <a href="${esc(sourceLink)}">${esc(sourceName)}</a> &middot; &copy; ${esc(copyright)}</span>
    <span class="attribution__note">Unofficial internal display &middot; not affiliated with or endorsed by Beckhoff Automation</span>
  </footer>
</div>

<script src="/board.js" defer></script>
</body>
</html>`;
}
