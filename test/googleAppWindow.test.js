'use strict';

// UI-04 Google app window factory (docs/architecture/google-app-windows.md section 4 and coverage-map rows
// "Window factory", "Window options", "Navigation and popups"). RED until src/main/googleAppWindow.js and
// googleLink.js exist. Module API contract: see test/helpers/googleAppWindowHarness.js. The close probe,
// will-prevent-unload and quit rules are in googleAppWindowClose.test.js.
//
// Fake-Electron notes: FakeWebContents.loadURL stores the url as the "current" url (so the fragment rule
// can read it with getURL()); tests simulate a user moving to another page by assigning webContents.url.
// Navigation events come from webContents.navigate(url, { type: 'will-navigate' | 'will-redirect', isMainFrame }).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGoogleHarness, ICON } = require('./helpers/googleAppWindowHarness');
const { makeEvent } = require('./helpers/electronFakes');

const DRIVE = 'https://drive.google.com/file/d/FILE_ID/view?usp=sharing';
const DOC = 'https://docs.google.com/document/d/1/edit';
const DOC_2 = 'https://docs.google.com/document/d/2/edit';
const FORM_SHORT = 'https://forms.gle/abc';
const FORM_FINAL = 'https://docs.google.com/forms/d/e/1FAIpQ/viewform';
const USERCONTENT_DL = 'https://drive.usercontent.google.com/download?id=1&export=download';

// --- creation and hardening (NFR-07: asserted on the options the window is CREATED with) --------------------------

test('appWindow: a Drive link creates one window, loads the normalised url and focuses it', () => {
  const h = createGoogleHarness();
  const win = h.open('HTTPS://DRIVE.GOOGLE.COM/file/d/FILE_ID/view?usp=sharing');
  assert.equal(h.BrowserWindow.instances.length, 1);
  assert.deepEqual(win.webContents.loadCalls, [DRIVE]);
  assert.ok(win.count('focus') >= 1);
});

test('appWindow: webPreferences are EXACTLY the hardened set with the shared PARTITION', () => {
  const h = createGoogleHarness();
  assert.deepEqual(h.open(DRIVE).options.webPreferences, {
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    partition: h.PARTITION,
  });
});

test('appWindow: created with NO preload key at all, in webPreferences or the window options', () => {
  const h = createGoogleHarness();
  const options = h.open(DRIVE).options;
  assert.equal('preload' in options.webPreferences, false);
  assert.equal('preload' in options, false);
});

test('appWindow: the partition is the session.js constant, not a literal drift', () => {
  const h = createGoogleHarness();
  assert.equal(h.open(DRIVE).options.webPreferences.partition, require('../src/main/session.js').PARTITION);
});

test('appWindow: defaults - 1200x800, title "Google Chat Desktop", the app icon', () => {
  const h = createGoogleHarness();
  const { options } = h.open(DRIVE);
  assert.equal(options.width, 1200);
  assert.equal(options.height, 800);
  assert.equal(options.title, 'Google Chat Desktop');
  assert.equal(options.icon, ICON);
});

test('appWindow: a normal (non-hop) window is not created hidden', () => {
  const h = createGoogleHarness();
  assert.notEqual(h.open(DRIVE).options.show, false);
});

test('appWindow: nothing local is ever loaded (no loadFile), only the Google url', () => {
  const h = createGoogleHarness();
  const win = h.open(DRIVE);
  assert.equal(win.loadFileCalls, undefined);
  assert.equal(win.webContents.loadCalls.length, 1);
});

test('appWindow: will-prevent-unload is registered at creation, before any close attempt', () => {
  const h = createGoogleHarness();
  assert.equal(h.open(DRIVE).webContents.listenerCount('will-prevent-unload'), 1);
});

test('appWindow: a window-open handler is installed at creation', () => {
  const h = createGoogleHarness();
  assert.equal(typeof h.open(DRIVE).webContents.windowOpenHandler, 'function');
});

test('appWindow: getAppWindowForContents finds the window by its contents, null for others and after close', () => {
  const h = createGoogleHarness();
  const win = h.open(DRIVE);
  assert.equal(h.manager.getAppWindowForContents(win.webContents), win);
  assert.equal(h.manager.getAppWindowForContents({}), null);
  win.destroy();
  assert.equal(h.manager.getAppWindowForContents(win.webContents), null);
});

// --- registry, dedupe, fragment rule ----------------------------------------------------------------------------------

