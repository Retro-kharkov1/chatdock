'use strict';

// UI-06: the in-app Help window (src/main/helpWindow.js). Stubbed Electron, same style as pickerWindow.test.js.
// Pattern: app-owned, single instance, local bundled HTML only, sandbox + contextIsolation, no
// nodeIntegration, NO preload, its own non-persistent partition with every permission denied; navigation
// inside denied (only in-page #anchors pass); http/https/mailto links go to the system browser; closing
// never quits.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createFakeBrowserWindowClass } = require('./helpers/electronFakes');
const hw = require('../src/main/helpWindow.js');
const { isOpenableExternalScheme } = require('../src/main/meetLink.js');

const HTML = path.join(__dirname, '..', 'src', 'renderer', 'help', 'help.html');
const HTML_URL = pathToFileURL(HTML).href;

function setup() {
  const Base = createFakeBrowserWindowClass();
  class Win extends Base {
    constructor(o) {
      super(o);
      this.menu = 'unset';
    }
    setMenu(m) { this.menu = m; }
  }
  Win.instances = Base.instances;
  const handlers = {};
  const partitions = [];
  const session = {
    fromPartition: (name) => {
      partitions.push(name);
      return {
        setPermissionRequestHandler: (fn) => { handlers.request = fn; },
        setPermissionCheckHandler: (fn) => { handlers.check = fn; },
      };
    },
  };
  const opened = [];
  const logs = [];
  const controller = hw.createHelpWindowController({
    BrowserWindow: Win,
    session,
    htmlPath: HTML,
    iconPath: 'icon.png',
    openExternal: (u) => opened.push(u),
    isOpenableExternalScheme,
    log: (...a) => logs.push(a),
  });
  return { controller, Win, handlers, partitions, opened, logs };
}

test('options: sandbox, contextIsolation, no nodeIntegration, webSecurity, no webview, NO preload, own non-persistent partition', () => {
  const o = hw.buildHelpWindowOptions({ iconPath: 'i.png' });
  const wp = o.webPreferences;
  assert.equal(wp.contextIsolation, true);
  assert.equal(wp.nodeIntegration, false);
  assert.equal(wp.sandbox, true);
  assert.equal(wp.webSecurity, true);
  assert.equal(wp.webviewTag, false);
  assert.equal('preload' in wp, false);
  assert.equal(wp.partition, hw.HELP_PARTITION);
  assert.doesNotMatch(wp.partition, /^persist:/);
});

test('options: resizable, sensible size, not modal and no parent (a normal window)', () => {
  const o = hw.buildHelpWindowOptions({});
  assert.equal(o.resizable, true);
  assert.ok(o.width >= 600 && o.height >= 500);
  assert.ok(o.minWidth > 0 && o.minHeight > 0);
  assert.equal(o.modal, undefined);
  assert.equal(o.parent, undefined);
});

test('permissions: every request denied, every check false, on the partition the window uses', () => {
  const { controller, handlers, partitions, Win } = setup();
  controller.open();
  assert.deepEqual(partitions, [hw.HELP_PARTITION]);
  assert.equal(Win.instances[0].options.webPreferences.partition, hw.HELP_PARTITION);
  for (const permission of ['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen', 'unknown']) {
    let granted = 'unset';
    handlers.request({}, permission, (v) => { granted = v; }, {});
    assert.equal(granted, false, permission);
    assert.equal(handlers.check(null, permission, HTML_URL, {}), false, permission);
  }
});

test('open: loads the local help.html with loadFile (never loadURL), menu removed', () => {
  const { controller, Win } = setup();
  const win = controller.open();
  assert.deepEqual(win.loadFileCalls, [HTML]);
  assert.deepEqual(win.webContents.loadCalls, []);
  assert.equal(win.menu, null);
  assert.equal(Win.instances.length, 1);
});

test('single instance: opening again focuses the existing window, restores it if minimized, creates no second', () => {
  const { controller, Win } = setup();
  const first = controller.open();
  first.minimized = true;
  const second = controller.open();
  assert.equal(second, first);
  assert.equal(Win.instances.length, 1);
  assert.equal(first.minimized, false);
  assert.ok(first.count('focus') >= 1);
  assert.ok(first.count('show') >= 1);
});

