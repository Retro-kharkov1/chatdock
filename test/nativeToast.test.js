'use strict';

// src/main/nativeToast.js - the main-process toast service behind BUG-01-B (service-worker
// notifications Electron does not display) and the unread-count fallback (M3). The unread
// baseline itself lives in unreadTracker.js (test/unreadTracker.test.js); this service only sees
// already-classified increases.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeToastRequest, createToastService } = require('../src/main/nativeToast.js');

function makeService(initial = {}) {
  const state = { muted: false, sound: true, focused: false, t: 1_000_000, ...initial };
  const log = { toasts: [], closed: [], arrivals: 0, timers: [] };
  let handleSeq = 0;
  const service = createToastService({
    showNativeToast: (req) => {
      log.toasts.push(req);
      const id = (handleSeq += 1);
      return { id, close: () => log.closed.push(id) };
    },
    getMuted: () => state.muted,
    getSoundEnabled: () => state.sound,
    isWindowFocused: () => state.focused,
    onArrival: () => { log.arrivals += 1; },
    now: () => state.t,
    setTimer: (fn, ms) => log.timers.push({ fn, ms, at: state.t + ms }),
    fallbackDelayMs: 2500,
  });
  // Fires every pending timer (advancing the clock to its due time first).
  const fireTimers = () => {
    const pending = log.timers.splice(0);
    for (const x of pending) {
      state.t = Math.max(state.t, x.at);
      x.fn();
    }
  };
  return { service, state, log, fireTimers };
}

// --- sanitize -------------------------------------------------------------------------------

test('sanitize: rejects non-objects and missing/blank titles, never throws', () => {
  for (const bad of [null, undefined, 5, 'x', [], {}, { title: '' }, { title: '   ' }, { title: 7 }]) {
    assert.equal(sanitizeToastRequest(bad), null);
  }
});

test('sanitize: keeps title/body/tag, silent only when strictly true, caps lengths', () => {
  const r = sanitizeToastRequest({ title: 'Olena', body: 'Hi', silent: 'yes', tag: 'space/abc', extra: 1 });
  assert.deepEqual(r, { title: 'Olena', body: 'Hi', silent: false, tag: 'space/abc' });
  assert.equal(sanitizeToastRequest({ title: 'a'.repeat(500) }).title.length, 200);
  assert.equal(sanitizeToastRequest({ title: 't', body: 'b'.repeat(5000) }).body.length, 1000);
  assert.equal(sanitizeToastRequest({ title: 't', body: { x: 1 } }).body, '');
  assert.equal(sanitizeToastRequest({ title: 't', tag: 'x'.repeat(500) }).tag.length, 100);
  assert.equal(sanitizeToastRequest({ title: 't', tag: 5 }).tag, '');
});

test('sanitize (S3): tag-like markup is stripped from title and body', () => {
  assert.equal(sanitizeToastRequest({ title: '<b>Olena</b>', body: 'x <i>y</i> <a href="http://e.example">link</a>' }).title, 'Olena');
  assert.equal(
    sanitizeToastRequest({ title: 't', body: 'x <i>y</i> <a href="http://e.example">link</a><img src=x onerror=1>' }).body,
    'x y link'
  );
});

test('sanitize (S3): stray angle brackets cannot start markup but the text stays readable', () => {
  assert.equal(sanitizeToastRequest({ title: 't', body: 'a < b and c > d' }).body, 'a ‹ b and c › d');
  assert.equal(sanitizeToastRequest({ title: 't', body: '<' }).body, '‹');
});

test('sanitize (S3): a title that is only markup is rejected', () => {
  assert.equal(sanitizeToastRequest({ title: '<b></b>' }), null);
});

// --- show -----------------------------------------------------------------------------------

test('show: unmuted + sound on raises one non-silent toast and reports an arrival', () => {
  const { service, log } = makeService();
  assert.equal(service.show({ title: 'Olena', body: 'Hi' }), true);
  assert.deepEqual(log.toasts, [{ title: 'Olena', body: 'Hi', silent: false, tag: '' }]);
  assert.equal(log.arrivals, 1);
});

test('show (FR-11): sound off forces silent; the request own silent:true is kept', () => {
  const a = makeService({ sound: false });
  a.service.show({ title: 't' });
  assert.equal(a.log.toasts[0].silent, true);
  const b = makeService();
  b.service.show({ title: 't', silent: true });
  assert.equal(b.log.toasts[0].silent, true);
});

test('show (FR-12): muted raises no toast but is still reported as an arrival (attention applies mute itself)', () => {
  const { service, log } = makeService({ muted: true });
  assert.equal(service.show({ title: 't' }), false);
  assert.equal(log.toasts.length, 0);
  assert.equal(log.arrivals, 1);
});