test('appWindow dedupe: the same link twice creates ONE window and focuses it the second time', () => {
  const h = createGoogleHarness();
  const win = h.open(DRIVE);
  const focusBefore = win.count('focus');
  h.manager.openGoogleAppWindow(DRIVE);
  assert.equal(h.BrowserWindow.instances.length, 1);
  assert.ok(win.count('focus') > focusBefore);
  assert.equal(win.webContents.loadCalls.length, 1);
});

test('appWindow dedupe: the registry entry is set synchronously - two quick calls, one window', () => {
  const h = createGoogleHarness();
  h.manager.openGoogleAppWindow(DOC);
  h.manager.openGoogleAppWindow(DOC);
  assert.equal(h.BrowserWindow.instances.length, 1);
});

test('appWindow dedupe: different documents get different windows (no cap, no reuse)', () => {
  const h = createGoogleHarness();
  h.open(DOC);
  h.open(DOC_2);
  h.open(DRIVE);
  assert.equal(h.BrowserWindow.instances.length, 3);
});

test('appWindow dedupe: a different query string is a different link', () => {
  const h = createGoogleHarness();
  h.open(`${DOC}?tab=t.0`);
  h.open(`${DOC}?tab=t.1`);
  assert.equal(h.BrowserWindow.instances.length, 2);
});

test('appWindow dedupe: the key ignores the fragment - a #heading link finds the existing window', () => {
  const h = createGoogleHarness();
  h.open(DOC);
  h.manager.openGoogleAppWindow(`${DOC}#heading=h.abc`);
  assert.equal(h.BrowserWindow.instances.length, 1);
});

test('appWindow dedupe: a minimized existing window is restored when its link is clicked again', () => {
  const h = createGoogleHarness();
  const win = h.open(DOC);
  win.minimized = true;
  h.manager.openGoogleAppWindow(DOC);
  assert.equal(win.count('restore'), 1);
});

test('appWindow registry: the entry is removed on closed - the same link then creates a fresh window', () => {
  const h = createGoogleHarness();
  h.open(DOC).destroy();
  h.manager.openGoogleAppWindow(DOC);
  assert.equal(h.BrowserWindow.instances.length, 2);
  assert.equal(h.win().destroyed, false);
});

test('appWindow fragment rule: a #h link to a window still on that page loads the FULL href and focuses; no new window', () => {
  const h = createGoogleHarness();
  const win = h.open(DOC);
  const focusBefore = win.count('focus');
  h.manager.openGoogleAppWindow(`${DOC}#heading=h.abc`);
  assert.equal(h.BrowserWindow.instances.length, 1);
  assert.deepEqual(win.webContents.loadCalls, [DOC, `${DOC}#heading=h.abc`]);
  assert.ok(win.count('focus') > focusBefore);
});

test('appWindow fragment rule: if the window has moved to another page, the link only focuses (never navigates away)', () => {
  const h = createGoogleHarness();
  const win = h.open(DOC);
  win.webContents.url = DOC_2;
  const focusBefore = win.count('focus');
  h.manager.openGoogleAppWindow(`${DOC}#heading=h.abc`);
  assert.deepEqual(win.webContents.loadCalls, [DOC]);
  assert.ok(win.count('focus') > focusBefore);
  assert.equal(h.BrowserWindow.instances.length, 1);
});

test('appWindow fragment rule: a link WITHOUT a fragment only focuses, even if the window sits on a #heading', () => {
  const h = createGoogleHarness();
  const win = h.open(DOC);
  win.webContents.url = `${DOC}#heading=h.abc`;
  h.manager.openGoogleAppWindow(DOC);
  assert.deepEqual(win.webContents.loadCalls, [DOC]);
});

// --- forms.gle entry hop (section 2) ---------------------------------------------------------------------------------------------

const HOP = { hop: true };
const didNavigate = (win, url) => {
  win.webContents.url = url;
  win.webContents.emit('did-navigate', makeEvent(), url, 200, 'OK');
};

test('hop: a forms.gle window is created hidden and loads the short url; nothing is shown or focused yet', () => {
  const h = createGoogleHarness();
  const win = h.open(FORM_SHORT, HOP);
  assert.equal(win.options.show, false);
  assert.deepEqual(win.webContents.loadCalls, [FORM_SHORT]);
  assert.equal(win.count('show'), 0);
  assert.equal(win.count('focus'), 0);
});

test('hop: a hop window still gets the full hardened options', () => {
  const h = createGoogleHarness();
  const { webPreferences } = h.open(FORM_SHORT, HOP).options;
  assert.equal(webPreferences.partition, h.PARTITION);
  assert.equal('preload' in webPreferences, false);
  assert.equal(webPreferences.sandbox, true);
});

