'use strict';

// UI-04 main-window actions for Chat links (docs/architecture/google-app-windows.md section 3 and the
// coverage-map line "same-URL target -> focus only (no loadURL, tested at the wiring level)").
// RED until src/main/mainWindowActions.js exists.
//
// MODULE API ASSUMED (new small unit, extracted from index.js so the behaviour is testable; the spec
// leaves openMainWindow inside index.js - to argue):
//
//   createMainWindowActions({ getMainWindow, log }) -> { openMainWindow(url), focusMainWindow(), downloadInMainWindow(url) }
//     getMainWindow() -> BrowserWindow | null (the main window, possibly hidden in the tray)
//     openMainWindow(url): target without fragment equal to the main window's current url without
//       fragment -> restore (if minimized) + show + focus ONLY, no loadURL, no reload; otherwise
//       loadURL(url) then restore (if minimized) + show + focus (like tray Show). A hidden window is shown.
//       A null or destroyed main window is a no-op (never throws).
//     focusMainWindow(): restore (if minimized) + show + focus ONLY; never loadURL or reload (the router's
//       'focus-main' outcome for a main-window popup, section 3). Same null/destroyed no-op rule.
//     downloadInMainWindow(url): mainWindow.webContents.downloadURL(url); the window is neither loaded,
//       shown nor focused (the main view is untouched). Null/destroyed window: no-op.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeBrowserWindowClass } = require('./helpers/electronFakes');
const { load } = require('./helpers/pending');

const ROOM_A = 'https://chat.google.com/room/AAAA';
const ROOM_B = 'https://chat.google.com/room/BBBB';

function setup({ currentUrl = 'https://chat.google.com/', visible = true } = {}) {
  const BrowserWindow = createFakeBrowserWindowClass();
  const main = new BrowserWindow({});
  main.webContents.url = currentUrl;
  main.visible = visible;
  main.webContents.downloads = [];
  main.webContents.downloadURL = (u) => main.webContents.downloads.push(u);
  const logs = [];
  const actions = load('mainWindowActions.js').createMainWindowActions({
    getMainWindow: () => main,
    log: (...a) => logs.push(a),
  });
  return { main, actions, logs };
}

test('openMainWindow: a different conversation is loaded, then the window is shown and focused', () => {
  const { main, actions } = setup({ currentUrl: ROOM_A });
  actions.openMainWindow(ROOM_B);
  assert.deepEqual(main.webContents.loadCalls, [ROOM_B]);
  assert.ok(main.count('show') >= 1);
  assert.ok(main.count('focus') >= 1);
});

test('openMainWindow: a hidden main window (tray) is shown', () => {
  const { main, actions } = setup({ currentUrl: ROOM_A, visible: false });
  actions.openMainWindow(ROOM_B);
  assert.equal(main.visible, true);
});

test('openMainWindow: a minimized main window is restored', () => {
  const { main, actions } = setup({ currentUrl: ROOM_A });
  main.minimized = true;
  actions.openMainWindow(ROOM_B);
  assert.equal(main.count('restore'), 1);
  assert.equal(main.minimized, false);
});

test('openMainWindow: the SAME url is focus only - no loadURL and no reload (a draft is not dropped)', () => {
  const { main, actions } = setup({ currentUrl: ROOM_A });
  actions.openMainWindow(ROOM_A);
  assert.deepEqual(main.webContents.loadCalls, []);
  assert.equal(main.webContents.reloadCalls, 0);
  assert.ok(main.count('show') >= 1);
  assert.ok(main.count('focus') >= 1);
});

test('openMainWindow: the same url differing only by fragment is also focus only', () => {
  const { main, actions } = setup({ currentUrl: ROOM_A });
  actions.openMainWindow(`${ROOM_A}#msg`);
  assert.deepEqual(main.webContents.loadCalls, []);
});

test('openMainWindow: the same url when the window is hidden still shows it without reloading', () => {
  const { main, actions } = setup({ currentUrl: ROOM_A, visible: false });
  actions.openMainWindow(ROOM_A);
  assert.equal(main.visible, true);
  assert.deepEqual(main.webContents.loadCalls, []);
});

test('openMainWindow: a destroyed or missing main window is a no-op and never throws', () => {
  const { main, actions } = setup();
  main.destroy();
  assert.doesNotThrow(() => actions.openMainWindow(ROOM_A));
  const none = load('mainWindowActions.js').createMainWindowActions({ getMainWindow: () => null, log: () => {} });
  assert.doesNotThrow(() => none.openMainWindow(ROOM_A));
  assert.doesNotThrow(() => none.downloadInMainWindow(ROOM_A));
});

test('focusMainWindow: shows, restores and focuses a hidden minimized window and never loads or reloads', () => {
  const { main, actions } = setup({ currentUrl: ROOM_A, visible: false });
  main.minimized = true;
  actions.focusMainWindow();
  assert.equal(main.visible, true);
  assert.equal(main.minimized, false);
  assert.ok(main.count('focus') >= 1);
  assert.deepEqual(main.webContents.loadCalls, []);
  assert.equal(main.webContents.reloadCalls, 0);
});

test('focusMainWindow: a destroyed or missing main window is a no-op and never throws', () => {
  const { main, actions } = setup();
  main.destroy();
  assert.doesNotThrow(() => actions.focusMainWindow());
  const none = load('mainWindowActions.js').createMainWindowActions({ getMainWindow: () => null, log: () => {} });
  assert.doesNotThrow(() => none.focusMainWindow());
});

test('downloadInMainWindow: calls webContents.downloadURL, never loadURL; the view is untouched and nothing is shown or focused', () => {
  const { main, actions } = setup({ currentUrl: ROOM_A, visible: false });
  const url = 'https://chat.google.com/api/get_attachment_url?x=1';
  actions.downloadInMainWindow(url);
  assert.deepEqual(main.webContents.downloads, [url]);
  assert.deepEqual(main.webContents.loadCalls, []);
  assert.equal(main.count('show'), 0);
  assert.equal(main.count('focus'), 0);
  assert.equal(main.visible, false);
});

test('downloadInMainWindow: the url is not logged', () => {
  const { actions, logs } = setup();
  actions.downloadInMainWindow('https://chat.google.com/api/secret-token-xyz');
  assert.equal(JSON.stringify(logs).includes('secret-token-xyz'), false);
});
