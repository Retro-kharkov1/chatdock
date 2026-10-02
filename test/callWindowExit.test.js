'use strict';

// UI-01 tray Exit, the dialog slot (P1 / P2 / crash) and the renderer-crash dialog
// (docs/architecture/meet-call-window.md sections 8 "Exit is never swallowed" and 9).
// RED until src/main/callWindow.js exists. Module API contract: test/helpers/callWindowHarness.js.
//
// Extra assumptions made here (the doc leaves them open):
//  * requestExit() may return a Promise or nothing: the tests never await it (its settling could depend
//    on injected timers); they drive the manual clock and `settle()` instead.
//  * Aborting an open box: the manager calls AbortController.abort() on the controller whose signal it
//    passed to showMessageBox. The fake resolves an aborted box with its cancelId (as Electron does).
//    "Does the box ignore the signal?" is concluded when the box has NOT settled `dismissWaitMs`
//    (500 ms) after abort(); the fallback of section 8 then applies.
//  * P2 is parented to the call window (architecture section 8); design 06 says "not parented" - the
//    architecture document wins and the disagreement is reported.
//  * Crash dialog: wording "The call window stopped working"; buttons "Reload" first, a Close button
//    second (architecture says "Close", requirements/design 06 say "Close window": only the position
//    and /close/i are asserted); Escape (cancelId) is the Close button.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/callWindowHarness');
const { settle } = require('./helpers/electronFakes');

const P2_TITLE = 'Exit Google Chat Desktop?';
const CRASH_TITLE = 'The call window stopped working';
const CLOSE = 'Close window';
const KEEP = 'Keep window open';
const EXIT = 'Exit';
const CANCEL = 'Cancel';

const wording = (h, call) => h.dialog.textOf(call);

// --- Exit without a live call ----------------------------------------------------------------------

test('Exit with no call window: app.quit() as today, no dialog', async () => {
  const h = createHarness();
  h.manager.requestExit();
  assert.equal(h.state.quitCalls, 1);
  assert.equal(h.dialog.calls.length, 0);
});

test('Exit with a call window whose page does not object: the window is destroyed, then the app quits, no dialog', async () => {
  const h = createHarness({ pageBehavior: 'none' });
  const win = h.open();
  h.manager.requestExit();
  await settle();
  assert.equal(win.destroyed, true);
  assert.equal(h.state.quitCalls, 1);
  assert.deepEqual(h.state.destroyedAtQuit, [true]);
  assert.equal(h.dialog.calls.length, 0);
});

test('Exit with a hung page: treated as not live after the probe timeout - destroyed, then quit, no dialog', async () => {
  const h = createHarness({ pageBehavior: 'hang' });
  const win = h.open();
  h.manager.requestExit();
  await settle();
  assert.equal(h.state.quitCalls, 0, 'bounded wait: not yet');
  h.clock.tick(3000);
  await settle();
  assert.equal(win.destroyed, true);
  assert.equal(h.state.quitCalls, 1);
  assert.equal(h.dialog.calls.length, 0);
  assert.equal(h.clock.pending(), 0);
});

test('Exit with the source picker open: the picker request is torn down first, then the normal Exit rules apply', async () => {
  const h = createHarness({ pageBehavior: 'none' });
  const win = h.open();
  h.picker.open = true;
  h.manager.requestExit();
  await settle();
  assert.ok(h.state.abortPickerCalls >= 1);
  assert.equal(win.destroyed, true);
  assert.equal(h.state.quitCalls, 1);
});

// --- Exit with a live call: P2 ------------------------------------------------------------------------

test('Exit with a live call: P2 "Exit Google Chat Desktop?" is shown (not P1), the app does not quit yet', async () => {
  const h = createHarness({ pageBehavior: 'objects' });
  const win = h.open();
  h.manager.requestExit();
  await settle();
  assert.equal(h.dialog.calls.length, 1);
  const p2 = h.dialog.calls[0];
  assert.equal(p2.parent, win);
  assert.match(wording(h, p2), /Exit Google Chat Desktop\?/);
  assert.deepEqual(p2.options.buttons, [EXIT, CANCEL]);
  assert.equal(p2.options.defaultId, 1);
  assert.equal(p2.options.cancelId, 1);
  assert.ok(p2.options.signal);
  assert.equal(h.state.quitCalls, 0);
  assert.equal(win.destroyed, false);
  assert.equal(h.clock.pending(), 0);
});

test('P2 answer "Exit": app.quit() runs', async () => {
  const h = createHarness({ pageBehavior: 'objects' });
  h.open();
  h.manager.requestExit();
  await settle();
  h.dialog.answer(h.dialog.calls[0], EXIT);
  await settle();
  assert.equal(h.state.quitCalls, 1);
});

test('P2 answer "Cancel" and Escape: nothing happens, the window stays', async () => {
  const h = createHarness({ pageBehavior: 'objects' });
  const win = h.open();
  h.manager.requestExit();
  await settle();
  h.dialog.answer(h.dialog.calls[0], CANCEL);
  await settle();
  h.manager.requestExit();
  await settle();
  const second = h.dialog.calls[1];
  second.resolve(second.options.cancelId);
  await settle();
  assert.equal(h.state.quitCalls, 0);
  assert.equal(win.destroyed, false);
});