test('hop: a will-redirect to a nav-list host is allowed but does NOT show the window yet (did-navigate decides)', () => {
  const h = createGoogleHarness();
  const win = h.open(FORM_SHORT, HOP);
  const event = win.webContents.navigate(FORM_FINAL, { type: 'will-redirect' });
  assert.equal(event.defaultPrevented, false);
  assert.equal(win.count('show'), 0);
  assert.equal(win.destroyed, false);
  assert.deepEqual(h.state.external, []);
});

test('hop: did-navigate onto a nav-list host (after the allowed redirect) shows the window', () => {
  const h = createGoogleHarness();
  const win = h.open(FORM_SHORT, HOP);
  win.webContents.navigate(FORM_FINAL, { type: 'will-redirect' });
  didNavigate(win, FORM_FINAL);
  assert.equal(win.count('show'), 1);
  assert.equal(win.destroyed, false);
  assert.deepEqual(h.state.external, []);
});

test('hop: did-navigate onto a nav-list host without any redirect event also shows the window', () => {
  const h = createGoogleHarness();
  const win = h.open(FORM_SHORT, HOP);
  didNavigate(win, FORM_FINAL);
  assert.equal(win.count('show'), 1);
});

test('hop: the decision is taken once - a later did-navigate does not show the window a second time', () => {
  const h = createGoogleHarness();
  const win = h.open(FORM_SHORT, HOP);
  didNavigate(win, FORM_FINAL);
  didNavigate(win, DOC);
  assert.equal(win.count('show'), 1);
});

test('hop: after the final landing the entry is re-keyed - the final form link again focuses the same window', () => {
  const h = createGoogleHarness();
  const win = h.open(FORM_SHORT, HOP);
  didNavigate(win, FORM_FINAL);
  const focusBefore = win.count('focus');
  h.manager.openGoogleAppWindow(FORM_FINAL);
  assert.equal(h.BrowserWindow.instances.length, 1);
  assert.ok(win.count('focus') > focusBefore);
});

test('hop: the final href already has a window - the new hidden window is destroyed and the existing one focused', () => {
  const h = createGoogleHarness();
  const existing = h.open(FORM_FINAL);
  const hidden = h.open(FORM_SHORT, HOP);
  assert.notEqual(existing, hidden);
  const focusBefore = existing.count('focus');
  didNavigate(hidden, FORM_FINAL);
  assert.equal(hidden.destroyed, true);
  assert.equal(hidden.count('show'), 0);
  assert.ok(existing.count('focus') > focusBefore);
  assert.equal(existing.destroyed, false);
  assert.deepEqual(h.state.external, []);
});

