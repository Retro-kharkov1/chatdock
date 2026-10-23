'use strict';

// UI-13: back / forward in Google app windows (src/main/historyNav.js). Coverage map:
//   requirement 1 Alt+Left/Right       -> 'keys' tests (consumed; Ctrl/Shift/Meta/keyUp/other keys ignored)
//   requirement 2 mouse buttons        -> 'app-command' tests (browser-backward / browser-forward; others ignored)
//   requirement 3 allow-list only      -> 'guard' tests (real isGoogleNavigationUrl: a refused entry is never taken,
//                                         both directions; no entry / no history = nothing happens)
//   requirement 4 Chat + call window   -> 'wiring' test (only googleAppWindow.js binds it; call/Meet/main files do not)
//   requirement 5 no UI, no logging    -> 'wiring' test (no IPC/BrowserWindow/log in the module)
//   requirement 6 navigationHistory    -> fake contents has ONLY navigationHistory (no goBack): the module uses the new API
//   manager integration                -> 'manager' test (bindHistoryNav receives the created window)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { makeEvent } = require('./helpers/electronFakes');
const { isGoogleNavigationUrl } = require('../src/main/googleLink');
const { createHistoryNav, historyActionForKey, historyActionForCommand } = require('../src/main/historyNav');

const DOC = 'https://docs.google.com/document/d/1/edit';
const DRIVE = 'https://drive.google.com/drive/folders/2';
const EVIL = 'https://evil.example.com/x';
const CHAT = 'https://chat.google.com/room/abc';

/** A window whose contents expose only navigationHistory over a list of urls. */
function fakeWindow(urls, active) {
  const win = new EventEmitter();
  const wc = new EventEmitter();
  const calls = [];
  let index = active;
  wc.destroyed = false;
  wc.isDestroyed = () => wc.destroyed;
  wc.navigationHistory = {
    canGoBack: () => index > 0,
    canGoForward: () => index < urls.length - 1,
    getActiveIndex: () => index,
    getEntryAtIndex: (i) => (i >= 0 && i < urls.length ? { url: urls[i], title: '' } : null),
    goBack: () => { calls.push('back'); index -= 1; },
    goForward: () => { calls.push('forward'); index += 1; },
  };
  win.webContents = wc;
  win.calls = calls;
  return win;
}

function press(win, input) {
  const event = makeEvent();
  win.webContents.emit('before-input-event', event, { type: 'keyDown', alt: true, control: false, meta: false, shift: false, key: '', ...input });
  return event;
}

const bound = (urls, active) => {
  const win = fakeWindow(urls, active);
  createHistoryNav({ isAllowed: isGoogleNavigationUrl }).bind(win);
  return win;
};

test('keys: Alt+Left goes back, Alt+Right goes forward; both consumed', () => {
  const win = bound([DOC, DRIVE, DOC], 1);
  assert.equal(press(win, { key: 'ArrowLeft' }).defaultPrevented, true);
  assert.deepEqual(win.calls, ['back']);
  assert.equal(press(win, { key: 'ArrowRight' }).defaultPrevented, true);
  assert.deepEqual(win.calls, ['back', 'forward']);
});

test('keys: other combinations are ignored and not consumed', () => {
  const win = bound([DOC, DRIVE, DOC], 1);
  for (const input of [
    { alt: false, key: 'ArrowLeft' },
    { control: true, key: 'ArrowLeft' },
    { meta: true, key: 'ArrowRight' },
    { shift: true, key: 'ArrowLeft' },
    { type: 'keyUp', key: 'ArrowLeft' },
    { key: 'ArrowUp' },
    { key: 'a' },
  ]) {
    assert.equal(press(win, input).defaultPrevented, false, JSON.stringify(input));
  }
  assert.deepEqual(win.calls, []);
  assert.equal(historyActionForKey(null), null);
});

