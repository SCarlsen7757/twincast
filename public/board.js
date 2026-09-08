/* Board runtime: rotation, clock, relative times, refresh detection, burn-in drift.
   Everything here is intentionally small and allocation-light -- this runs for weeks
   at a time on a Raspberry Pi. */
(function () {
  'use strict';

  var body = document.body;
  var heroes = Array.prototype.slice.call(document.querySelectorAll('.hero'));
  var rows = Array.prototype.slice.call(document.querySelectorAll('.rail__row'));
  var progress = document.getElementById('progress');
  var clockEl = document.getElementById('clock');
  var updatedEl = document.getElementById('updated');

  var rotateMs = (parseInt(body.getAttribute('data-rotate'), 10) || 12) * 1000;
  var index = 0;
  var pendingReload = false;
  var startedAt = Date.now();

  // Anthias reloads this page roughly every 5 minutes, so a 5-minute timer would
  // fire exactly at the cut-off and effectively never run. Both of these are set
  // to comfortably fit inside one showing.
  var REFRESH_MS = 2 * 60 * 1000; // poll the API for changes
  var DRIFT_MS = 90 * 1000; // burn-in nudge
  var MAX_UPTIME_MS = 24 * 60 * 60 * 1000;

  /* ---------- clock ---------- */

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function tickClock() {
    if (!clockEl) return;
    var d = new Date();
    clockEl.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
    clockEl.setAttribute('datetime', d.toISOString());
  }

  /* ---------- relative times ---------- */

  function relTime(epochSec) {
    var s = Math.max(0, Math.floor(Date.now() / 1000) - epochSec);
    if (s < 90) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
    var h = Math.round(m / 60);
    if (h < 36) return h + (h === 1 ? ' hour ago' : ' hours ago');
    var dd = Math.round(h / 24);
    if (dd < 31) return dd + (dd === 1 ? ' day ago' : ' days ago');
    var mo = Math.round(dd / 30);
    if (mo < 18) return mo + (mo === 1 ? ' month ago' : ' months ago');
    return Math.round(mo / 12) + ' years ago';
  }

  // Calendar-day age, mirroring relDay() in src/render.ts -- kept in step by
  // test/board-parity.test.ts, which fails if the two ever disagree. Counts whole days across
  // local midnight, so something posted at 23:00 last night reads "Yesterday".
  function relDay(epochSec) {
    var then = new Date(epochSec * 1000);
    var now = new Date();
    var midnightThen = new Date(then.getFullYear(), then.getMonth(), then.getDate());
    var midnightNow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var days = Math.round((midnightNow - midnightThen) / 86400000);

    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 31) return days + ' days ago';
    var months = Math.round(days / 30.44);
    if (months < 18) return months + (months === 1 ? ' month ago' : ' months ago');
    var years = Math.round(days / 365.25);
    return years + (years === 1 ? ' year ago' : ' years ago');
  }

  function refreshAges() {
    var nodes = document.querySelectorAll('.ago[data-pub]');
    for (var i = 0; i < nodes.length; i++) {
      var pub = parseInt(nodes[i].getAttribute('data-pub'), 10);
      if (pub) nodes[i].textContent = relDay(pub);
    }
  }

  /* ---------- rotation ---------- */

  function restartProgress() {
    if (!progress) return;
    progress.style.transition = 'none';
    progress.style.transform = 'scaleX(0)';
    // force a reflow so the reset is committed before the new transition starts
    void progress.offsetWidth;
    progress.style.transition = 'transform ' + rotateMs + 'ms linear';
    progress.style.transform = 'scaleX(1)';
  }

  function show(next) {
    if (heroes[index]) heroes[index].classList.remove('is-active');
    if (rows[index]) rows[index].classList.remove('is-active');
    index = next;
    if (heroes[index]) heroes[index].classList.add('is-active');
    if (rows[index]) rows[index].classList.add('is-active');
    restartProgress();
  }

  function advance() {
    if (heroes.length < 2) {
      // Nothing to rotate, but still honour a pending refresh.
      if (pendingReload || Date.now() - startedAt > MAX_UPTIME_MS) location.reload();
      return;
    }
    var next = (index + 1) % heroes.length;
    // Wrapping to the top is the quiet moment to apply new content or recycle.
    if (next === 0 && (pendingReload || Date.now() - startedAt > MAX_UPTIME_MS)) {
      location.reload();
      return;
    }
    show(next);
  }

  /* ---------- refresh detection ---------- */

  function currentSignature() {
    var first = heroes[0];
    return heroes.length + '|' + (first ? first.querySelector('.hero__name').textContent : '');
  }

  var signature = currentSignature();

  function checkForUpdates() {
    fetch('/api/news?limit=1', { cache: 'no-store' })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (data) {
        if (!data) return;
        if (updatedEl) {
          updatedEl.textContent = data.lastSuccess
            ? 'updated ' + relTime(data.lastSuccess)
            : 'never updated';
        }
        body.setAttribute('data-stale', data.stale ? '1' : '0');

        var newest = data.items && data.items[0];
        if (newest && newest.name && signature.indexOf(newest.name) === -1) {
          // Server has different content: pick it up on the next wrap so the
          // reload never interrupts an item mid-view.
          pendingReload = true;
        }
      })
      .catch(function () {
        /* offline is fine; the board keeps showing cached data */
      });
  }

  /* ---------- burn-in mitigation ---------- */

  var driftOffsets = [
    [0, 0],
    [2, 1],
    [0, 2],
    [-2, 1],
    [-2, -1],
    [0, -2],
    [2, -1],
  ];
  var boardEl = document.querySelector('.board');

  // Derived from the wall clock rather than from page uptime. Under Anthias the
  // page is reloaded every few minutes, which reset a per-page counter to 0 every
  // time -- leaving the board pinned at offset (0,0) and the burn-in mitigation
  // doing nothing at all. Keying off Date.now() means the offset keeps advancing
  // across reloads, which is the whole point on a screen that runs for months.
  function drift() {
    if (!boardEl) return;
    var o = driftOffsets[Math.floor(Date.now() / DRIFT_MS) % driftOffsets.length];
    boardEl.style.transform = 'translate(' + o[0] + 'px,' + o[1] + 'px)';
  }

  /* ---------- test seam ---------- */

  // Exposed so test/board-parity.test.ts can diff these against their
  // counterparts in src/render.ts. Inert in a browser: nothing reads it.
  if (typeof window !== 'undefined') {
    window.__twincastTime = { relTime: relTime, relDay: relDay };
  }

  /* ---------- start ---------- */

  tickClock();
  refreshAges();
  restartProgress();
  drift(); // adopt the current wall-clock offset straight away

  setInterval(tickClock, 1000);
  setInterval(refreshAges, 60 * 1000);
  setInterval(advance, rotateMs);
  setInterval(checkForUpdates, REFRESH_MS);
  setInterval(drift, DRIFT_MS);
})();