test('hop: a will-redirect to a non-nav-list target is PREVENTED, the hidden window destroyed and THAT target sent to the browser; never shown', () => {
  const h = createGoogleHarness();
  const win = h.open(FORM_SHORT, HOP);
  const event = win.webContents.navigate('https://example.org/landing', { type: 'will-redirect' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(win.destroyed, true);
  assert.equal(win.count('show'), 0);
  assert.deepEqual(h.state.external, ['https://example.org/landing']);
});

test('hop: a will-redirect to an unlisted Google host (Maps) is prevented, window destroyed, target to the browser', () => {
  const h = createGoogleHarness();
  const win = h.open(FORM_SHORT, HOP);
  const event = win.webContents.navigate('https://maps.google.com/x', { type: 'will-redirect' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(win.destroyed, true);
  assert.equal(win.count('show'), 0);
  assert.deepEqual(h.state.external, ['https://maps.google.com/x']);
});

test('hop: no-redirect did-navigate on a non-nav-list host destroys the window and sends the ORIGINAL url to the browser', () => {
  const h = createGoogleHarness();
  const win = h.open(FORM_SHORT, HOP);
  didNavigate(win, 'https://example.org/landing');
  assert.equal(win.destroyed, true);
  assert.equal(win.count('show'), 0);
  assert.deepEqual(h.state.external, [FORM_SHORT]);
});

test('hop: did-navigate on forms.gle itself (it answers itself) destroys the window and sends the original url to the browser', () => {
  const h = createGoogleHarness();
  const win = h.open(FORM_SHORT, HOP);
  didNavigate(win, 'https://forms.gle/other');
  assert.equal(win.destroyed, true);
  assert.equal(win.count('show'), 0);
  assert.deepEqual(h.state.external, [FORM_SHORT]);
});

test('hop: a load failure destroys the hidden window and sends the ORIGINAL url to the browser', () => {
  const h = createGoogleHarness();
  const win = h.open(FORM_SHORT, HOP);
  win.webContents.emit('did-fail-load', makeEvent(), -105, 'ERR_NAME_NOT_RESOLVED', FORM_SHORT, true);
  assert.equal(win.destroyed, true);
  assert.equal(win.count('show'), 0);
  assert.deepEqual(h.state.external, [FORM_SHORT]);
});

test('hop: no decision within 10 s destroys the hidden window and sends the original url to the browser', () => {
  const h = createGoogleHarness();
  const win = h.open(FORM_SHORT, HOP);
  h.clock.tick(9999);
  assert.equal(win.destroyed, false);
  h.clock.tick(1);
  assert.equal(win.destroyed, true);
  assert.equal(win.count('show'), 0);
  assert.deepEqual(h.state.external, [FORM_SHORT]);
});

test('hop: the decision clears the 10 s timer (no stray timer, no late destroy)', () => {
  const h = createGoogleHarness();
  const win = h.open(FORM_SHORT, HOP);
  didNavigate(win, FORM_FINAL);
  assert.equal(h.clock.pending(), 0);
  h.clock.tick(20000);
  assert.equal(win.destroyed, false);
});

test('hop: after a failed hop the registry is clear - the same short link creates a fresh window', () => {
  const h = createGoogleHarness();
  h.open(FORM_SHORT, HOP);
  h.clock.tick(10000);
  h.manager.openGoogleAppWindow(FORM_SHORT, HOP);
  assert.equal(h.BrowserWindow.instances.length, 2);
});

test('hop coalescing: a second click while pending creates no window and never shows or focuses the hidden one', () => {
  const h = createGoogleHarness();
  const win = h.open(FORM_SHORT, HOP);
  h.manager.openGoogleAppWindow(FORM_SHORT, HOP);
  h.manager.openGoogleAppWindow(FORM_SHORT, HOP);
  assert.equal(h.BrowserWindow.instances.length, 1);
  assert.equal(win.count('show'), 0);
  assert.equal(win.count('focus'), 0);
});

test('hop coalescing: the registry entry exists synchronously, keyed by the requested href', () => {
  const h = createGoogleHarness();
  h.manager.openGoogleAppWindow(FORM_SHORT, HOP);
  h.manager.openGoogleAppWindow(FORM_SHORT, HOP);
  assert.equal(h.BrowserWindow.instances.length, 1);
});

test('hop coalescing: once the hop resolved, a click on the final link behaves normally (focus, no new window)', () => {
  const h = createGoogleHarness();
  const win = h.open(FORM_SHORT, HOP);
  h.manager.openGoogleAppWindow(FORM_SHORT, HOP);
  didNavigate(win, FORM_FINAL);
  h.manager.openGoogleAppWindow(FORM_FINAL);
  assert.equal(h.BrowserWindow.instances.length, 1);
  assert.ok(win.count('focus') >= 1);
});

test('hop coalescing: once the entry is removed (failed hop), a new click starts a fresh hop', () => {
  const h = createGoogleHarness();
  const first = h.open(FORM_SHORT, HOP);
  first.webContents.emit('did-fail-load', makeEvent(), -105, 'ERR', FORM_SHORT, true);
  const second = h.open(FORM_SHORT, HOP);
  assert.notEqual(first, second);
  assert.equal(second.options.show, false);
});

test('hop from inside an app window: a will-navigate to forms.gle is prevented, never navigated in place, never sent to the browser; a hidden hop window is created', () => {
  const h = createGoogleHarness();
  const win = h.open(DOC);
  const event = win.webContents.navigate(FORM_SHORT, { type: 'will-navigate' });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(h.state.external, []);
  assert.equal(h.BrowserWindow.instances.length, 2);
  assert.equal(h.win().options.show, false);
  assert.deepEqual(h.win().webContents.loadCalls, [FORM_SHORT]);
  assert.deepEqual(win.webContents.loadCalls, [DOC], 'the source window did not navigate');
});

test('hop from inside an app window: a popup to forms.gle uses the same hop through the factory (deny, hidden hardened window, no browser)', () => {
  const h = createGoogleHarness();
  const win = h.open(DOC);
  assert.deepEqual(win.webContents.windowOpen(FORM_SHORT), { action: 'deny' });
  assert.deepEqual(h.state.external, []);
  assert.equal(h.BrowserWindow.instances.length, 2);
  const hidden = h.win();
  assert.equal(hidden.options.show, false);
  assert.equal(hidden.options.webPreferences.partition, h.PARTITION);
  assert.equal('preload' in hidden.options.webPreferences, false);
});

// --- empty-window auto-close (section 2) -------------------------------------------------------------------------------------------

const DRIVE_UC = 'https://drive.google.com/uc?export=download&id=1';

test('auto-close: a window that never displayed a page whose only navigation became a download is destroyed when the download ends', () => {
  const h = createGoogleHarness();
  const win = h.open(DRIVE_UC);
  win.webContents.navigate(USERCONTENT_DL, { type: 'will-redirect' });
  assert.equal(h.manager.closeIfEmpty(win.webContents), true);
  assert.equal(win.destroyed, true);
});

test('auto-close: the initial-load hop from the requested drive uc url is allowed (no prevent, no browser) - source is the requested url', () => {
  const h = createGoogleHarness();
  const win = h.open(DRIVE_UC);
  win.webContents.url = '';
  const event = win.webContents.navigate(USERCONTENT_DL, { type: 'will-redirect' });
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(h.state.external, []);
});

test('auto-close: a window that displayed a page (did-navigate) is NEVER auto-closed', () => {
  const h = createGoogleHarness();
  const win = h.open(DRIVE);
  didNavigate(win, DRIVE);
  assert.equal(h.manager.closeIfEmpty(win.webContents), false);
  assert.equal(win.destroyed, false);
});

test('auto-close: a window that displayed a page and later started a download hop is still not auto-closed', () => {
  const h = createGoogleHarness();
  const win = h.open(DRIVE);
  didNavigate(win, DRIVE);
  win.webContents.navigate(USERCONTENT_DL, { type: 'will-redirect' });
  assert.equal(h.manager.closeIfEmpty(win.webContents), false);
  assert.equal(win.destroyed, false);
});

test('auto-close: unknown contents and an already destroyed window are false and never throw', () => {
  const h = createGoogleHarness();
  const win = h.open(DRIVE_UC);
  assert.equal(h.manager.closeIfEmpty({}), false);
  win.destroy();
  assert.doesNotThrow(() => h.manager.closeIfEmpty(win.webContents));
});

test('auto-close: the registry entry goes with the closed window - the same link then creates a fresh one', () => {
  const h = createGoogleHarness();
  const win = h.open(DRIVE_UC);
  h.manager.closeIfEmpty(win.webContents);
  h.manager.openGoogleAppWindow(DRIVE_UC);
  assert.equal(h.BrowserWindow.instances.length, 2);
});

// --- initial load routed away: no blank window left behind (section 2 "Blank window after a routed-away initial load") ------------

const MARKETING = 'https://workspace.google.com/products/calendar/';

for (const type of ['will-redirect', 'will-navigate']) {
  test(`initial load ${type}: a never-displayed window whose navigation is routed to the browser is destroyed, the target still goes to the browser`, () => {
    const h = createGoogleHarness();
    const win = h.open('https://calendar.google.com/event?eid=1');
    const event = win.webContents.navigate(MARKETING, { type });
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(h.state.external, [MARKETING]);
    assert.equal(win.destroyed, true);
  });
}

test('initial load: the registry entry goes with the destroyed window - the same link then creates a fresh one', () => {
  const h = createGoogleHarness();
  const link = 'https://calendar.google.com/event?eid=1';
  const win = h.open(link);
  win.webContents.navigate(MARKETING, { type: 'will-redirect' });
  h.manager.openGoogleAppWindow(link);
  assert.equal(h.BrowserWindow.instances.length, 2);
  assert.equal(h.win().destroyed, false);
});

test('initial load: a never-displayed window routed to the call window (Meet) is destroyed too', () => {
  const h = createGoogleHarness();
  const win = h.open(DOC);
  win.webContents.navigate('https://meet.google.com/abc-defg-hij', { type: 'will-redirect' });
  assert.deepEqual(h.state.callWindow, ['https://meet.google.com/abc-defg-hij']);
  assert.equal(win.destroyed, true);
});

test('initial load: a never-displayed window is NOT destroyed by an allowed navigation or an allowed download hop', () => {
  const h = createGoogleHarness();
  const win = h.open(DRIVE_UC);
  win.webContents.navigate(USERCONTENT_DL, { type: 'will-redirect' });
  win.webContents.navigate('https://accounts.google.com/signin/v2', { type: 'will-redirect' });
  assert.equal(win.destroyed, false);
});

test('initial load: a sub-frame navigation never destroys the window', () => {
  const h = createGoogleHarness();
  const win = h.open(DOC);
  win.webContents.navigate(MARKETING, { type: 'will-navigate', isMainFrame: false });
  assert.equal(win.destroyed, false);
});

test('initial load: a window that displayed an allowed page is NEVER auto-closed when a later navigation is routed away', () => {
  const h = createGoogleHarness();
  const win = h.open(DOC);
  didNavigate(win, DOC);
  win.webContents.navigate(MARKETING, { type: 'will-navigate' });
  win.webContents.navigate('https://meet.google.com/abc-defg-hij', { type: 'will-redirect' });
  assert.deepEqual(h.state.external, [MARKETING]);
  assert.equal(win.destroyed, false);
});

test('initial load: a popup routed to the browser never destroys the window that opened it', () => {
  const h = createGoogleHarness();
  const win = h.open(DOC);
  win.webContents.windowOpen(MARKETING);
  assert.deepEqual(h.state.external, [MARKETING]);
  assert.equal(win.destroyed, false);
});

// --- navigation (main frame only): will-navigate AND will-redirect -----------------------------------------------------------

for (const type of ['will-navigate', 'will-redirect']) {
  test(`navigation ${type}: nav-list hosts and accounts.google.com stay in the window`, () => {
    const h = createGoogleHarness();
    const win = h.open(DOC);
    for (const url of [DRIVE, DOC_2, 'https://calendar.google.com/x', 'https://accounts.google.com/signin/v2', 'https://DOCS.google.com/x']) {
      assert.equal(win.webContents.navigate(url, { type }).defaultPrevented, false, url);
    }
    assert.deepEqual(h.state.external, []);
  });

  test(`navigation ${type}: an unlisted Google host (Maps) is prevented and sent to the browser stub`, () => {
    const h = createGoogleHarness();
    const win = h.open(DOC);
    assert.equal(win.webContents.navigate('https://maps.google.com/x', { type }).defaultPrevented, true);
    assert.deepEqual(h.state.external, ['https://maps.google.com/x']);
  });

  test(`navigation ${type}: a *.googleusercontent.com main-frame navigation is prevented and sent to the browser`, () => {
    const h = createGoogleHarness();
    const win = h.open(DOC);
    for (const url of ['https://lh3.googleusercontent.com/x', 'https://doc-0g-1k-docs.googleusercontent.com/x']) {
      assert.equal(win.webContents.navigate(url, { type }).defaultPrevented, true, url);
    }
    assert.equal(h.state.external.length, 2);
  });

  test(`navigation ${type}: a lookalike, an http or a port variant of a listed host is prevented and sent to the browser`, () => {
    const h = createGoogleHarness();
    const win = h.open(DOC);
    for (const url of ['https://docs.google.com.evil.example/x', 'http://docs.google.com/x', 'https://docs.google.com:8443/x']) {
      assert.equal(win.webContents.navigate(url, { type }).defaultPrevented, true, url);
    }
    assert.equal(h.state.external.length, 3);
  });

  test(`navigation ${type}: a Meet link is prevented and opens the call window stub`, () => {
    const h = createGoogleHarness();
    const win = h.open(DOC);
    const event = win.webContents.navigate('https://meet.google.com/abc-defg-hij', { type });
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(h.state.callWindow, ['https://meet.google.com/abc-defg-hij']);
    assert.deepEqual(h.state.external, []);
  });

  test(`navigation ${type}: a Chat conversation is prevented and goes to the main-window stub, never the browser`, () => {
    const h = createGoogleHarness();
    const win = h.open(DOC);
    const event = win.webContents.navigate('https://chat.google.com/room/AAAA', { type });
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(h.state.mainWindow, ['https://chat.google.com/room/AAAA']);
    assert.deepEqual(h.state.external, []);
    assert.equal(h.BrowserWindow.instances.length, 1, 'an app window never renders Chat a second time');
  });

  test(`navigation ${type}: a Chat attachment shape is prevented and goes to the browser - an app window never drives a main-window download`, () => {
    const h = createGoogleHarness();
    const win = h.open(DOC);
    const event = win.webContents.navigate('https://chat.google.com/api/get_attachment_url?x=1', { type });
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(h.state.external, ['https://chat.google.com/api/get_attachment_url?x=1']);
    assert.deepEqual(h.state.mainDownloads, []);
    assert.deepEqual(h.state.mainWindow, []);
  });

  test(`navigation ${type}: an unknown Chat shape goes to the browser`, () => {
    const h = createGoogleHarness();
    const win = h.open(DOC);
    win.webContents.navigate('https://chat.google.com/popout/room/AAAA', { type });
    assert.deepEqual(h.state.external, ['https://chat.google.com/popout/room/AAAA']);
    assert.deepEqual(h.state.mainWindow, []);
  });

  test(`navigation ${type}: a sub-frame navigation is not restricted (no preventDefault, nothing routed)`, () => {
    const h = createGoogleHarness();
    const win = h.open(DOC);
    const event = win.webContents.navigate('https://lh3.googleusercontent.com/x', { type, isMainFrame: false });
    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(h.state.external, []);
  });

  test(`navigation ${type}: a javascript: or garbage target is prevented and dropped, never opened`, () => {
    const h = createGoogleHarness();
    const win = h.open(DOC);
    assert.equal(win.webContents.navigate('javascript:alert(1)', { type }).defaultPrevented, true);
    assert.deepEqual(h.state.external, []);
  });
}

// --- download hop on the main frame ----------------------------------------------------------------------------------------------

test('download hop: a will-redirect to usercontent /download from a drive page stays in the window (no prevent, no browser)', () => {
  const h = createGoogleHarness();
  const win = h.open(DRIVE);
  const event = win.webContents.navigate(USERCONTENT_DL, { type: 'will-redirect' });
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(h.state.external, []);
});

test('download hop: a will-redirect to usercontent /download from a docs page stays in the window', () => {
  const h = createGoogleHarness();
  const win = h.open(DOC);
  assert.equal(win.webContents.navigate(USERCONTENT_DL, { type: 'will-redirect' }).defaultPrevented, false);
});

test('download hop: the SAME url as a direct will-navigate from a drive page is prevented and sent to the browser', () => {
  const h = createGoogleHarness();
  const win = h.open(DRIVE);
  const event = win.webContents.navigate(USERCONTENT_DL, { type: 'will-navigate' });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(h.state.external, [USERCONTENT_DL]);
});

test('download hop: a redirect to usercontent from a calendar page is refused (hop only from drive/docs)', () => {
  const h = createGoogleHarness();
  const win = h.open('https://calendar.google.com/event?eid=1');
  assert.equal(win.webContents.navigate(USERCONTENT_DL, { type: 'will-redirect' }).defaultPrevented, true);
});

test('download hop: a redirect to a usercontent path other than /download is refused', () => {
  const h = createGoogleHarness();
  const win = h.open(DRIVE);
  assert.equal(
    win.webContents.navigate('https://drive.usercontent.google.com/other?id=1', { type: 'will-redirect' }).defaultPrevented,
    true
  );
});

test('interstitial: after the hop lands on usercontent /download, the "Download anyway" submit to /download&confirm stays', () => {
  const h = createGoogleHarness();
  const win = h.open(DRIVE);
  win.webContents.navigate(USERCONTENT_DL, { type: 'will-redirect' });
  win.webContents.url = USERCONTENT_DL;
  const confirm = `${USERCONTENT_DL}&confirm=t&uuid=u`;
  assert.equal(win.webContents.navigate(confirm, { type: 'will-navigate' }).defaultPrevented, false);
  assert.deepEqual(h.state.external, []);
});

test('interstitial: from that page any other path or host is prevented and routed to the browser', () => {
  const h = createGoogleHarness();
  const win = h.open(DRIVE);
  win.webContents.navigate(USERCONTENT_DL, { type: 'will-redirect' });
  win.webContents.url = USERCONTENT_DL;
  assert.equal(
    win.webContents.navigate('https://drive.usercontent.google.com/other?id=1', { type: 'will-navigate' }).defaultPrevented,
    true
  );
  assert.equal(win.webContents.navigate('https://example.org/', { type: 'will-navigate' }).defaultPrevented, true);
  assert.deepEqual(h.state.external, ['https://drive.usercontent.google.com/other?id=1', 'https://example.org/']);
});

test('interstitial: from that page a navigation back to a nav-list host is allowed', () => {
  const h = createGoogleHarness();
  const win = h.open(DRIVE);
  win.webContents.navigate(USERCONTENT_DL, { type: 'will-redirect' });
  win.webContents.url = USERCONTENT_DL;
  assert.equal(win.webContents.navigate(DOC, { type: 'will-navigate' }).defaultPrevented, false);
});

// --- popups: always deny, recreate through the factory ---------------------------------------------------------------------------------

test('popup: window.open always returns { action: "deny" }, whatever the target', () => {
  const h = createGoogleHarness();
  const win = h.open(DOC);
  for (const url of [DRIVE, 'https://accounts.google.com/x', USERCONTENT_DL, 'https://evil.example/', 'https://chat.google.com/room/A', 'https://meet.google.com/abc-defg-hij', 'garbage', undefined]) {
    assert.deepEqual(win.webContents.windowOpen(url), { action: 'deny' }, String(url));
  }
});

test('popup: a popup to a nav-list host creates a NEW app window through the factory with the hardened options', () => {
  const h = createGoogleHarness();
  const win = h.open(DOC);
  win.webContents.windowOpen(DRIVE);
  assert.equal(h.BrowserWindow.instances.length, 2);
  const popup = h.win();
  assert.deepEqual(popup.webContents.loadCalls, [DRIVE]);
  assert.deepEqual(popup.options.webPreferences, win.options.webPreferences);
  assert.equal('preload' in popup.options.webPreferences, false);
});

test('popup: a popup to an already-open link focuses the existing window (dedupe applies)', () => {
  const h = createGoogleHarness();
  const win = h.open(DOC);
  win.webContents.windowOpen(DOC);
  assert.equal(h.BrowserWindow.instances.length, 1);
});

test('popup: a popup to accounts.google.com is allowed as an app window (re-authentication)', () => {
  const h = createGoogleHarness();
  const win = h.open(DOC);
  win.webContents.windowOpen('https://accounts.google.com/signin/v2');
  assert.equal(h.BrowserWindow.instances.length, 2);
  assert.equal(h.win().options.webPreferences.partition, h.PARTITION);
  assert.deepEqual(h.state.external, []);
});

test('popup: a popup to drive.usercontent.google.com goes to the browser stub, never an app window', () => {
  const h = createGoogleHarness();
  const win = h.open(DRIVE);
  win.webContents.windowOpen(USERCONTENT_DL);
  assert.equal(h.BrowserWindow.instances.length, 1);
  assert.deepEqual(h.state.external, [USERCONTENT_DL]);
});

test('popup: a popup to an evil or unlisted host goes to the browser stub, no window', () => {
  const h = createGoogleHarness();
  const win = h.open(DOC);
  win.webContents.windowOpen('https://evil.example/');
  win.webContents.windowOpen('https://maps.google.com/');
  assert.equal(h.BrowserWindow.instances.length, 1);
  assert.deepEqual(h.state.external, ['https://evil.example/', 'https://maps.google.com/']);
});

test('popup: a Meet popup goes to the call-window stub; a Chat conversation popup to the main-window stub', () => {
  const h = createGoogleHarness();
  const win = h.open(DOC);
  win.webContents.windowOpen('https://meet.google.com/abc-defg-hij');
  win.webContents.windowOpen('https://chat.google.com/room/AAAA');
  assert.deepEqual(h.state.callWindow, ['https://meet.google.com/abc-defg-hij']);
  assert.deepEqual(h.state.mainWindow, ['https://chat.google.com/room/AAAA']);
  assert.deepEqual(h.state.external, []);
  assert.equal(h.BrowserWindow.instances.length, 1);
});

test('popup: a Chat attachment popup from an app window goes to the browser, never to downloadURL of the main window', () => {
  const h = createGoogleHarness();
  const win = h.open(DOC);
  win.webContents.windowOpen('https://chat.google.com/api/get_attachment_url?x=1');
  assert.deepEqual(h.state.external, ['https://chat.google.com/api/get_attachment_url?x=1']);
  assert.deepEqual(h.state.mainDownloads, []);
});

test('popup: a popup is never a raw BrowserWindow Electron creates - no allow decision is ever returned', () => {
  const h = createGoogleHarness();
  const win = h.open(DOC);
  const decisions = [DRIVE, 'https://accounts.google.com/x', 'https://evil.example/'].map((u) => win.webContents.windowOpen(u));
  assert.equal(decisions.some((d) => d.action !== 'deny' || 'overrideBrowserWindowOptions' in d), false);
});

// --- close never quits, never hides ------------------------------------------------------------------------------------------------------

test('close: closing an app window destroys it (never hides it) and the manager has no quit path', () => {
  const h = createGoogleHarness({ pageBehavior: 'none' });
  const win = h.open(DOC);
  win.close();
  assert.equal(win.destroyed, true);
  assert.equal(win.count('hide'), 0);
});

test('close: closing one app window leaves the others untouched', () => {
  const h = createGoogleHarness({ pageBehavior: 'none' });
  const a = h.open(DOC);
  const b = h.open(DRIVE);
  a.close();
  assert.equal(b.destroyed, false);
});

test('logging: only scheme and outcome - no url, document id or host appears in any log line', () => {
  const h = createGoogleHarness();
  const win = h.open(DRIVE);
  win.webContents.navigate('https://maps.google.com/secret-place-xyz', { type: 'will-navigate' });
  win.webContents.windowOpen('https://evil.example/secret-popup-xyz');
  const logged = JSON.stringify(h.state.logs);
  for (const secret of ['1AekcCfF1_XISs', 'secret-place-xyz', 'secret-popup-xyz', 'maps.google.com', 'evil.example']) {
    assert.equal(logged.includes(secret), false, secret);
  }
});
