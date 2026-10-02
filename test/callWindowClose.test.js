'use strict';

// UI-01 call window close path: the close probe, will-prevent-unload, P1 (docs/architecture/
// meet-call-window.md section 8 rules 1-6 and the P1 row). RED until src/main/callWindow.js exists.
// Module API contract: see test/helpers/callWindowHarness.js. The fake window models Electron's close
// flow (electronFakes.js): 'close' event -> page beforeunload -> will-prevent-unload -> destroy only
// if a listener prevented the default (the override).
//
// Reading P1 in these tests: buttons ['Close window', 'Keep window open'], default AND Escape answer =
// Keep (index 1), parented to the call window, wording "Close the call window?".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/callWindowHarness');
const { settle } = require('./helpers/electronFakes');

const P1_TITLE = 'Close the call window?';
const CLOSE = 'Close window';
const KEEP = 'Keep window open';

// --- no live call: no dialog -----------------------------------------------------------------------

test('close: the page does not object -> window destroyed at once, no dialog, no timer left, no quit', async () => {
  const h = createHarness({ pageBehavior: 'none' });
  const win = h.open();
  win.close();
  await settle();
  assert.equal(win.destroyed, true);
  assert.equal(h.dialog.calls.length, 0);
  assert.equal(h.clock.pending(), 0);
  assert.equal(h.state.quitCalls, 0);
});

test('close: a page that never answers is treated as not live after the probe timeout (3 s) - destroyed, no dialog', async () => {
  const h = createHarness({ pageBehavior: 'hang' });
  const win = h.open();
  win.close();
  h.clock.tick(2999);
  await settle();
  assert.equal(win.destroyed, false, 'bounded quiet wait: not destroyed before the timeout');
  h.clock.tick(1);
  await settle();
  assert.equal(win.destroyed, true);
  assert.equal(h.dialog.calls.length, 0);
  assert.equal(h.clock.pending(), 0);
});

test('close: the probe timer is cleared when the window closes by any other route (no stray timer)', () => {
  const h = createHarness({ pageBehavior: 'hang' });
  const win = h.open();
  win.close();
  assert.equal(h.clock.pending(), 1);
  win.destroy();
  assert.equal(h.clock.pending(), 0);
});

// --- live call: P1 ---------------------------------------------------------------------------------

test('close: the page objects (live call) -> P1 is shown, parented to the call window; the window stays; the timer is cleared', async () => {
  const h = createHarness({ pageBehavior: 'objects' });
  const win = h.open();
  win.close();
  await settle();
  assert.equal(h.dialog.calls.length, 1);
  const p1 = h.dialog.calls[0];
  assert.equal(p1.parent, win);
  assert.match(h.dialog.textOf(p1), new RegExp(P1_TITLE.replace('?', '\\?')));
  assert.equal(win.destroyed, false);
  assert.equal(h.clock.pending(), 0);
});

test('P1: buttons are "Close window" / "Keep window open", default and Escape answer are Keep, and it carries an AbortSignal', async () => {
  const h = createHarness({ pageBehavior: 'objects' });
  h.open().close();
  await settle();
  const { options } = h.dialog.calls[0];
  assert.deepEqual(options.buttons, [CLOSE, KEEP]);
  assert.equal(options.defaultId, 1);
  assert.equal(options.cancelId, 1);
  assert.ok(options.signal && typeof options.signal.aborted === 'boolean');
});

test('P1 answer "Close window": the window is destroyed (devices released), the app does not quit', async () => {
  const h = createHarness({ pageBehavior: 'objects' });
  const win = h.open();
  win.close();
  await settle();
  h.dialog.answer(h.dialog.calls[0], CLOSE);
  await settle();
  assert.equal(win.destroyed, true);
  assert.equal(win.destroyCalls, 1);
  assert.equal(h.state.quitCalls, 0);
});

test('P1 answer "Keep window open": the window stays open and is focused', async () => {
  const h = createHarness({ pageBehavior: 'objects' });
  const win = h.open();
  win.close();
  await settle();
  const focusBefore = win.count('focus');
  h.dialog.answer(h.dialog.calls[0], KEEP);
  await settle();
  assert.equal(win.destroyed, false);
  assert.ok(win.count('focus') > focusBefore);
});

