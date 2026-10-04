'use strict';

// UI-04 app window close path (docs/architecture/google-app-windows.md section 4 "will-prevent-unload",
// section 8 "Quit", coverage-map rows "will-prevent-unload" and "Quit with windows"; same close probe as
// test/callWindowClose.test.js, minus picker / P2 / Exit interplay). RED until src/main/googleAppWindow.js
// exists. Module API contract: see test/helpers/googleAppWindowHarness.js. The fake window models Electron's
// close flow (electronFakes.js): 'close' -> page beforeunload -> will-prevent-unload -> destroy only if a
// listener prevented the default (the override).
//
// Dialog read as: title "Close this window?", message "This page has changes that may not be saved.",
// buttons ['Close window', 'Keep window open'], default AND Escape answer = Keep (index 1), parented to the
// window. At most ONE dialog per window. The factory has NO quit path and no Exit interplay: tray Exit
// never asks about an app window, it only flips isQuitting.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGoogleHarness } = require('./helpers/googleAppWindowHarness');
const { settle } = require('./helpers/electronFakes');

const DOC = 'https://docs.google.com/document/d/1/edit';
const DRIVE = 'https://drive.google.com/file/d/1/view';
const TITLE = 'Close this window?';
const MESSAGE = 'This page has changes that may not be saved.';
const CLOSE = 'Close window';
const KEEP = 'Keep window open';

// --- no objection: no dialog -------------------------------------------------------------------------------------------

test('close: the page does not object -> destroyed at once, no dialog, no timer left', async () => {
  const h = createGoogleHarness({ pageBehavior: 'none' });
  const win = h.open(DOC);
  win.close();
  await settle();
  assert.equal(win.destroyed, true);
  assert.equal(h.dialog.calls.length, 0);
  assert.equal(h.clock.pending(), 0);
});

