'use strict';

// UI-01 call window: creation options, navigation limits, popups, singleton, second-link rule, tray
// "Show call window" (P3) and teardown (docs/architecture/meet-call-window.md sections 4, 5, 7; NFR-07).
// RED until src/main/callWindow.js (and meetingPage.js, linkRouter.js, meetLink.js) exist.
// The module API contract assumed is documented in test/helpers/callWindowHarness.js.
// Close / probe / P1 are in callWindowClose.test.js; Exit / dialog slot / crash in callWindowExit.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/callWindowHarness');
const { settle, MEET_URL, MEET_URL_2 } = require('./helpers/electronFakes');

const NOTIFICATION_TITLE = 'Google Meet';
const NOTIFICATION_BODY = 'A call is already open. The new link was not opened.';

// --- creation and hardening (NFR-07: asserted on the options the window is CREATED with) ------------

test('callWindow: opening a Meet link creates one window, loads that url and focuses it', () => {
  const h = createHarness();
  const win = h.open(MEET_URL);
  assert.equal(h.BrowserWindow.instances.length, 1);
  assert.deepEqual(win.webContents.loadCalls, [MEET_URL]);
  assert.ok(win.count('focus') >= 1);
  assert.equal(h.manager.hasCallWindow(), true);
  assert.equal(h.manager.getWindow(), win);
});

test('callWindow: created with contextIsolation on, nodeIntegration off, sandbox on and the shared session partition', () => {
  const h = createHarness();
  const { webPreferences } = h.open().options;
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(webPreferences.sandbox, true);
  assert.equal(webPreferences.partition, h.PARTITION);
});

test('callWindow: created with NO preload at all (the Meet page has no bridge)', () => {
  const h = createHarness();
  const options = h.open().options;
  assert.equal('preload' in options.webPreferences, false);
  assert.equal('preload' in options, false);
});

test('callWindow: no weakening flags in the options (webSecurity, insecure content, webview, sub-frame node)', () => {
  const h = createHarness();
  const { webPreferences } = h.open().options;
  assert.notEqual(webPreferences.webSecurity, false);
  assert.notEqual(webPreferences.allowRunningInsecureContent, true);
  assert.notEqual(webPreferences.webviewTag, true);
  assert.notEqual(webPreferences.nodeIntegrationInSubFrames, true);
  assert.notEqual(webPreferences.enableRemoteModule, true);
});

test('callWindow: the window holds only the Meet page - one window, nothing local loaded, no other surface', () => {
  const h = createHarness();
  const win = h.open();
  assert.equal(h.BrowserWindow.instances.length, 1);
  assert.equal(win.webContents.loadCalls.length, 1);
  assert.equal(win.webContents.loadCalls[0].startsWith('https://meet.google.com/'), true);
  assert.equal(win.loadFileCalls, undefined, 'nothing local is ever loaded into the call window');
});

test('callWindow: will-prevent-unload is registered at creation, before any close attempt', () => {
  const h = createHarness();
  const win = h.open();
  assert.equal(win.webContents.listenerCount('will-prevent-unload'), 1);
});

test('callWindow: creation and destruction both trigger the tray refresh hook', () => {
  const h = createHarness();
  const win = h.open();
  assert.equal(h.state.changes, 1);
  win.destroy();
  assert.equal(h.state.changes, 2);
});

// --- singleton -----------------------------------------------------------------------------------

test('callWindow: two quick links create ONE window (the reference is set before the load)', () => {
  const h = createHarness();
  h.manager.openCallWindow(MEET_URL);
  h.manager.openCallWindow(MEET_URL_2);
  assert.equal(h.BrowserWindow.instances.length, 1);
});

test('callWindow: after the window is destroyed the next link creates a fresh one', () => {
  const h = createHarness();
  h.open(MEET_URL).destroy();
  assert.equal(h.manager.hasCallWindow(), false);
  assert.equal(h.manager.getWindow(), null);
  h.manager.openCallWindow(MEET_URL_2);
  assert.equal(h.BrowserWindow.instances.length, 2);
  assert.deepEqual(h.win().webContents.loadCalls, [MEET_URL_2]);
});

// --- close never quits, never hides ----------------------------------------------------------------

test('callWindow: closing a non-live call window destroys it, never hides it and never quits the app', () => {
  const h = createHarness({ pageBehavior: 'none' });
  const win = h.open();
  win.close();
  assert.equal(win.destroyed, true);
  assert.equal(win.count('hide'), 0);
  assert.equal(h.state.quitCalls, 0);
});

// --- navigation limits (will-navigate / will-redirect, main frame) ---------------------------------

