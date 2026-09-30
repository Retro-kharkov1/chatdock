'use strict';

// src/main/unreadTracker.js - ONE shared unread baseline for the attention controller and the
// toast service (review F2). Raw title counts go in; only stable observations and real increases
// come out:
//   - the first non-zero count after a page load is the BASELINE (pre-existing unread), not an
//     arrival - including a late initial count on a slow first sign-in;
//   - a zero must persist (zeroHoldMs) before it counts, so a transient title without "(N)" is not
//     a read-everything followed by a spurious increase.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createUnreadTracker } = require('../src/main/unreadTracker.js');

function make() {
  const clock = { t: 1_000_000 };
  const timers = [];
  const log = { observed: [], increases: [] };
  const tracker = createUnreadTracker({
    now: () => clock.t,
    setTimer: (fn, ms) => {
      const timer = { fn, at: clock.t + ms, live: true };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.live = false;
    },
    onObserve: (n) => log.observed.push(n),
    onIncrease: (n) => log.increases.push(n),
    zeroHoldMs: 1000,
    quietBaselineMs: 20000,
    rampMs: 4000,
  });
  const advance = (ms) => {
    clock.t += ms;
    for (const timer of timers) {
      if (timer.live && timer.at <= clock.t) {
        timer.live = false;
        timer.fn();
      }
    }
  };
  return { tracker, log, advance };
}

test('the first non-zero count after load is the baseline: observed, never an increase', () => {
  const { tracker, log } = make();
  tracker.onRawCount(5);
  assert.deepEqual(log.increases, []);
  assert.deepEqual(log.observed, [5]);
});

test('a later rise above the baseline (after the ramp window) is an increase', () => {
  const { tracker, log, advance } = make();
  tracker.onRawCount(5);
  advance(5000);
  tracker.onRawCount(6);
  assert.deepEqual(log.increases, [6]);
});

test('late initial count (slow sign-in): zeros for a while, then N inside the quiet window is still the baseline', () => {
  const { tracker, log, advance } = make();
  tracker.onRawCount(0);
  advance(10000);
  tracker.onRawCount(7);
  assert.deepEqual(log.increases, []);
  assert.deepEqual(log.observed, [7]);
});

test('once the quiet window has passed with only zeros, 0 -> 1 is a real increase', () => {
  const { tracker, log, advance } = make();
  tracker.onRawCount(0);
  advance(25000);
  tracker.onRawCount(1);
  assert.deepEqual(log.increases, [1]);
});

test('transient zero: N -> 0 -> N inside the hold time is neither a stop nor an increase', () => {
  const { tracker, log, advance } = make();
  tracker.onRawCount(4);
  tracker.onRawCount(0);
  advance(500);
  tracker.onRawCount(4);
  advance(5000);
  assert.deepEqual(log.increases, []);
  assert.deepEqual(log.observed, [4]);
});

test('transient zero followed by a higher count is one increase and no zero observation', () => {
  const { tracker, log, advance } = make();
  tracker.onRawCount(4);
  advance(5000);
  tracker.onRawCount(0);
  advance(300);
  tracker.onRawCount(5);
  advance(5000);
  assert.deepEqual(log.increases, [5]);
  assert.equal(log.observed.includes(0), false);
});

test('a zero that persists is observed once the hold time passes; the next rise is an increase', () => {
  const { tracker, log, advance } = make();
  tracker.onRawCount(4);
  advance(5000);
  tracker.onRawCount(0);
  advance(999);
  assert.equal(log.observed.includes(0), false);
  advance(2);
  assert.deepEqual(log.observed, [4, 0]);
  tracker.onRawCount(2);
  assert.deepEqual(log.increases, [2]);
});

test('a decrease above zero is observed, not an increase; an unchanged count is neither', () => {
  const { tracker, log } = make();
  tracker.onRawCount(5);
  tracker.onRawCount(3);
  tracker.onRawCount(3);
  assert.deepEqual(log.increases, []);
  assert.deepEqual(log.observed, [5, 3]); // unchanged reports nothing
});

test('a page load resets the baseline (reload with unread is not an arrival)', () => {
  const { tracker, log, advance } = make();
  tracker.onRawCount(2);
  advance(60000);
  tracker.onPageLoaded(0);
  tracker.onRawCount(9);
  assert.deepEqual(log.increases, []);
});

test('a page load cancels a pending zero', () => {
  const { tracker, log, advance } = make();
  tracker.onRawCount(3);
  tracker.onRawCount(0);
  tracker.onPageLoaded(0);
  advance(5000);
  assert.equal(log.observed.includes(0), false);
});

test('bad input is treated as zero, never throws', () => {
  const { tracker } = make();
  for (const bad of [NaN, undefined, null, -3, 'x']) assert.doesNotThrow(() => tracker.onRawCount(bad));
});

// --- D1a: the title already carried "(N)" when did-finish-load fired -------------------------

test('D1a: onPageLoaded(N) with N > 0 seeds the baseline, so the next real rise is an increase, not the baseline', () => {
  const { tracker, log, advance } = make();
  tracker.onPageLoaded(5); // Chat set "(5)" BEFORE did-finish-load; no further title event will re-seed it
  assert.deepEqual(log.observed, [5]);
  advance(5000);
  tracker.onRawCount(6);
  assert.deepEqual(log.increases, [6]);
});

test('D1a: a repeat of the seeded count changes nothing', () => {
  const { tracker, log, advance } = make();
  tracker.onPageLoaded(5);
  advance(5000);
  tracker.onRawCount(5);
  assert.deepEqual(log.increases, []);
  assert.deepEqual(log.observed, [5]);
});

test('D1a: onPageLoaded(0) or no argument seeds nothing (the baseline waits for the first non-zero count)', () => {
  const { tracker, log } = make();
  tracker.onPageLoaded(0);
  tracker.onPageLoaded();
  assert.deepEqual(log.observed, []);
});

// --- D1b: Chat ramps the count while spaces load (1 -> 3 -> 5) -------------------------------

test('D1b: rises inside the ramp window after the baseline raise the baseline (observe), they are not increases', () => {
  const { tracker, log, advance } = make();
  tracker.onRawCount(1);
  advance(1000);
  tracker.onRawCount(3);
  advance(1000);
  tracker.onRawCount(5);
  assert.deepEqual(log.increases, []);
  assert.deepEqual(log.observed, [1, 3, 5]);
});

test('D1b: after the ramp window a rise above the ramped baseline is an increase', () => {
  const { tracker, log, advance } = make();
  tracker.onRawCount(1);
  advance(1000);
  tracker.onRawCount(5);
  advance(10000);
  tracker.onRawCount(6);
  assert.deepEqual(log.increases, [6]);
});

test('D1b: the ramp window also covers a baseline seeded from onPageLoaded(N)', () => {
  const { tracker, log, advance } = make();
  tracker.onPageLoaded(2);
  advance(1500);
  tracker.onRawCount(4);
  assert.deepEqual(log.increases, []);
  assert.deepEqual(log.observed, [2, 4]);
  advance(10000);
  tracker.onRawCount(5);
  assert.deepEqual(log.increases, [5]);
});

test('D1b: the ramp window starts at the baseline, not at page load (a slow start does not eat real increases)', () => {
  const { tracker, log, advance } = make();
  tracker.onRawCount(0);
  advance(10000);
  tracker.onRawCount(3); // baseline at t=10s
  advance(6000);
  tracker.onRawCount(4); // 6 s after the baseline: real
  assert.deepEqual(log.increases, [4]);
});