test('after it is closed, open creates a fresh window', () => {
  const { controller, Win } = setup();
  const first = controller.open();
  first.close();
  assert.equal(controller.isOpen(), false);
  const again = controller.open();
  assert.notEqual(again, first);
  assert.equal(Win.instances.length, 2);
});

test('closing never quits: the controller has no quit path and X just destroys the window', () => {
  const { controller } = setup();
  const win = controller.open();
  win.close();
  assert.equal(win.destroyed, true);
  assert.equal(controller.getWindow(), null);
  assert.equal(Object.keys(controller).some((k) => /quit|exit/i.test(k)), false);
});

test('Escape closes the Help window (only Escape, only on keyDown)', () => {
  const { controller } = setup();
  const win = controller.open();
  const send = (input) => {
    const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    win.webContents.emit('before-input-event', ev, input);
    return ev;
  };
  send({ type: 'keyDown', key: 'a' });
  send({ type: 'keyUp', key: 'Escape' });
  assert.equal(win.destroyed, false);
  const ev = send({ type: 'keyDown', key: 'Escape' });
  assert.equal(ev.defaultPrevented, true);
  assert.equal(win.destroyed, true);
});

test('navigation: an in-page #anchor is allowed (not prevented, nothing opened)', () => {
  const { controller, opened } = setup();
  const win = controller.open();
  const ev = win.webContents.navigate(HTML_URL + '#notifications');
  assert.equal(ev.defaultPrevented, false);
  assert.deepEqual(opened, []);
});

test('navigation: an external http/https/mailto link is prevented and goes to the system browser', () => {
  const { controller, opened } = setup();
  const win = controller.open();
  for (const url of ['https://example.com/a', 'http://example.com/', 'mailto:someone@example.com']) {
    const ev = win.webContents.navigate(url);
    assert.equal(ev.defaultPrevented, true, url);
  }
  assert.deepEqual(opened, ['https://example.com/a', 'http://example.com/', 'mailto:someone@example.com']);
});

test('navigation: anything else is prevented and opens nothing (other file, javascript:, ms-settings:, junk)', () => {
  const { controller, opened } = setup();
  const win = controller.open();
  const other = pathToFileURL(path.join(__dirname, 'x.html')).href;
  for (const url of ['file:///C:/Windows/win.ini', other, 'javascript:alert(1)', 'ms-settings:privacy', 'about:blank', '']) {
    const ev = win.webContents.navigate(url);
    assert.equal(ev.defaultPrevented, true, url);
  }
  assert.deepEqual(opened, []);
});

test('navigation: sub-frame navigation is routed the same way and redirects are always prevented', () => {
  const { controller, opened } = setup();
  const win = controller.open();
  const frame = win.webContents.navigate('https://example.com/', { type: 'will-frame-navigate', isMainFrame: false });
  assert.equal(frame.defaultPrevented, true);
  const redirect = win.webContents.navigate(HTML_URL + '#x', { type: 'will-redirect' });
  assert.equal(redirect.defaultPrevented, true);
  assert.deepEqual(opened, ['https://example.com/']);
});

test('popups: always denied; http/https/mailto targets go to the system browser, others are dropped', () => {
  const { controller, opened } = setup();
  const win = controller.open();
  assert.deepEqual(win.webContents.windowOpen('https://example.com/x'), { action: 'deny' });
  assert.deepEqual(win.webContents.windowOpen('mailto:a@b.c'), { action: 'deny' });
  assert.deepEqual(win.webContents.windowOpen('file:///etc/passwd'), { action: 'deny' });
  assert.deepEqual(win.webContents.windowOpen('javascript:1'), { action: 'deny' });
  assert.deepEqual(opened, ['https://example.com/x', 'mailto:a@b.c']);
});

test('decideHelpNavigation: decisions', () => {
  const d = (u) => hw.decideHelpNavigation(u, HTML_URL, isOpenableExternalScheme);
  assert.equal(d(HTML_URL), 'anchor');
  assert.equal(d(HTML_URL + '#top'), 'anchor');
  assert.equal(d('https://x.test/'), 'external');
  assert.equal(d('file:///other.html'), 'deny');
  assert.equal(d(undefined), 'deny');
});
