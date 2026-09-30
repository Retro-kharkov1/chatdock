'use strict';

// BUG-01 net, attention indicators (FR-14 tray blink + taskbar flash, FR-15 one setting for both,
// FR-12 mute) - bugs C (flashFrame never called) and D (blink gated on isVisible(), evaluated only
// on title change).
//
//   Section 1  the static unread indicator that FR-05a keeps independent of focus and mute
//              (the [CHAR BUG-01-C/D] tests pinned the old gate and were retired with it).
//   Section 2  the attention state machine (src/main/attention.js).
//
// Contract proposed for the implementer (argue with it if it does not fit, then change the tests
// deliberately):
//
//   src/main/attention.js
//   createAttentionController({
//     isWindowFocused,        // () => boolean   OS input focus of the MAIN Chat window
//     getBlinkOnUnread,       // () => boolean   FR-15 "Icon blinking" (governs tray blink AND flash)
//     getNotificationsMuted,  // () => boolean   FR-12 (working assumption: also silences the flash)
//     startBlinking,          // () => void      tray blink start (trayBlink.startBlinking; idempotent)
//     stopBlinking,           // () => void      tray blink stop  (trayBlink.stopBlinking;  idempotent)
//     flashFrame,             // (flag: boolean) taskbar flash request (BrowserWindow.flashFrame)
//   }) -> {
//     onArrival(),            // a new message arrived (preferred trigger, FR-14)
//     onUnreadCount(n),       // global unread count observed (title change). n === 0 -> stop.
//                             //   An INCREASE is the FR-14 "acceptable degraded trigger" = arrival.
//     onFocus(),              // main window gained OS input focus -> stop both
//     onSettingsChanged(),    // blinkOnUnread / notificationsMuted changed -> stop if now disallowed
//     stop(),                 // unconditional stop of both (usable as settingsStore's stop hook)
//   }
//   Show/restore/hide/minimize are NOT inputs: only focus matters (FR-14 reverses the old
//   "becomes visible stops it" rule). Wiring in index.js must therefore not call stopBlinking on
//   the window 'show'/'restore' events any more (manual/E2E checklist item, not unit-testable while
//   bootstrap() is unexported).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pending, load } = require('./helpers/pending');
const { resolveIconState, setUnreadOverlay } = require('../src/main/tray.js');
const trayBlink = require('../src/main/trayBlink.js');

// NOTE: the overlay-set branch (unread > 0) calls Electron nativeImage and needs a real Electron
// process; it is on the manual checklist, not faked here.

// --- Section 1: characterization (GREEN) ------------------------------------------------------

test('static unread indicator (FR-05a): any unread count > 0 resolves to the unread glyph, independent of window state', () => {
  assert.equal(resolveIconState(1, false), 'unread');
  assert.equal(resolveIconState(7, false), 'unread');
});

test('static unread indicator (FR-05a): zero unread resolves to the normal glyph', () => {
  assert.equal(resolveIconState(0, false), 'normal');
});

test('FR-05a/FR-12: the static unread indicator stays visible while muted (unread wins over the mute glyph)', () => {
  assert.equal(resolveIconState(5, true), 'unread');
});

test('FR-12: muted with nothing unread shows the mute glyph', () => {
  assert.equal(resolveIconState(0, true), 'muted');
});

function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

function fakeWindow({ destroyed = false } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => destroyed,
    setOverlayIcon: (icon, description) => calls.push({ icon, description }),
  };
}

test('taskbar overlay (win32): unread 0 clears the overlay', () => {
  withPlatform('win32', () => {
    const win = fakeWindow();
    setUnreadOverlay(win, 0);
    assert.deepEqual(win.calls, [{ icon: null, description: '' }]);
  });
});

test('taskbar overlay (win32): a destroyed window is left alone', () => {
  withPlatform('win32', () => {
    const win = fakeWindow({ destroyed: true });
    setUnreadOverlay(win, 2);
    assert.equal(win.calls.length, 0);
  });
});

test('taskbar overlay (linux): no-op', () => {
  withPlatform('linux', () => {
    const win = fakeWindow();
    setUnreadOverlay(win, 2);
    assert.equal(win.calls.length, 0);
  });
});

// --- Section 2: RED - the attention controller ------------------------------------------------

/**
 * Builds a controller with recorded side effects. `state` is mutable so tests change focus /
 * settings between events (dependencies must be read at event time, not captured at construction).
 */
function makeController(initial = {}) {
  const state = { focused: false, blinkOnUnread: true, muted: false, ...initial };
  const log = { starts: 0, stops: 0, flash: [] };
  const controller = load('attention.js').createAttentionController({
    isWindowFocused: () => state.focused,
    getBlinkOnUnread: () => state.blinkOnUnread,
    getNotificationsMuted: () => state.muted,
    startBlinking: () => { log.starts += 1; },
    stopBlinking: () => { log.stops += 1; },
    flashFrame: (flag) => log.flash.push(flag),
  });
  return { controller, state, log };
}