test('close: a page that never answers is treated as not unsaved after the 3 s probe - destroyed, no dialog', async () => {
  const h = createGoogleHarness({ pageBehavior: 'hang' });
  const win = h.open(DOC);
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

test('close: the probe timer is cleared when the window goes away by another route', () => {
  const h = createGoogleHarness({ pageBehavior: 'hang' });
  const win = h.open(DOC);
  win.close();
  assert.equal(h.clock.pending(), 1);
  win.destroy();
  assert.equal(h.clock.pending(), 0);
});

// --- objection: the confirm ----------------------------------------------------------------------------------------------

test('close: the page objects -> the confirm is shown, parented to the window; the window stays; the timer is cleared', async () => {
  const h = createGoogleHarness({ pageBehavior: 'objects' });
  const win = h.open(DOC);
  win.close();
  await settle();
  assert.equal(h.dialog.calls.length, 1);
  const call = h.dialog.calls[0];
  assert.equal(call.parent, win);
  assert.match(h.dialog.textOf(call), new RegExp(TITLE.replace('?', '\\?')));
  assert.match(h.dialog.textOf(call), new RegExp(MESSAGE.replace('.', '\\.')));
  assert.equal(win.destroyed, false);
  assert.equal(h.clock.pending(), 0);
});

test('confirm: buttons are "Close window" / "Keep window open"; default and Escape answer are Keep', async () => {
  const h = createGoogleHarness({ pageBehavior: 'objects' });
  h.open(DOC).close();
  await settle();
  const { options } = h.dialog.calls[0];
  assert.deepEqual(options.buttons, [CLOSE, KEEP]);
  assert.equal(options.defaultId, 1);
  assert.equal(options.cancelId, 1);
});

test('confirm answer "Close window": the window is destroyed and nothing else is touched (no quit path)', async () => {
  const h = createGoogleHarness({ pageBehavior: 'objects' });
  const win = h.open(DOC);
  const other = h.open(DRIVE);
  win.close();
  await settle();
  h.dialog.answer(h.dialog.calls[0], CLOSE);
  await settle();
  assert.equal(win.destroyed, true);
  assert.equal(win.destroyCalls, 1);
  assert.equal(other.destroyed, false);
});

test('confirm answer "Keep window open": the window stays open and is focused', async () => {
  const h = createGoogleHarness({ pageBehavior: 'objects' });
  const win = h.open(DOC);
  win.close();
  await settle();
  const focusBefore = win.count('focus');
  h.dialog.answer(h.dialog.calls[0], KEEP);
  await settle();
  assert.equal(win.destroyed, false);
  assert.ok(win.count('focus') > focusBefore);
});

test('confirm Escape (the cancel response) is "Keep window open"', async () => {
  const h = createGoogleHarness({ pageBehavior: 'objects' });
  const win = h.open(DOC);
  win.close();
  await settle();
  const call = h.dialog.calls[0];
  call.resolve(call.options.cancelId);
  await settle();
  assert.equal(win.destroyed, false);
});

test('confirm: after "Keep" a new close attempt shows a new confirm (the slot is free again)', async () => {
  const h = createGoogleHarness({ pageBehavior: 'objects' });
  const win = h.open(DOC);
  win.close();
  await settle();
  h.dialog.answer(h.dialog.calls[0], KEEP);
  await settle();
  win.close();
  await settle();
  assert.equal(h.dialog.calls.length, 2);
  assert.equal(h.openDialogs().length, 1);
});

test('confirm: an answer that arrives after the window is gone is discarded (no throw, no second destroy)', async () => {
  const h = createGoogleHarness({ pageBehavior: 'objects' });
  const win = h.open(DOC);
  win.close();
  await settle();
  win.destroy();
  h.dialog.answer(h.dialog.calls[0], CLOSE);
  await settle();
  assert.equal(win.destroyCalls, 1);
});

test('confirm: at most ONE dialog per window - a second close attempt while it is open shows nothing and the window stays', async () => {
  const h = createGoogleHarness({ pageBehavior: 'objects' });
  const win = h.open(DOC);
  win.close();
  await settle();
  win.close();
  await settle();
  assert.equal(h.dialog.calls.length, 1);
  assert.equal(win.destroyed, false);
});

test('confirm: two windows each get their own confirm (the limit is per window)', async () => {
  const h = createGoogleHarness({ pageBehavior: 'objects' });
  const a = h.open(DOC);
  const b = h.open(DRIVE);
  a.close();
  b.close();
  await settle();
  assert.equal(h.dialog.calls.length, 2);
  assert.deepEqual(h.dialog.calls.map((c) => c.parent), [a, b]);
});

// --- first objection only; page-initiated objections are not overridden ---------------------------------------------------

test('probe: only the FIRST objection of an app-initiated close is consumed - a later one is not overridden and shows nothing', async () => {
  const h = createGoogleHarness({ pageBehavior: 'objects' });
  const win = h.open(DOC);
  win.close();
  await settle();
  const later = win.webContents.objectToUnload();
  await settle();
  assert.equal(later.defaultPrevented, false);
  assert.equal(h.dialog.calls.length, 1);
});

test('page-initiated objection (a reload or navigation, no close attempt): not overridden, no dialog', async () => {
  const h = createGoogleHarness();
  const win = h.open(DOC);
  const event = win.webContents.objectToUnload();
  await settle();
  assert.equal(event.defaultPrevented, false);
  assert.equal(h.dialog.calls.length, 0);
  assert.equal(win.destroyed, false);
});

test('the app-close flag is per window - an objection in window B is not consumed by a close probe running in window A', async () => {
  const h = createGoogleHarness({ pageBehavior: 'hang' });
  const a = h.open(DOC);
  const b = h.open(DRIVE);
  a.close();
  const event = b.webContents.objectToUnload();
  await settle();
  assert.equal(event.defaultPrevented, false);
  assert.equal(h.dialog.calls.length, 0);
});

// --- quit: never held up, never asks ---------------------------------------------------------------------------------------------

test('close while isQuitting: destroyed even with an objecting page, no dialog, no timer', async () => {
  const h = createGoogleHarness({ pageBehavior: 'objects', quitting: true });
  const win = h.open(DOC);
  win.close();
  await settle();
  assert.equal(win.destroyed, true);
  assert.equal(h.dialog.calls.length, 0);
  assert.equal(h.clock.pending(), 0);
});

test('will-prevent-unload while isQuitting: preventDefault synchronously (no dialog, no async step)', () => {
  const h = createGoogleHarness();
  const win = h.open(DOC);
  h.state.quitting = true;
  const event = win.webContents.objectToUnload();
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.dialog.calls.length, 0);
});

test('quit with several windows open: every window completes its close (no objection holds the quit)', async () => {
  const h = createGoogleHarness({ pageBehavior: 'objects' });
  const wins = [h.open(DOC), h.open(DRIVE), h.open('https://calendar.google.com/x')];
  h.state.quitting = true;
  for (const w of wins) w.close();
  await settle();
  assert.deepEqual(wins.map((w) => w.destroyed), [true, true, true]);
  assert.equal(h.dialog.calls.length, 0);
});

test('quit while a confirm is open: the objection is overridden synchronously for the next unload, no second dialog', async () => {
  const h = createGoogleHarness({ pageBehavior: 'objects' });
  const win = h.open(DOC);
  win.close();
  await settle();
  h.state.quitting = true;
  win.close();
  await settle();
  assert.equal(win.destroyed, true);
  assert.equal(h.dialog.calls.length, 1);
});

test('tray Exit never asks about an app window: the manager exposes no exit request', () => {
  const h = createGoogleHarness();
  assert.equal(typeof h.manager.requestExit, 'undefined');
});

// --- crash --------------------------------------------------------------------------------------------------------------------------

test('renderer crash: no dialog is shown and the window is left for the user to close', async () => {
  const h = createGoogleHarness();
  const win = h.open(DOC);
  win.webContents.crash();
  await settle();
  assert.equal(h.dialog.calls.length, 0);
  assert.equal(win.destroyed, false);
});

// --- close never quits / never hides -------------------------------------------------------------------------------------------------

test('close: never hides the window, even when the user keeps it open', async () => {
  const h = createGoogleHarness({ pageBehavior: 'objects' });
  const win = h.open(DOC);
  win.close();
  await settle();
  h.dialog.answer(h.dialog.calls[0], KEEP);
  await settle();
  assert.equal(win.count('hide'), 0);
});