for (const type of ['will-navigate', 'will-redirect']) {
  test(`callWindow ${type}: meet.google.com and accounts.google.com pass untouched`, () => {
    const h = createHarness();
    const win = h.open();
    for (const url of ['https://meet.google.com/xyz-uvwx-rst', 'https://accounts.google.com/signin/v2', 'https://MEET.GOOGLE.COM/abc']) {
      assert.equal(win.webContents.navigate(url, { type }).defaultPrevented, false, url);
    }
    assert.deepEqual(h.state.external, []);
  });

  test(`callWindow ${type}: chat and other hosts are blocked and routed to the system browser`, () => {
    const h = createHarness();
    const win = h.open();
    for (const url of ['https://chat.google.com/', 'https://example.org/', 'http://meet.google.com/abc', 'https://meet.google.com.evil.example/']) {
      assert.equal(win.webContents.navigate(url, { type }).defaultPrevented, true, url);
    }
    assert.deepEqual(h.state.external, ['https://chat.google.com/', 'https://example.org/', 'http://meet.google.com/abc', 'https://meet.google.com.evil.example/']);
  });

  test(`callWindow ${type}: a blocked mailto goes to the OS, a disallowed scheme is opened nowhere`, () => {
    const h = createHarness();
    const win = h.open();
    assert.equal(win.webContents.navigate('mailto:someone@example.org', { type }).defaultPrevented, true);
    assert.equal(win.webContents.navigate('file:///C:/Windows/System32/calc.exe', { type }).defaultPrevented, true);
    assert.equal(win.webContents.navigate('ms-settings:privacy', { type }).defaultPrevented, true);
    assert.deepEqual(h.state.external, ['mailto:someone@example.org']);
  });

  test(`callWindow ${type}: sub-frame navigation is not restricted (Meet embeds frames)`, () => {
    const h = createHarness();
    const win = h.open();
    const event = win.webContents.navigate('https://example.org/embedded', { type, isMainFrame: false });
    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(h.state.external, []);
  });
}

test('callWindow: a blocked navigation never opens a second window or navigates the call window away', () => {
  const h = createHarness();
  const win = h.open();
  win.webContents.navigate('https://example.org/');
  assert.equal(h.BrowserWindow.instances.length, 1);
  assert.deepEqual(win.webContents.loadCalls, [MEET_URL]);
});

// --- popups ---------------------------------------------------------------------------------------

test('callWindow popups: window.open is denied, no window is created, and the target is routed to the system browser', () => {
  const h = createHarness();
  const win = h.open();
  assert.deepEqual(win.webContents.windowOpen('https://example.org/'), { action: 'deny' });
  assert.equal(h.BrowserWindow.instances.length, 1);
  assert.deepEqual(h.state.external, ['https://example.org/']);
});

test('callWindow popups: every popup is denied, including disallowed schemes, which open nowhere', () => {
  const h = createHarness();
  const win = h.open();
  for (const url of ['file:///C:/x.html', 'javascript:alert(1)', 'ssh://host.example', 'not a url']) {
    assert.deepEqual(win.webContents.windowOpen(url), { action: 'deny' }, url);
  }
  assert.deepEqual(h.state.external, []);
  assert.equal(h.BrowserWindow.instances.length, 1);
});

test('callWindow popups: mailto goes to the OS', () => {
  const h = createHarness();
  const win = h.open();
  win.webContents.windowOpen('mailto:someone@example.org');
  assert.deepEqual(h.state.external, ['mailto:someone@example.org']);
});

test('callWindow popups: a Meet link inside a Meet page follows the second-link rule (focus + notify, no navigation, no window)', () => {
  const h = createHarness();
  const win = h.open(MEET_URL);
  assert.deepEqual(win.webContents.windowOpen(MEET_URL_2), { action: 'deny' });
  assert.equal(h.BrowserWindow.instances.length, 1);
  assert.deepEqual(win.webContents.loadCalls, [MEET_URL]);
  assert.equal(h.Notification.instances.length, 1);
  assert.deepEqual(h.state.external, []);
});

// --- second link ----------------------------------------------------------------------------------

test('second link, no meeting on screen: the new link loads into the existing window, no notification, no second window', () => {
  for (const nonMeeting of ['https://meet.google.com/landing', 'https://meet.google.com/', 'https://accounts.google.com/signin', 'about:blank']) {
    const h = createHarness();
    const win = h.open(MEET_URL);
    win.webContents.url = nonMeeting;
    h.manager.openCallWindow(MEET_URL_2);
    assert.equal(h.BrowserWindow.instances.length, 1, nonMeeting);
    assert.deepEqual(win.webContents.loadCalls, [MEET_URL, MEET_URL_2], nonMeeting);
    assert.equal(h.Notification.instances.length, 0, nonMeeting);
  }
});

test('second link, no meeting on screen: a minimized window is restored, then raised and focused', () => {
  const h = createHarness();
  const win = h.open(MEET_URL);
  win.webContents.url = 'https://meet.google.com/landing';
  win.minimized = true;
  const focusBefore = win.count('focus');
  h.manager.openCallWindow(MEET_URL_2);
  assert.equal(win.count('restore'), 1);
  assert.ok(win.count('focus') > focusBefore);
});