test('P1 Escape (the cancel response) is "Keep window open"', async () => {
  const h = createHarness({ pageBehavior: 'objects' });
  const win = h.open();
  win.close();
  await settle();
  const p1 = h.dialog.calls[0];
  p1.resolve(p1.options.cancelId);
  await settle();
  assert.equal(win.destroyed, false);
});

test('P1: after "Keep window open" a new close attempt shows a new P1 (the slot is free again)', async () => {
  const h = createHarness({ pageBehavior: 'objects' });
  const win = h.open();
  win.close();
  await settle();
  h.dialog.answer(h.dialog.calls[0], KEEP);
  await settle();
  win.close();
  await settle();
  assert.equal(h.dialog.calls.length, 2);
  assert.equal(h.openDialogs().length, 1);
});

test('P1: an answer that arrives after the window is gone is discarded (no throw, no second destroy)', async () => {
  const h = createHarness({ pageBehavior: 'objects' });
  const win = h.open();
  win.close();
  await settle();
  win.destroy();
  h.dialog.answer(h.dialog.calls[0], CLOSE);
  await settle();
  assert.equal(win.destroyCalls, 1);
});

// --- first objection only; page-initiated objections are not overridden ---------------------------------

test('probe: only the FIRST objection of an app-initiated close is consumed - a later objection is not overridden and shows nothing', async () => {
  const h = createHarness({ pageBehavior: 'objects' });
  const win = h.open();
  win.close();
  await settle();
  const later = win.webContents.objectToUnload();
  await settle();
  assert.equal(later.defaultPrevented, false);
  assert.equal(h.dialog.calls.length, 1);
});

test('page-initiated objection (a Meet-started reload, no close attempt): not overridden, no dialog (documented limitation)', async () => {
  const h = createHarness();
  const win = h.open();
  const event = win.webContents.objectToUnload();
  await settle();
  assert.equal(event.defaultPrevented, false);
  assert.equal(h.dialog.calls.length, 0);
  assert.equal(win.destroyed, false);
});

test('probe: a close attempt blocked by the open picker leaves no "app close" flag - a later page objection is not overridden', async () => {
  const h = createHarness({ pageBehavior: 'objects' });
  const win = h.open();
  h.picker.open = true;
  win.close();
  h.picker.open = false;
  const event = win.webContents.objectToUnload();
  await settle();
  assert.equal(event.defaultPrevented, false);
  assert.equal(h.dialog.calls.length, 0);
});

// --- yielding: quit, picker, open dialog -----------------------------------------------------------------

test('close while isQuitting: the handler yields - destroyed even with an objecting page, no dialog, no timer', async () => {
  const h = createHarness({ pageBehavior: 'objects', quitting: true });
  const win = h.open();
  win.close();
  await settle();
  assert.equal(win.destroyed, true);
  assert.equal(h.dialog.calls.length, 0);
  assert.equal(h.clock.pending(), 0);
});

test('will-prevent-unload while isQuitting: preventDefault synchronously (no dialog, no async step)', () => {
  const h = createHarness();
  const win = h.open();
  h.state.quitting = true;
  const event = win.webContents.objectToUnload();
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.dialog.calls.length, 0);
});

test('close with the picker open: blocked, the PICKER is raised, focused and flashed, never silent; the call window is not flashed', async () => {
  const h = createHarness({ pageBehavior: 'objects' });
  const win = h.open();
  h.picker.open = true;
  win.close();
  await settle();
  assert.equal(win.destroyed, false);
  assert.ok(h.picker.raised >= 1);
  assert.ok(h.picker.flashed >= 1);
  assert.equal(win.count('flashFrame'), 0);
  assert.equal(h.dialog.calls.length, 0);
  assert.equal(h.clock.pending(), 0);
});

test('close with the picker open: no probe is started (the page is never asked to unload)', async () => {
  const h = createHarness({ pageBehavior: 'hang' });
  const win = h.open();
  h.picker.open = true;
  win.close();
  h.clock.tick(10000);
  await settle();
  assert.equal(win.destroyed, false);
});

test('close with a dialog already open is ignored: no second dialog, the window stays', async () => {
  const h = createHarness({ pageBehavior: 'objects' });
  const win = h.open();
  win.close();
  await settle();
  win.close();
  await settle();
  assert.equal(h.dialog.calls.length, 1);
  assert.equal(win.destroyed, false);
  assert.equal(win.closeCalls, 2);
});