test('show: an invalid payload does nothing at all', () => {
  const { service, log } = makeService();
  assert.equal(service.show({ body: 'no title' }), false);
  assert.equal(log.toasts.length, 0);
  assert.equal(log.arrivals, 0);
});

test('noteArrival: reports an arrival without raising a toast (the page made its own)', () => {
  const { service, log } = makeService();
  service.noteArrival();
  assert.equal(log.arrivals, 1);
  assert.equal(log.toasts.length, 0);
});

// --- F5: duplicate suppression --------------------------------------------------------------

test('F5: an identical title+body within 200 ms is dropped (double delivery), later ones are not', () => {
  const { service, state, log } = makeService();
  service.show({ title: 'Olena', body: 'Hi' });
  state.t += 100;
  assert.equal(service.show({ title: 'Olena', body: 'Hi' }), false);
  assert.equal(log.toasts.length, 1);
  assert.equal(log.arrivals, 1);
  state.t += 300;
  assert.equal(service.show({ title: 'Olena', body: 'Hi' }), true);
  assert.equal(log.toasts.length, 2);
});

test('F5: different content within 200 ms is not a duplicate', () => {
  const { service, log } = makeService();
  service.show({ title: 'Olena', body: 'Hi' });
  service.show({ title: 'Olena', body: 'Hi again' });
  assert.equal(log.toasts.length, 2);
});

// --- F3: tag replaces instead of stacking ---------------------------------------------------

test('F3: a new toast with the same tag closes the previous one first', () => {
  const { service, state, log } = makeService();
  service.show({ title: 'Olena', body: 'one', tag: 'space/abc' });
  state.t += 500;
  service.show({ title: 'Olena', body: 'two', tag: 'space/abc' });
  assert.equal(log.toasts.length, 2);
  assert.deepEqual(log.closed, [1]);
});

test('F3: different tags, or no tag, never close anything', () => {
  const { service, state, log } = makeService();
  service.show({ title: 'A', body: '1', tag: 'space/a' });
  state.t += 500;
  service.show({ title: 'B', body: '2', tag: 'space/b' });
  state.t += 500;
  service.show({ title: 'C', body: '3' });
  state.t += 500;
  service.show({ title: 'D', body: '4' });
  assert.deepEqual(log.closed, []);
});

// --- S2: rate limit -------------------------------------------------------------------------

test('S2: at most 3 toasts per second; the excess is coalesced into ONE summary toast', () => {
  const { service, log, fireTimers } = makeService();
  for (let i = 0; i < 8; i += 1) service.show({ title: `T${i}`, body: `b${i}` });
  assert.equal(log.toasts.length, 3);
  fireTimers();
  assert.equal(log.toasts.length, 4);
  assert.deepEqual(
    { title: log.toasts[3].title, body: log.toasts[3].body },
    { title: 'Google Chat', body: '5 more notifications' }
  );
});

test('S2: the window slides - after a second the next toast is shown normally', () => {
  const { service, state, log } = makeService();
  for (let i = 0; i < 3; i += 1) service.show({ title: `T${i}`, body: `b${i}` });
  state.t += 1100;
  service.show({ title: 'later', body: 'x' });
  assert.equal(log.toasts.length, 4);
});

test('S2: nothing is coalesced when the rate stays under the limit (no summary toast)', () => {
  const { service, log, fireTimers } = makeService();
  service.show({ title: 'a', body: '1' });
  fireTimers();
  assert.equal(log.toasts.length, 1);
});

test('S2 (FR-12): a coalesced summary is not raised when muted at flush time', () => {
  const { service, state, log, fireTimers } = makeService();
  for (let i = 0; i < 5; i += 1) service.show({ title: `T${i}`, body: `b${i}` });
  state.muted = true;
  fireTimers();
  assert.equal(log.toasts.length, 3);
});

// --- unread-count fallback (M3) -------------------------------------------------------------

test('fallback: an increase with no arrival report raises one generic toast after the delay', () => {
  const { service, log, fireTimers } = makeService();
  service.onUnreadObserve(2);
  service.onUnreadIncrease(2);
  assert.equal(log.timers[0].ms, 2500);
  fireTimers();
  assert.deepEqual(
    log.toasts.map((t) => [t.title, t.body]),
    [['Google Chat', '2 unread messages']]
  );
});

test('fallback: singular wording for one unread message', () => {
  const { service, log, fireTimers } = makeService();
  service.onUnreadObserve(1);
  service.onUnreadIncrease(1);
  fireTimers();
  assert.equal(log.toasts[0].body, '1 unread message');
});

