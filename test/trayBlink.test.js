'use strict';

// docs/architecture/tray-lifecycle.md "NFR-06 as a checkable property, not an aspiration" — spy on
// global setInterval/clearInterval and drive exactly the sequences that section names: no
// duplicate setInterval on repeated starts, no duplicate clearInterval on repeated stops, and a
// start -> stop -> start sequence creating exactly two real timers total. Written before
// src/main/trayBlink.js exists (task 4e's own coverage-first net), per the plan's "the net is
// written first, then the implementation is built to satisfy it" rule.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const trayBlink = require('../src/main/trayBlink.js');

/**
 * withMockTimers(fn) — replaces global.setInterval/clearInterval with counting stubs for the
 * duration of `fn`, restores the real ones afterward, and resets trayBlink's own module state
 * (via its test-only `_resetForTests` hook) so one test's timer never leaks into the next.
 */
function withMockTimers(fn) {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  let setIntervalCalls = 0;
  let clearIntervalCalls = 0;
  let nextHandle = 1;
  const activeCallbacks = new Map();

  global.setInterval = (cb) => {
    setIntervalCalls += 1;
    const handle = nextHandle++;
    activeCallbacks.set(handle, cb);
    return handle;
  };
  global.clearInterval = (handle) => {
    clearIntervalCalls += 1;
    activeCallbacks.delete(handle);
  };

  try {
    fn({
      getSetIntervalCalls: () => setIntervalCalls,
      getClearIntervalCalls: () => clearIntervalCalls,
      fireTick: () => {
        for (const cb of activeCallbacks.values()) cb();
      },
    });
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    trayBlink._resetForTests();
  }
}

test('startBlinking creates exactly one setInterval; a second call while already blinking (a second arrival) is a no-op', () => {
  withMockTimers((mock) => {
    trayBlink.configure({ onTick: () => {}, onStop: () => {} });
    trayBlink.startBlinking();
    trayBlink.startBlinking();
    assert.equal(mock.getSetIntervalCalls(), 1);
    assert.equal(trayBlink.isBlinking(), true);
  });
});

test('stopBlinking clears the interval; a second call (e.g. two show/restore events in quick succession) is a no-op', () => {
  withMockTimers((mock) => {
    trayBlink.configure({ onTick: () => {}, onStop: () => {} });
    trayBlink.startBlinking();
    trayBlink.stopBlinking();
    trayBlink.stopBlinking();
    assert.equal(mock.getClearIntervalCalls(), 1);
    assert.equal(trayBlink.isBlinking(), false);
  });
});

test('start -> stop -> start creates exactly two real timers total, isBlinking reflects each step', () => {
  withMockTimers((mock) => {
    trayBlink.configure({ onTick: () => {}, onStop: () => {} });
    trayBlink.startBlinking();
    assert.equal(trayBlink.isBlinking(), true);
    trayBlink.stopBlinking();
    assert.equal(trayBlink.isBlinking(), false);
    trayBlink.startBlinking();
    assert.equal(trayBlink.isBlinking(), true);
    assert.equal(mock.getSetIntervalCalls(), 2);
    assert.equal(mock.getClearIntervalCalls(), 1);
  });
});

test('stopBlinking on an already-stopped timer does not call onStop (no orphaned restore)', () => {
  withMockTimers(() => {
    let stopCalls = 0;
    trayBlink.configure({ onTick: () => {}, onStop: () => { stopCalls += 1; } });
    trayBlink.stopBlinking();
    assert.equal(stopCalls, 0);
    trayBlink.startBlinking();
    trayBlink.stopBlinking();
    assert.equal(stopCalls, 1);
    trayBlink.stopBlinking();
    assert.equal(stopCalls, 1);
  });
});

test('each tick calls onTick and alternates the badge flag, cleared+nulled together on stop (never mid-cycle)', () => {
  withMockTimers((mock) => {
    const seen = [];
    trayBlink.configure({ onTick: (showBadge) => seen.push(showBadge), onStop: () => {} });
    trayBlink.startBlinking();
    mock.fireTick();
    mock.fireTick();
    mock.fireTick();
    assert.deepEqual(seen, [true, false, true]);
    trayBlink.stopBlinking();
    assert.equal(trayBlink.isBlinking(), false);
  });
});

// The setTrayUnread gate (createUnreadBlinkGate in tray.js) was replaced by the attention
// controller (src/main/attention.js, test/attention.test.js) when BUG-01 landed: "hidden -> starts",
// "unread 0 -> stops", "muted -> no start" and "blinking off -> no start" are covered there, and
// "visible does not start" is deliberately gone (FR-14: only focus matters).
