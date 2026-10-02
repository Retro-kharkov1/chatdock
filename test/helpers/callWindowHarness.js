'use strict';

// UI-01 call window test harness. It composes the REAL link router and Meet classifier with a
// call window manager built from fakes (test/helpers/electronFakes.js). Used by callWindow*.test.js.
//
// ---------------------------------------------------------------------------------------------------
// API CONTRACT ASSUMED FOR src/main/callWindow.js (docs/architecture/meet-call-window.md sections 4,
// 5, 8, 9 name the behaviour; this is the minimal injectable shape the tests fix. The implementer may
// argue with it and then change this file and the tests together, never silently.)
//
//   createCallWindowManager({
//     BrowserWindow,            // constructor: new BrowserWindow(options)
//     Notification,             // constructor: new Notification({ title, body }); .show(); .on('click')
//     getRouter,                // () => linkRouter (lazy: the router needs openCallWindow, and vice versa)
//     isQuitting,               // () => boolean (quitGuard.isQuitting)
//     showMessageBox,           // (parentWindow, options) => Promise<{ response }>   (dialog.showMessageBox)
//     picker,                   // { isOpen(), raise(), flash() } - the picker window facade; raise() =
//                               //   restore + show + focus the PICKER, flash() = flashFrame on the PICKER
//     abortPending,             // () => void - the display-media gate's abortPending (picker teardown)
//     onChange,                 // () => void - tray refresh hook: called when the window is created
//                               //   and when it is destroyed
//     quitApp,                  // () => void - app.quit()
//     timers,                   // { setTimeout, clearTimeout } (defaults to the globals)
//     probeMs = 3000,           // close-probe timeout
//     dismissWaitMs = 500,      // how long to wait after AbortController.abort() for an open message
//                               //   box to settle before concluding it ignores `signal` (fallback)
//     log,                      // (message, ...args) => void
//   }) -> {
//     openCallWindow(url),      // section 5 entry (the second-link rule); url already normalised
//     showCallWindow(),         // tray P3: restore + raise + focus; the picker instead if one is open
//     requestExit() -> Promise|void,    // tray Exit rules (section 8 "Exit is never swallowed"); the tests
//                               //   never await the result
//     hasCallWindow() -> boolean,       // exists and not destroyed
//     getWindow() -> BrowserWindow|null,
//   }
//
// Window options: `new BrowserWindow(options)` with options.webPreferences exactly hardened (see
// callWindow.test.js); the window loads `url` with loadURL / webContents.loadURL.
// Dialogs: showMessageBox(callWindow, { type?, title?, message, detail?, buttons, defaultId, cancelId,
// signal }) - wording is read tolerantly from title + message + detail (docs/design/06).
// ---------------------------------------------------------------------------------------------------

const { PARTITION } = require('../../src/main/session.js');
const { load } = require('./pending');
const {
  createFakeBrowserWindowClass,
  createFakeNotificationClass,
  createDialogFake,
  createManualClock,
  createPickerStub,
  settle,
  MEET_URL,
} = require('./electronFakes');

function createHarness({ pageBehavior = 'none', dialogHonorsSignal = true, quitting = false } = {}) {
  const BrowserWindow = createFakeBrowserWindowClass();
  BrowserWindow.pageBehavior = pageBehavior;
  const Notification = createFakeNotificationClass();
  const dialog = createDialogFake({ honorSignal: dialogHonorsSignal });
  const clock = createManualClock();
  const picker = createPickerStub();
  const state = {
    quitting,
    quitCalls: 0,
    destroyedAtQuit: null,
    abortPickerCalls: 0,
    changes: 0,
    external: [],
    logs: [],
  };

  const meetLink = load('meetLink.js');
  const holder = {};
  const router = load('linkRouter.js').createLinkRouter({
    classifyLink: meetLink.classifyLink,
    isOpenableExternalScheme: meetLink.isOpenableExternalScheme,
    openCallWindow: (url) => holder.manager.openCallWindow(url),
    openExternal: (url) => state.external.push(url),
    log: (...args) => state.logs.push(args),
  });

  holder.manager = load('callWindow.js').createCallWindowManager({
    BrowserWindow,
    Notification,
    getRouter: () => router,
    isQuitting: () => state.quitting,
    showMessageBox: dialog.showMessageBox,
    picker,
    // models the real teardown: tearing the picker request down closes the picker
    abortPending: () => { state.abortPickerCalls += 1; picker.open = false; },
    onChange: () => { state.changes += 1; },
    quitApp: () => {
      state.quitCalls += 1;
      state.destroyedAtQuit = BrowserWindow.instances.map((w) => w.destroyed);
    },
    timers: clock,
    probeMs: 3000,
    dismissWaitMs: 500,
    log: (...args) => state.logs.push(args),
  });

  const harness = {
    BrowserWindow,
    Notification,
    dialog,
    clock,
    picker,
    state,
    router,
    manager: holder.manager,
    /** Open the call window for `url` and return the (only) window instance. */
    open(url = MEET_URL) {
      holder.manager.openCallWindow(url);
      return harness.win();
    },
    /** The most recently created window instance. */
    win() {
      return BrowserWindow.instances[BrowserWindow.instances.length - 1];
    },
    /** Dialog calls whose box is still open. */
    openDialogs: () => dialog.open(),
    settle,
    PARTITION,
  };
  return harness;
}

module.exports = { createHarness };
