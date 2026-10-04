'use strict';

// UI-04 Google app window test harness. Composes the REAL link router, Meet classifier and Google
// classifier with a Google app window manager built from fakes (test/helpers/electronFakes.js).
//
// ---------------------------------------------------------------------------------------------------
// API CONTRACT ASSUMED (docs/architecture/google-app-windows.md sections 4, 5, 7; the implementer may
// argue with it and then change this file and the tests together, never silently).
//
// src/main/googleAppWindow.js
//   createGoogleAppWindowManager({
//     BrowserWindow,     // constructor: new BrowserWindow(options)
//     getRouter,         // () => linkRouter (lazy; the router needs openGoogleAppWindow, and vice versa)
//     isQuitting,        // () => boolean (quitGuard.isQuitting)
//     showMessageBox,    // (parentWindow, options) => Promise<{ response }>   (dialog.showMessageBox)
//     openExternal,      // (url) => void: system browser by the scheme rule (the forms.gle hop failure path
//                        //   uses it directly; routing it through the router would classify forms.gle again)
//     timers,            // { setTimeout, clearTimeout } (defaults to the globals)
//     probeMs = 3000,    // close-probe timeout
//     hopMs = 10000,     // forms.gle decision timeout
//     iconPath,          // optional app icon, copied to options.icon when given
//     log,               // (message, ...args) => void
//   }) -> {
//     openGoogleAppWindow(url, { hop } = {}), // the router's collaborator; url already normalised; hop true
//                                          //   for forms.gle (hidden entry-hop window, section 2). Also used
//                                          //   by the factory itself for popups/navigations to forms.gle.
//     getAppWindowForContents(webContents) // -> BrowserWindow | null (the downloads module's lookup)
//     closeIfEmpty(webContents) -> boolean // empty-window auto-close (section 2): when the window never
//                                          //   displayed a page (no 'did-navigate' to a committed page) it is
//                                          //   destroyed and true is returned; a window that displayed a page
//                                          //   is left alone (false). Called by downloads.js when a download
//                                          //   ends (completed / cancelled / interrupted) and at once for a
//                                          //   blocked download. Unknown contents -> false.
//   }
//
// A hop window: created with show:false, registry entry added synchronously keyed by the REQUESTED href and
// flagged pending. will-redirect to a nav-list host: allowed, keep waiting. will-redirect to any non-nav-list
// target: preventDefault, destroy, that target to openExternal. did-navigate: on a nav-list host -> show (re-dedupe
// by final href without fragment, else re-key); on any other host (forms.gle itself included) -> destroy +
// ORIGINAL url to openExternal. did-fail-load (main frame) or hopMs without a decision -> destroy + original url
// to openExternal. A second click while pending is coalesced: no window, no show(), no focus().
//
// The manager requires googleLink.js directly (pure module, like callWindow.js requires meetLink.js).
// Main-frame navigation in an app window that is not on the nav list (and not a download hop) is
// preventDefault()ed and handed to getRouter().route(url, { source: 'app' }).
// ---------------------------------------------------------------------------------------------------

const { PARTITION } = require('../../src/main/session.js');
const { load } = require('./pending');
const {
  createFakeBrowserWindowClass,
  createDialogFake,
  createManualClock,
  settle,
} = require('./electronFakes');

const ICON = 'C:/app/assets/icon.png';

function createGoogleHarness({ pageBehavior = 'none', quitting = false } = {}) {
  const BrowserWindow = createFakeBrowserWindowClass();
  BrowserWindow.pageBehavior = pageBehavior;
  const dialog = createDialogFake();
  const clock = createManualClock();
  const state = {
    quitting,
    external: [],
    callWindow: [],
    mainWindow: [],
    mainDownloads: [],
    focusMain: 0,
    logs: [],
  };

  const meetLink = load('meetLink.js');
  const googleLink = load('googleLink.js');
  const holder = {};
  const router = load('linkRouter.js').createLinkRouter({
    classifyLink: meetLink.classifyLink,
    isOpenableExternalScheme: meetLink.isOpenableExternalScheme,
    classifyGoogleLink: googleLink.classifyGoogleLink,
    classifyChatTarget: googleLink.classifyChatTarget,
    openCallWindow: (url) => state.callWindow.push(url),
    openMainWindow: (url) => state.mainWindow.push(url),
    focusMainWindow: () => { state.focusMain += 1; },
    downloadInMainWindow: (url) => state.mainDownloads.push(url),
    openGoogleAppWindow: (url, opts) => holder.manager.openGoogleAppWindow(url, opts),
    openExternal: (url) => state.external.push(url),
    log: (...args) => state.logs.push(args),
  });

  holder.manager = load('googleAppWindow.js').createGoogleAppWindowManager({
    BrowserWindow,
    getRouter: () => router,
    isQuitting: () => state.quitting,
    showMessageBox: dialog.showMessageBox,
    openExternal: (url) => state.external.push(url),
    timers: clock,
    probeMs: 3000,
    hopMs: 10000,
    iconPath: ICON,
    log: (...args) => state.logs.push(args),
  });

  const harness = {
    BrowserWindow,
    dialog,
    clock,
    state,
    router,
    manager: holder.manager,
    open(url, opts) {
      holder.manager.openGoogleAppWindow(url, opts);
      return harness.win();
    },
    win() {
      return BrowserWindow.instances[BrowserWindow.instances.length - 1];
    },
    openDialogs: () => dialog.open(),
    settle,
    PARTITION,
    ICON,
  };
  return harness;
}

module.exports = { createGoogleHarness, ICON };