const lastFlash = (log) => log.flash[log.flash.length - 1];
const NOT_FOCUSED_STATES = [
  ['hidden to tray', false],
  ['minimized', false],
  ['visible but another application has OS focus', false],
];

// Start conditions ---------------------------------------------------------------------------

for (const [label, focused] of NOT_FOCUSED_STATES) {
  pending(`FR-14: an arrival while the window is ${label} starts the tray blink and the taskbar flash`, () => {
    const { controller, log } = makeController({ focused });
    controller.onArrival();
    assert.equal(log.starts, 1);
    assert.equal(lastFlash(log), true);
  });
}

pending('FR-14: an arrival while the window is focused starts nothing', () => {
  const { controller, log } = makeController({ focused: true });
  controller.onArrival();
  assert.equal(log.starts, 0);
  assert.deepEqual(log.flash, []);
});

pending('FR-14/FR-12: while muted an arrival does not blink and does not flash', () => {
  const { controller, log } = makeController({ muted: true });
  controller.onArrival();
  assert.equal(log.starts, 0);
  assert.deepEqual(log.flash, []);
});

pending('FR-14/FR-15: with Icon blinking off an arrival neither blinks nor flashes (one setting governs both)', () => {
  const { controller, log } = makeController({ blinkOnUnread: false });
  controller.onArrival();
  assert.equal(log.starts, 0);
  assert.deepEqual(log.flash, []);
});

pending('FR-14: settings are read at event time (mute turned off later allows the next arrival)', () => {
  const { controller, state, log } = makeController({ muted: true });
  controller.onArrival();
  state.muted = false;
  controller.onArrival();
  assert.equal(log.starts, 1);
  assert.equal(lastFlash(log), true);
});

// Stop conditions ----------------------------------------------------------------------------

pending('FR-14 stop 1: gaining focus stops the blink and the flash', () => {
  const { controller, state, log } = makeController();
  controller.onArrival();
  state.focused = true;
  controller.onFocus();
  assert.equal(log.stops, 1);
  assert.equal(lastFlash(log), false);
});

pending('FR-14 stop 1: focus stops the indicators even while unread remains (count still > 0)', () => {
  const { controller, state, log } = makeController();
  controller.onUnreadCount(3);
  state.focused = true;
  controller.onFocus();
  assert.equal(lastFlash(log), false);
  assert.equal(log.stops >= 1, true);
});

pending('FR-14: after a focus stop nothing restarts by itself (no delayed restart, no restart on the next focus)', () => {
  const { controller, state, log } = makeController();
  controller.onArrival();
  state.focused = true;
  controller.onFocus();
  const startsAfterStop = log.starts;
  const flashAfterStop = log.flash.length;
  controller.onFocus();
  assert.equal(log.starts, startsAfterStop);
  assert.equal(log.flash.length, flashAfterStop);
});

pending('FR-14 stop 2: unread count returning to 0 stops both while the window is still NOT focused', () => {
  const { controller, log } = makeController({ focused: false });
  controller.onArrival();
  controller.onUnreadCount(0);
  assert.equal(log.stops >= 1, true);
  assert.equal(lastFlash(log), false);
});

pending('FR-14: an unread count that drops but stays above 0 does not stop the indicators', () => {
  const { controller, log } = makeController({ focused: false });
  controller.onUnreadCount(5);
  const stopsBefore = log.stops;
  controller.onUnreadCount(2);
  assert.equal(log.stops, stopsBefore);
  assert.equal(lastFlash(log), true);
});

pending('FR-14 stop 3: turning mute on while active stops both immediately', () => {
  const { controller, state, log } = makeController();
  controller.onArrival();
  state.muted = true;
  controller.onSettingsChanged();
  assert.equal(log.stops >= 1, true);
  assert.equal(lastFlash(log), false);
});

pending('FR-14 stop 3 / FR-15: turning Icon blinking off while active stops both immediately', () => {
  const { controller, state, log } = makeController();
  controller.onArrival();
  state.blinkOnUnread = false;
  controller.onSettingsChanged();
  assert.equal(log.stops >= 1, true);
  assert.equal(lastFlash(log), false);
});

pending('FR-14 (working assumption): turning mute OFF with unread pending does not start the indicators retroactively', () => {
  const { controller, state, log } = makeController({ muted: true });
  controller.onUnreadCount(3);
  state.muted = false;
  controller.onSettingsChanged();
  assert.equal(log.starts, 0);
  assert.deepEqual(log.flash, []);
});