test('after P2 is cancelled, Exit can be requested again and shows P2 again (the slot is free)', async () => {
  const h = createHarness({ pageBehavior: 'objects' });
  h.open();
  h.manager.requestExit();
  await settle();
  h.dialog.answer(h.dialog.calls[0], CANCEL);
  await settle();
  h.manager.requestExit();
  await settle();
  assert.equal(h.dialog.calls.length, 2);
  assert.equal(h.openDialogs().length, 1);
});

test('P2 answer arriving after the window is gone is discarded without throwing', async () => {
  const h = createHarness({ pageBehavior: 'objects' });
  const win = h.open();
  h.manager.requestExit();
  await settle();
  win.destroy();
  assert.doesNotThrow(() => h.dialog.answer(h.dialog.calls[0], CANCEL));
  await settle();
  assert.equal(h.state.quitCalls, 0);
});

// --- Exit while a dialog is open (signal honoured) -----------------------------------------------------------

test('Exit while P1 is open: P1 is dismissed (as Keep) and P2 is shown - no second probe, no quit yet', async () => {
  const h = createHarness({ pageBehavior: 'objects' });
  const win = h.open();
  win.close();
  await settle();
  const p1 = h.dialog.calls[0];
  const closeCallsBefore = win.closeCalls;
  h.manager.requestExit();
  await settle();
  assert.equal(h.dialog.aborted(p1), true);
  assert.equal(h.dialog.calls.length, 2);
  assert.deepEqual(h.dialog.calls[1].options.buttons, [EXIT, CANCEL]);
  assert.equal(win.closeCalls, closeCallsBefore, 'a live call is already known: no second probe');
  assert.equal(win.destroyed, false);
  assert.equal(h.state.quitCalls, 0);
});

test('Exit while P1 is open, then P2 "Exit": the app quits', async () => {
  const h = createHarness({ pageBehavior: 'objects' });
  const win = h.open();
  win.close();
  await settle();
  h.manager.requestExit();
  await settle();
  h.dialog.answer(h.dialog.calls[1], EXIT);
  await settle();
  assert.equal(h.state.quitCalls, 1);
});

test('stale answer: the aborted P1 resolving as "keep" does not free the slot that P2 now holds', async () => {
  const h = createHarness({ pageBehavior: 'objects' });
  const win = h.open();
  win.close();
  await settle();
  h.manager.requestExit();
  await settle();
  win.close();
  await settle();
  assert.equal(h.dialog.calls.length, 2, 'a close attempt while P2 is open is ignored');
});

test('Exit while P2 is already open: the call window is raised and focused, no second dialog opens', async () => {
  const h = createHarness({ pageBehavior: 'objects' });
  const win = h.open();
  h.manager.requestExit();
  await settle();
  const focusBefore = win.count('focus');
  h.manager.requestExit();
  await settle();
  assert.equal(h.dialog.calls.length, 1);
  assert.ok(win.count('focus') > focusBefore);
  assert.equal(h.state.quitCalls, 0);
});

test('Exit while the crash dialog is open: the crash dialog is dismissed and the app quits (a crashed page has no live call)', async () => {
  const h = createHarness({ pageBehavior: 'objects' });
  const win = h.open();
  win.webContents.crash();
  await settle();
  const crash = h.dialog.calls[0];
  h.manager.requestExit();
  await settle();
  assert.equal(h.dialog.aborted(crash), true);
  assert.equal(h.state.quitCalls, 1);
  assert.equal(h.dialog.calls.length, 1, 'no P2 for a crashed page');
});

// --- Fallback: the native box ignores `signal` (section 8) ---------------------------------------------------

test('fallback, Exit while P1 is open and P1 cannot be dismissed: P1 stays, the call window is focused, nothing is dropped', async () => {
  const h = createHarness({ pageBehavior: 'objects', dialogHonorsSignal: false });
  const win = h.open();
  win.close();
  await settle();
  const focusBefore = win.count('focus');
  h.manager.requestExit();
  await settle();
  h.clock.tick(500);
  await settle();
  assert.equal(h.dialog.calls.length, 1, 'no P2 while P1 is still open');
  assert.ok(win.count('focus') > focusBefore);
  assert.equal(h.state.quitCalls, 0);
  assert.equal(win.destroyed, false);
});

test('fallback, Exit pending then P1 "Close window": the call is gone, so the remembered Exit proceeds with no P2', async () => {
  const h = createHarness({ pageBehavior: 'objects', dialogHonorsSignal: false });
  const win = h.open();
  win.close();
  await settle();
  h.manager.requestExit();
  await settle();
  h.clock.tick(500);
  await settle();
  h.dialog.answer(h.dialog.calls[0], CLOSE);
  await settle();
  assert.equal(win.destroyed, true);
  assert.equal(h.state.quitCalls, 1);
  assert.equal(h.dialog.calls.length, 1, 'no P2');
});

