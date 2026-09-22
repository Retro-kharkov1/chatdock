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

// --- setTrayUnread's blink gate (tray.js's createUnreadBlinkGate) ---------------------------
// docs/architecture/tray-lifecycle.md's "NFR-06 as a checkable property" section also names this
// coverage explicitly: setTrayUnread(1) while hidden starts blinking; setTrayUnread(0) while still
// hidden (trigger 2) stops blinking even though the window never became visible; setTrayUnread(0)
// when nothing was blinking is a no-op. Factored into `createUnreadBlinkGate` (tray.js) as a small,
// dependency-injected function per the plan's "Electron-API dependencies passed in" convention, so
// it is testable here without a running Electron process.
const { createUnreadBlinkGate } = require('../src/main/tray.js');

function makeGate({ visible = false, blinkOnUnread = true, muted = false } = {}) {
  let started = 0;
  let stopped = 0;
  const updateBlink = createUnreadBlinkGate({
    isWindowVisible: () => visible,
    getBlinkOnUnread: () => blinkOnUnread,
    getNotificationsMuted: () => muted,
    startBlinking: () => { started += 1; },
    stopBlinking: () => { stopped += 1; },
  });
  return { updateBlink, getStarted: () => started, getStopped: () => stopped };
}

test('setTrayUnread(1) while hidden, blink on, not muted -> starts blinking', () => {
  const gate = makeGate({ visible: false, blinkOnUnread: true, muted: false });
  gate.updateBlink(1);
  assert.equal(gate.getStarted(), 1);
  assert.equal(gate.getStopped(), 0);
});

test('setTrayUnread(0) while still hidden stops blinking even though the window never became visible (trigger 2)', () => {
  const gate = makeGate({ visible: false, blinkOnUnread: true, muted: false });
  gate.updateBlink(1);
  gate.updateBlink(0);
  assert.equal(gate.getStarted(), 1);
  assert.equal(gate.getStopped(), 1);
});

test('setTrayUnread(0) when nothing was blinking is a no-op that still safely calls stopBlinking (idempotent)', () => {
  const gate = makeGate({ visible: false, blinkOnUnread: true, muted: false });
  gate.updateBlink(0);
  assert.equal(gate.getStarted(), 0);
  assert.equal(gate.getStopped(), 1);
});

test('setTrayUnread(1) while the window is visible does not start blinking', () => {
  const gate = makeGate({ visible: true, blinkOnUnread: true, muted: false });
  gate.updateBlink(1);
  assert.equal(gate.getStarted(), 0);
});

test('setTrayUnread(1) while muted does not start blinking', () => {
  const gate = makeGate({ visible: false, blinkOnUnread: true, muted: true });
  gate.updateBlink(1);
  assert.equal(gate.getStarted(), 0);
});

test('setTrayUnread(1) while blinkOnUnread is off does not start blinking', () => {
  const gate = makeGate({ visible: false, blinkOnUnread: false, muted: false });
  gate.updateBlink(1);
  assert.equal(gate.getStarted(), 0);
});