test('fallback: a real arrival AFTER the increase, inside the delay, cancels it (one path per message)', () => {
  const { service, log, fireTimers } = makeService();
  service.onUnreadObserve(1);
  service.onUnreadIncrease(1);
  service.show({ title: 'Olena', body: 'Hi' });
  fireTimers();
  assert.equal(log.toasts.length, 1);
  assert.equal(log.toasts[0].title, 'Olena');
});

test('F1: a real arrival shortly BEFORE the increase (toast first, title 50-300 ms later) suppresses the fallback', () => {
  const { service, state, log, fireTimers } = makeService();
  service.show({ title: 'Olena', body: 'Hi' });
  state.t += 200;
  service.onUnreadObserve(1);
  service.onUnreadIncrease(1);
  fireTimers();
  assert.equal(log.toasts.length, 1);
  assert.equal(log.toasts[0].title, 'Olena');
});

test('F1: one arrival matches one increase only - a second increase with no new arrival still falls back', () => {
  const { service, state, log, fireTimers } = makeService();
  service.show({ title: 'Olena', body: 'Hi' });
  state.t += 200;
  service.onUnreadObserve(1);
  service.onUnreadIncrease(1);
  state.t += 400;
  service.onUnreadObserve(2);
  service.onUnreadIncrease(2);
  fireTimers();
  assert.equal(log.toasts.length, 2);
  assert.equal(log.toasts[1].body, '2 unread messages');
});

test('F1: an arrival that is older than the match window (5 s) does not suppress the fallback', () => {
  const { service, state, log, fireTimers } = makeService();
  service.noteArrival();
  state.t += 6000;
  service.onUnreadObserve(1);
  service.onUnreadIncrease(1);
  fireTimers();
  assert.equal(log.toasts.length, 1);
  assert.equal(log.toasts[0].title, 'Google Chat');
});

test('F1: an arrival after an increase is consumed by it and cannot suppress a later, unrelated increase', () => {
  const { service, state, log, fireTimers } = makeService();
  service.onUnreadObserve(1);
  service.onUnreadIncrease(1);
  state.t += 500;
  service.show({ title: 'Olena', body: 'Hi' });
  fireTimers(); // the first fallback is cancelled by the arrival and consumes it
  state.t += 1000;
  service.onUnreadObserve(2);
  service.onUnreadIncrease(2);
  fireTimers();
  assert.equal(log.toasts.length, 2);
  assert.equal(log.toasts[1].body, '2 unread messages');
});

test('fallback: nothing when the window is focused by the time the timer fires', () => {
  const { service, state, log, fireTimers } = makeService();
  service.onUnreadObserve(2);
  service.onUnreadIncrease(2);
  state.focused = true;
  fireTimers();
  assert.equal(log.toasts.length, 0);
});

test('fallback: nothing when the (confirmed) count returned to 0 before the timer fires', () => {
  const { service, log, fireTimers } = makeService();
  service.onUnreadObserve(2);
  service.onUnreadIncrease(2);
  service.onUnreadObserve(0);
  fireTimers();
  assert.equal(log.toasts.length, 0);
});

test('fallback (FR-12): muted raises no generic toast', () => {
  const { service, log, fireTimers } = makeService({ muted: true });
  service.onUnreadObserve(2);
  service.onUnreadIncrease(2);
  fireTimers();
  assert.equal(log.toasts.length, 0);
});

test('fallback: two increases before the timer fires schedule one timer, not two', () => {
  const { service, log } = makeService();
  service.onUnreadObserve(1);
  service.onUnreadIncrease(1);
  service.onUnreadObserve(2);
  service.onUnreadIncrease(2);
  assert.equal(log.timers.length, 1);
});

// --- D2: markup stripping must not be quadratic on pathological input -------------------------

test('D2: a huge "<a<a<a..." payload (no closing ">") is handled in bounded time, title and body', () => {
  const evil = '<a'.repeat(150000);
  const t0 = process.hrtime.bigint();
  const r = sanitizeToastRequest({ title: `T${evil}`, body: evil });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 250, `took ${ms} ms`);
  assert.ok(r.title.length <= 200);
  assert.ok(r.body.length <= 1000);
});

test('D2: truncation happens before stripping, so a tag straddling the cap cannot leave markup behind', () => {
  const r = sanitizeToastRequest({ title: 't', body: `${'x'.repeat(1990)}<b>bold</b>` });
  assert.equal(r.body.includes('<'), false);
});

// --- D3: the unmatched-arrival list is pruned by age on every arrival --------------------------

test('D3: arrivals older than the match window are dropped as new ones are recorded (no unbounded growth)', () => {
  const { service, state } = makeService();
  for (let i = 0; i < 50; i += 1) {
    service.noteArrival();
    state.t += 1000;
  }
  assert.ok(service._pendingArrivals() <= 6, String(service._pendingArrivals()));
});