pending('FR-14 (working assumption): the next arrival after mute is turned off starts both', () => {
  const { controller, state, log } = makeController({ muted: true });
  controller.onUnreadCount(3);
  state.muted = false;
  controller.onSettingsChanged();
  controller.onArrival();
  assert.equal(log.starts, 1);
  assert.equal(lastFlash(log), true);
});

pending('stop() unconditionally stops both and is safe to call when nothing is active', () => {
  const { controller, log } = makeController();
  assert.doesNotThrow(() => controller.stop());
  controller.onArrival();
  controller.stop();
  assert.equal(lastFlash(log), false);
});

// Resume, no stacking --------------------------------------------------------------------------

pending('FR-14: a new arrival after a focus stop, focus lost again, unread still > 0, resumes both', () => {
  const { controller, state, log } = makeController();
  controller.onArrival();
  state.focused = true;
  controller.onFocus();
  state.focused = false;
  controller.onArrival();
  assert.equal(log.starts, 2);
  assert.equal(lastFlash(log), true);
});

pending('FR-14: a second arrival while already active never requests a flash-off in between (no flicker)', () => {
  const { controller, log } = makeController();
  controller.onArrival();
  controller.onArrival();
  assert.equal(log.flash.includes(false), false);
});

pending('NFR-06: with the REAL trayBlink, two arrivals create exactly one interval; stop clears it', () => {
  const originalSet = global.setInterval;
  const originalClear = global.clearInterval;
  let sets = 0;
  let clears = 0;
  global.setInterval = () => { sets += 1; return sets; };
  global.clearInterval = () => { clears += 1; };
  try {
    trayBlink.configure({ onTick: () => {}, onStop: () => {} });
    const controller = load('attention.js').createAttentionController({
      isWindowFocused: () => false,
      getBlinkOnUnread: () => true,
      getNotificationsMuted: () => false,
      startBlinking: () => trayBlink.startBlinking(),
      stopBlinking: () => trayBlink.stopBlinking(),
      flashFrame: () => {},
    });
    controller.onArrival();
    controller.onArrival();
    assert.equal(sets, 1);
    controller.onFocus();
    assert.equal(clears, 1);
    assert.equal(trayBlink.isBlinking(), false);
  } finally {
    global.setInterval = originalSet;
    global.clearInterval = originalClear;
    trayBlink._resetForTests();
  }
});

// Degraded trigger (FR-14: "global unread count INCREASES while not focused") -----------------

pending('degraded trigger: count 0 -> 2 while not focused starts both', () => {
  const { controller, log } = makeController();
  controller.onUnreadCount(0);
  controller.onUnreadCount(2);
  assert.equal(log.starts, 1);
  assert.equal(lastFlash(log), true);
});

pending('degraded trigger: an increase above an already-positive count restarts both after a focus stop', () => {
  const { controller, state, log } = makeController();
  controller.onUnreadCount(2);
  state.focused = true;
  controller.onFocus();
  state.focused = false;
  controller.onUnreadCount(3);
  assert.equal(log.starts, 2);
});

pending('degraded trigger: an unchanged count (same title re-reported) does not start anything', () => {
  const { controller, log } = makeController();
  controller.onUnreadCount(2);
  const startsAfterFirst = log.starts;
  controller.onUnreadCount(2);
  assert.equal(log.starts, startsAfterFirst);
});

pending('degraded trigger: an increase while the window is focused starts nothing', () => {
  const { controller, log } = makeController({ focused: true });
  controller.onUnreadCount(4);
  assert.equal(log.starts, 0);
  assert.deepEqual(log.flash, []);
});

// --- F2: observeUnreadCount - baseline/decrease/zero observations that never START anything -----
// (index.js feeds real increases through onUnreadCount and everything else through this, so the
// baseline shared with the toast service - unreadTracker.js - decides what counts as an arrival.)

pending('F2: observeUnreadCount never starts the indicators, even for 0 -> N (the launch/reload baseline)', () => {
  const { controller, log } = makeController();
  controller.observeUnreadCount(5);
  assert.equal(log.starts, 0);
  assert.deepEqual(log.flash, []);
});

pending('F2: after an observed baseline, a genuine increase starts both', () => {
  const { controller, log } = makeController();
  controller.observeUnreadCount(5);
  controller.onUnreadCount(6);
  assert.equal(log.starts, 1);
  assert.equal(lastFlash(log), true);
});

pending('F2: an observed decrease keeps the tracked count in sync, so the next rise above it is an increase', () => {
  const { controller, log } = makeController();
  controller.observeUnreadCount(5);
  controller.observeUnreadCount(2);
  controller.onUnreadCount(3);
  assert.equal(log.starts, 1);
});

pending('F2: an observed zero stops an active indicator (FR-14 stop 2)', () => {
  const { controller, log } = makeController();
  controller.onArrival();
  controller.observeUnreadCount(0);
  assert.equal(log.stops >= 1, true);
  assert.equal(lastFlash(log), false);
});