test('fallback, Exit pending then P1 "Keep window open": P2 is shown, and its "Exit" quits', async () => {
  const h = createHarness({ pageBehavior: 'objects', dialogHonorsSignal: false });
  const win = h.open();
  win.close();
  await settle();
  h.manager.requestExit();
  await settle();
  h.clock.tick(500);
  await settle();
  h.dialog.answer(h.dialog.calls[0], KEEP);
  await settle();
  assert.equal(h.dialog.calls.length, 2);
  assert.deepEqual(h.dialog.calls[1].options.buttons, [EXIT, CANCEL]);
  assert.equal(h.state.quitCalls, 0);
  h.dialog.answer(h.dialog.calls[1], EXIT);
  await settle();
  assert.equal(h.state.quitCalls, 1);
});

test('fallback, Exit while the crash dialog is open and cannot be dismissed: app.quit() runs directly, the Exit is not dropped', async () => {
  const h = createHarness({ pageBehavior: 'objects', dialogHonorsSignal: false });
  const win = h.open();
  win.webContents.crash();
  await settle();
  h.manager.requestExit();
  await settle();
  h.clock.tick(500);
  await settle();
  assert.equal(h.state.quitCalls, 1);
});

// --- Renderer crash (section 9) ---------------------------------------------------------------------------------

test('crash: the picker request is aborted and the native crash dialog is shown, parented to the call window', async () => {
  const h = createHarness();
  const win = h.open();
  win.webContents.crash('crashed');
  await settle();
  assert.ok(h.state.abortPickerCalls >= 1);
  assert.equal(h.dialog.calls.length, 1);
  const box = h.dialog.calls[0];
  assert.equal(box.parent, win);
  assert.match(wording(h, box), new RegExp(CRASH_TITLE));
});

test('crash dialog: "Reload" first, a Close button second and Escape = Close, with an AbortSignal', async () => {
  const h = createHarness();
  h.open().webContents.crash();
  await settle();
  const { options } = h.dialog.calls[0];
  assert.equal(options.buttons.length, 2);
  assert.equal(options.buttons[0], 'Reload');
  assert.match(options.buttons[1], /close/i);
  assert.equal(options.cancelId, 1);
  assert.ok(options.signal);
});

test('crash dialog "Reload": the contents are reloaded, the window stays, and a repeat crash shows the dialog again', async () => {
  const h = createHarness();
  const win = h.open();
  win.webContents.crash();
  await settle();
  h.dialog.answer(h.dialog.calls[0], 'Reload');
  await settle();
  assert.equal(win.webContents.reloadCalls, 1);
  assert.equal(win.destroyed, false);
  win.webContents.crash();
  await settle();
  assert.equal(h.dialog.calls.length, 2);
});

test('crash dialog "Close" (and Escape): the window is destroyed with no further confirmation, the app does not quit', async () => {
  const h = createHarness();
  const win = h.open();
  win.webContents.crash();
  await settle();
  const box = h.dialog.calls[0];
  box.resolve(box.options.cancelId);
  await settle();
  assert.equal(win.destroyed, true);
  assert.equal(h.dialog.calls.length, 1);
  assert.equal(h.state.quitCalls, 0);
});

test('crash with reason clean-exit is not a crash: no dialog', async () => {
  const h = createHarness();
  h.open().webContents.crash('clean-exit');
  await settle();
  assert.equal(h.dialog.calls.length, 0);
});

test('crash while P1 is open: P1 is dismissed first, then the crash dialog is shown (one dialog at a time)', async () => {
  const h = createHarness({ pageBehavior: 'objects' });
  const win = h.open();
  win.close();
  await settle();
  const p1 = h.dialog.calls[0];
  win.webContents.crash();
  await settle();
  assert.equal(h.dialog.aborted(p1), true);
  assert.equal(h.dialog.calls.length, 2);
  assert.match(wording(h, h.dialog.calls[1]), new RegExp(CRASH_TITLE));
  assert.equal(h.openDialogs().length, 1);
});

test('crash dialog answer arriving after the window is gone is discarded without throwing', async () => {
  const h = createHarness();
  const win = h.open();
  win.webContents.crash();
  await settle();
  win.destroy();
  assert.doesNotThrow(() => h.dialog.answer(h.dialog.calls[0], 'Reload'));
  await settle();
  assert.equal(win.webContents.reloadCalls, 0);
});

test('a close attempt while the crash dialog is open is ignored (the dialog already represents it)', async () => {
  const h = createHarness();
  const win = h.open();
  win.webContents.crash();
  await settle();
  win.close();
  await settle();
  assert.equal(win.destroyed, false);
  assert.equal(h.dialog.calls.length, 1);
});

test('at most one dialog is ever open at a time across crash, P1 and P2', async () => {
  const h = createHarness({ pageBehavior: 'objects' });
  const win = h.open();
  win.close();
  await settle();
  win.webContents.crash();
  await settle();
  h.manager.requestExit();
  await settle();
  assert.ok(h.openDialogs().length <= 1);
});
