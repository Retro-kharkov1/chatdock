'use strict';

// UI-05 / FR-18, docs/architecture/smart-copy.md section 5 and 8 (row "Wiring"). The wiring pins are RED until
// the feature is wired; the "not bound" pins are green today and must stay green.
//
// CONTRACT ASSUMED:
//   * createGoogleAppWindowManager accepts an OPTIONAL `bindSmartCopy(webContents)` dependency and calls it once
//     per created window (hop windows included), next to bindEditShortcuts(contents). Absent means today's behaviour.
//   * index.js requires './smartCopy' and './copyHint', binds the main-window variant (bindSmartCopyMain) and passes
//     the app-window variant (bindSmartCopyApp) to the Google app window manager, and destroys the hint at quit.
//   * callWindow.js, settingsWindow.js, pickerWindow.js and helpWindow.js never reference the binder.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/pending');
const { createFakeBrowserWindowClass, createManualClock, createDialogFake } = require('./helpers/electronFakes');

const DOC = 'https://docs.google.com/document/d/1/edit';
const DRIVE = 'https://drive.google.com/drive/my-drive';

function source(rel) {
  return fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');
}

function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function build(extra = {}) {
  const BrowserWindow = createFakeBrowserWindowClass();
  const dialog = createDialogFake();
  const external = [];
  const manager = load('googleAppWindow.js').createGoogleAppWindowManager({
    BrowserWindow,
    getRouter: () => ({ route: () => {} }),
    isQuitting: () => false,
    showMessageBox: dialog.showMessageBox,
    openExternal: (url) => external.push(url),
    timers: createManualClock(),
    log: () => {},
    ...extra,
  });
  return { BrowserWindow, manager, external };
}

test('googleAppWindow: bindSmartCopy is called once per created window with that window\'s webContents', () => {
  const calls = [];
  const t = build({ bindSmartCopy: (contents) => calls.push(contents) });
  t.manager.openGoogleAppWindow(DOC);
  t.manager.openGoogleAppWindow(DRIVE);
  assert.equal(t.BrowserWindow.instances.length, 2);
  assert.deepEqual(calls, t.BrowserWindow.instances.map((w) => w.webContents));
});

test('googleAppWindow: a repeated open of the same link (dedupe) does not bind a second time', () => {
  const calls = [];
  const t = build({ bindSmartCopy: (contents) => calls.push(contents) });
  t.manager.openGoogleAppWindow(DOC);
  t.manager.openGoogleAppWindow(DOC);
  assert.equal(calls.length, 1);
});

test('googleAppWindow: a hidden forms.gle hop window is bound too', () => {
  const calls = [];
  const t = build({ bindSmartCopy: (contents) => calls.push(contents) });
  t.manager.openGoogleAppWindow('https://forms.gle/abc123', { hop: true });
  assert.equal(t.BrowserWindow.instances.length, 1);
  assert.deepEqual(calls, [t.BrowserWindow.instances[0].webContents]);
});

test('googleAppWindow: without bindSmartCopy it works exactly as before', () => {
  const t = build();
  assert.doesNotThrow(() => t.manager.openGoogleAppWindow(DOC));
  assert.equal(t.BrowserWindow.instances.length, 1);
  assert.equal('preload' in t.BrowserWindow.instances[0].options.webPreferences, false);
});

test('source pin: googleAppWindow.js calls bindSmartCopy next to bindEditShortcuts and still names no preload', () => {
  const code = stripComments(source('main/googleAppWindow.js'));
  assert.match(code, /bindSmartCopy\s*\(/);
  assert.equal(/\bpreload\b/.test(code), false);
});

test('source pin: index.js wires the main-window binder, the app-window binder and the hint manager', () => {
  const code = stripComments(source('main/index.js'));
  assert.match(code, /require\(['"]\.\/smartCopy(\.js)?['"]\)/);
  assert.match(code, /require\(['"]\.\/copyHint(\.js)?['"]\)/);
  assert.match(code, /bindSmartCopyMain\s*\(/);
  assert.match(code, /bindSmartCopyApp/);
});

test('source pin: the Meet call window, Settings, picker and Help windows never reference the binder or the hint', () => {
  for (const file of ['callWindow.js', 'settingsWindow.js', 'pickerWindow.js', 'helpWindow.js']) {
    const full = path.join(__dirname, '..', 'src', 'main', file);
    if (!fs.existsSync(full)) continue;
    const code = stripComments(fs.readFileSync(full, 'utf8'));
    assert.equal(/smartCopy|bindSmartCopy|copyHint|smartcopy:/i.test(code), false, file);
  }
});

test('source pin: only the main-window preload names the smartcopy channel (settings and picker preloads do not)', () => {
  for (const file of ['settingsPreload.js', 'pickerPreload.js', 'serviceWorkerPreload.js']) {
    const code = stripComments(source(path.join('preload', file)));
    assert.equal(/smartcopy/i.test(code), false, file);
  }
});

test('source pin: the smartcopy:signal channel is not registered anywhere but smartCopy.js', () => {
  const dir = path.join(__dirname, '..', 'src', 'main');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'smartCopy.js')) {
    const code = stripComments(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.equal(/smartcopy:signal/.test(code), false, file);
  }
});