test('second link, meeting on screen: focus and notify, never navigate, never a second window', () => {
  const h = createHarness();
  const win = h.open(MEET_URL);
  win.webContents.url = MEET_URL;
  const focusBefore = win.count('focus');
  h.manager.openCallWindow(MEET_URL_2);
  assert.equal(h.BrowserWindow.instances.length, 1);
  assert.deepEqual(win.webContents.loadCalls, [MEET_URL]);
  assert.ok(win.count('focus') > focusBefore);
  assert.equal(h.Notification.instances.length, 1);
  const note = h.Notification.instances[0];
  assert.equal(note.shown, 1);
  assert.equal(note.options.title, NOTIFICATION_TITLE);
  assert.equal(note.options.body, NOTIFICATION_BODY);
});

test('second link, meeting on screen: a minimized window is restored', () => {
  const h = createHarness();
  const win = h.open(MEET_URL);
  win.webContents.url = MEET_URL;
  win.minimized = true;
  h.manager.openCallWindow(MEET_URL_2);
  assert.equal(win.count('restore'), 1);
});

test('second link, meeting on screen: an unrecognised address counts as a meeting (safe direction)', () => {
  const h = createHarness();
  const win = h.open(MEET_URL);
  win.webContents.url = 'something-the-parser-cannot-read';
  h.manager.openCallWindow(MEET_URL_2);
  assert.deepEqual(win.webContents.loadCalls, [MEET_URL]);
  assert.equal(h.Notification.instances.length, 1);
});

test('second link, meeting on screen, picker open: the PICKER is raised and focused (not the call window), still notified', () => {
  const h = createHarness();
  const win = h.open(MEET_URL);
  win.webContents.url = MEET_URL;
  h.picker.open = true;
  const focusBefore = win.count('focus');
  h.manager.openCallWindow(MEET_URL_2);
  assert.ok(h.picker.raised >= 1);
  assert.equal(win.count('focus'), focusBefore);
  assert.deepEqual(win.webContents.loadCalls, [MEET_URL]);
  assert.equal(h.Notification.instances.length, 1);
});

test('second link notification: clicking it focuses the call window (restoring it when minimized)', () => {
  const h = createHarness();
  const win = h.open(MEET_URL);
  win.webContents.url = MEET_URL;
  h.manager.openCallWindow(MEET_URL_2);
  win.minimized = true;
  const focusBefore = win.count('focus');
  h.Notification.instances[0].click();
  assert.equal(win.count('restore'), 1);
  assert.ok(win.count('focus') > focusBefore);
});

test('second link notification: clicking it on a destroyed window is a no-op (no new window, no throw)', () => {
  const h = createHarness();
  const win = h.open(MEET_URL);
  win.webContents.url = MEET_URL;
  h.manager.openCallWindow(MEET_URL_2);
  win.destroy();
  assert.doesNotThrow(() => h.Notification.instances[0].click());
  assert.equal(h.BrowserWindow.instances.length, 1);
});

test('second link: a call window showing the crash dialog counts as a meeting - focus and notify, the dialog stays', async () => {
  const h = createHarness();
  const win = h.open(MEET_URL);
  win.webContents.url = MEET_URL;
  win.webContents.crash();
  await settle();
  assert.equal(h.openDialogs().length, 1);
  h.manager.openCallWindow(MEET_URL_2);
  assert.equal(h.Notification.instances.length, 1);
  assert.deepEqual(win.webContents.loadCalls, [MEET_URL]);
  assert.equal(h.openDialogs().length, 1);
  assert.equal(h.dialog.aborted(h.dialog.calls[0]), false);
});

// --- tray "Show call window" (P3) -------------------------------------------------------------------

test('showCallWindow (P3): restores a minimized call window, raises and focuses it', () => {
  const h = createHarness();
  const win = h.open();
  win.minimized = true;
  const focusBefore = win.count('focus');
  h.manager.showCallWindow();
  assert.equal(win.count('restore'), 1);
  assert.ok(win.count('focus') > focusBefore);
});

test('showCallWindow (P3): with the picker open, focus goes to the picker, not the call window', () => {
  const h = createHarness();
  const win = h.open();
  h.picker.open = true;
  const focusBefore = win.count('focus');
  h.manager.showCallWindow();
  assert.ok(h.picker.raised >= 1);
  assert.equal(win.count('focus'), focusBefore);
});

test('showCallWindow (P3): with no call window it is a harmless no-op', () => {
  const h = createHarness();
  assert.doesNotThrow(() => h.manager.showCallWindow());
  assert.equal(h.BrowserWindow.instances.length, 0);
  assert.equal(h.manager.hasCallWindow(), false);
});

// --- teardown hook (section 4) -----------------------------------------------------------------------

test('teardown: window closed aborts the picker request exactly once', () => {
  const h = createHarness();
  const win = h.open();
  win.destroy();
  assert.equal(h.state.abortPickerCalls, 1);
});

test('teardown: render-process-gone aborts the picker request', async () => {
  const h = createHarness();
  const win = h.open();
  win.webContents.crash();
  await settle();
  assert.ok(h.state.abortPickerCalls >= 1);
});
