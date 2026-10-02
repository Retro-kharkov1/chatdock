'use strict';

// UI-01 quit path (docs/architecture/meet-call-window.md section 8 rules 1-3; tray-lifecycle.md
// "Close-to-tray"). RED until src/main/quitGuard.js exists.
//
// API contract assumed (the doc describes the behaviour but names no module):
//
//   src/main/quitGuard.js
//   createQuitGuard({ timers: { setTimeout, clearTimeout }, resetMs = 5000 })
//     -> { isQuitting(): boolean, onBeforeQuit(event?), onWillQuit(), guardContents(webContents) }
//
//   - isQuitting() is false initially. onBeforeQuit sets it true and starts ONE one-shot timer (any
//     previous timer is cleared first). It NEVER calls event.preventDefault() and never shows anything.
//   - onWillQuit clears the timer (the quit really happened); isQuitting stays true.
//   - If the timer fires, the quit did not happen: isQuitting is reset to false.
//   - guardContents(webContents) registers a 'will-prevent-unload' listener ALWAYS (at call time, not
//     lazily). While isQuitting() is true the listener calls event.preventDefault() synchronously;
//     otherwise it leaves the event alone (a page's own protection stands).
//   index.js wires: guardContents(mainWindow.webContents); `before-quit` -> onBeforeQuit(event);
//   `will-quit` -> onWillQuit(); the main window's `close` handler reads isQuitting().

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createManualClock, FakeWebContents, makeEvent } = require('./helpers/electronFakes');
const { load } = require('./helpers/pending');

function setup(opts = {}) {
  const clock = createManualClock();
  const guard = load('quitGuard.js').createQuitGuard({ timers: clock, ...opts });
  return { clock, guard };
}

test('quitGuard: isQuitting is false until before-quit', () => {
  const { guard } = setup();
  assert.equal(guard.isQuitting(), false);
});

test('quitGuard: before-quit sets isQuitting and never prevents the event', () => {
  const { guard } = setup();
  const event = makeEvent();
  guard.onBeforeQuit(event);
  assert.equal(guard.isQuitting(), true);
  assert.equal(event.defaultPrevented, false);
});

test('quitGuard: onBeforeQuit tolerates being called without an event', () => {
  const { guard } = setup();
  assert.doesNotThrow(() => guard.onBeforeQuit());
  assert.equal(guard.isQuitting(), true);
});

test('quitGuard: a quit that really happens (will-quit) clears the reset timer and leaves isQuitting true', () => {
  const { guard, clock } = setup();
  guard.onBeforeQuit(makeEvent());
  assert.equal(clock.pending(), 1);
  guard.onWillQuit();
  assert.equal(clock.pending(), 0);
  clock.tick(60000);
  assert.equal(guard.isQuitting(), true);
});

test('quitGuard: a cancelled quit (no will-quit) resets isQuitting after the timer', () => {
  const { guard, clock } = setup();
  guard.onBeforeQuit(makeEvent());
  clock.tick(4999);
  assert.equal(guard.isQuitting(), true);
  clock.tick(1);
  assert.equal(guard.isQuitting(), false);
  assert.equal(clock.pending(), 0);
});

test('quitGuard: resetMs is injectable', () => {
  const { guard, clock } = setup({ resetMs: 1000 });
  guard.onBeforeQuit(makeEvent());
  clock.tick(1000);
  assert.equal(guard.isQuitting(), false);
});

test('quitGuard: a second before-quit restarts the timer (one timer only)', () => {
  const { guard, clock } = setup();
  guard.onBeforeQuit(makeEvent());
  clock.tick(3000);
  guard.onBeforeQuit(makeEvent());
  assert.equal(clock.pending(), 1);
  clock.tick(3000);
  assert.equal(guard.isQuitting(), true);
  clock.tick(2000);
  assert.equal(guard.isQuitting(), false);
});

test('quitGuard: after a reset, a later quit works again', () => {
  const { guard, clock } = setup();
  guard.onBeforeQuit(makeEvent());
  clock.tick(5000);
  guard.onBeforeQuit(makeEvent());
  assert.equal(guard.isQuitting(), true);
  guard.onWillQuit();
  assert.equal(guard.isQuitting(), true);
});

// --- will-prevent-unload on the main window's contents ---------------------------------------------

test('quitGuard.guardContents: the will-prevent-unload listener is registered immediately, before any quit', () => {
  const { guard } = setup();
  const contents = new FakeWebContents();
  guard.guardContents(contents);
  assert.equal(contents.listenerCount('will-prevent-unload'), 1);
});

test('quitGuard.guardContents: while quitting, an objecting page is overridden synchronously (quit completes)', () => {
  const { guard } = setup();
  const contents = new FakeWebContents();
  guard.guardContents(contents);
  guard.onBeforeQuit(makeEvent());
  const unload = contents.objectToUnload();
  assert.equal(unload.defaultPrevented, true);
});

test('quitGuard.guardContents: when not quitting, an objection is left alone', () => {
  const { guard } = setup();
  const contents = new FakeWebContents();
  guard.guardContents(contents);
  assert.equal(contents.objectToUnload().defaultPrevented, false);
});

test('quitGuard.guardContents: after a cancelled quit is reset, objections are left alone again', () => {
  const { guard, clock } = setup();
  const contents = new FakeWebContents();
  guard.guardContents(contents);
  guard.onBeforeQuit(makeEvent());
  clock.tick(5000);
  assert.equal(contents.objectToUnload().defaultPrevented, false);
});

test('quitGuard: quit with an objecting stub page - the override lets the quit through and will-quit clears the timer', () => {
  // The integration shape of the section 10 row: before-quit, the page objects during close, the
  // listener overrides, will-quit arrives. isQuitting is never reset because will-quit cleared the timer.
  const { guard, clock } = setup();
  const contents = new FakeWebContents();
  guard.guardContents(contents);
  guard.onBeforeQuit(makeEvent());
  const unload = contents.objectToUnload();
  guard.onWillQuit();
  clock.tick(60000);
  assert.equal(unload.defaultPrevented, true);
  assert.equal(guard.isQuitting(), true);
});

test('quitGuard: quit with an objecting page that is NOT overridden never reaches will-quit - isQuitting resets (the main window X hides again)', () => {
  // Simulates the cancelled quit: before-quit fired, the unload objection was not overridden (a window
  // whose contents were never guarded), so no will-quit. The timer must put isQuitting back to false.
  const { guard, clock } = setup();
  guard.onBeforeQuit(makeEvent());
  clock.tick(5000);
  assert.equal(guard.isQuitting(), false);
});