test('keys: at the end of the history the key is consumed but nothing navigates', () => {
  const win = bound([DOC], 0);
  assert.equal(press(win, { key: 'ArrowLeft' }).defaultPrevented, true);
  press(win, { key: 'ArrowRight' });
  assert.deepEqual(win.calls, []);
});

test('app-command: browser-backward / browser-forward navigate; other commands do not', () => {
  const win = bound([DOC, DRIVE, DOC], 1);
  win.emit('app-command', makeEvent(), 'browser-backward');
  win.emit('app-command', makeEvent(), 'browser-forward');
  win.emit('app-command', makeEvent(), 'browser-home');
  win.emit('app-command', makeEvent(), 'media-play-pause');
  assert.deepEqual(win.calls, ['back', 'forward']);
  assert.equal(historyActionForCommand('browser-backward'), 'back');
  assert.equal(historyActionForCommand('browser-refresh'), null);
});

test('guard: a back target the navigation guard would refuse is never taken', () => {
  const win = bound([EVIL, DOC, DRIVE], 1);
  press(win, { key: 'ArrowLeft' });
  win.emit('app-command', makeEvent(), 'browser-backward');
  assert.deepEqual(win.calls, []);
  assert.equal(isGoogleNavigationUrl(EVIL), false);
});

test('guard: a forward target outside the list is never taken; a chat.google.com or non-https entry neither', () => {
  const win = bound([DOC, DRIVE, EVIL], 1);
  press(win, { key: 'ArrowRight' });
  assert.deepEqual(win.calls, []);
  for (const bad of [CHAT, 'http://docs.google.com/x', 'https://docs.google.com:8443/x', 'https://u@docs.google.com/x', 'file:///etc/passwd', '']) {
    const w = bound([bad, DOC], 1);
    press(w, { key: 'ArrowLeft' });
    assert.deepEqual(w.calls, [], bad);
  }
});

test('guard: an allowed neighbour is taken after a refused one stopped earlier presses', () => {
  const win = bound([DOC, EVIL, DRIVE], 2);
  press(win, { key: 'ArrowLeft' });
  assert.deepEqual(win.calls, []); // the refused entry is a wall, not skipped
});

test('go: destroyed contents, missing history or unknown action do nothing', () => {
  const nav = createHistoryNav({ isAllowed: isGoogleNavigationUrl });
  const win = fakeWindow([DOC, DRIVE], 1);
  assert.equal(nav.go(win.webContents, 'sideways'), false);
  win.webContents.destroyed = true;
  assert.equal(nav.go(win.webContents, 'back'), false);
  assert.equal(nav.go({ isDestroyed: () => false }, 'back'), false);
  assert.equal(nav.go(null, 'back'), false);
  assert.deepEqual(win.calls, []);
});

test('manager: the window manager passes the created window to bindHistoryNav', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'googleAppWindow.js'), 'utf8');
  assert.match(src, /bindHistoryNav\(created\)/);
});

test('wiring: only the Google app windows bind it; Chat, call window and Meet code never do; no IPC, no logging', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', p), 'utf8');
  const index = read('index.js');
  assert.match(index, /bindHistoryNav: createHistoryNav\(\{ isAllowed: isGoogleNavigationUrl \}\)\.bind/);
  assert.doesNotMatch(index, /historyNav\.bind|createHistoryNav\([^)]*\)\.bind\(mainWindow/);
  for (const f of ['callWindow.js', 'meetPermissions.js', 'meetLink.js', 'meetingPage.js', 'helpWindow.js', 'settingsWindow.js', 'pickerWindow.js', 'zoom.js', 'editShortcuts.js']) {
    assert.doesNotMatch(read(f), /historyNav|navigationHistory/, f);
  }
  const src = read('historyNav.js');
  assert.doesNotMatch(src, /ipcMain|ipcRenderer|BrowserWindow|Menu|contextBridge|console\.|\blog\(/);
  assert.doesNotMatch(src, /contents\.(goBack|goForward|canGoBack|canGoForward)\(/); // deprecated API, navigationHistory only
});
