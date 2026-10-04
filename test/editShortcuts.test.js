'use strict';

// Clipboard/undo accelerators for windows with no application menu (Menu.setApplicationMenu(null) removes the
// Edit-role routing on Windows/Linux). docs/architecture/tray-lifecycle.md "Application menu suppression" (main
// window) and docs/architecture/google-app-windows.md section 4 "Keyboard shortcuts" (app windows). The main
// window has Ctrl/Cmd + C X V A Z and Shift+Z (redo); no Ctrl+Y, so none is added here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createGoogleHarness } = require('./helpers/googleAppWindowHarness');
const { makeEvent } = require('./helpers/electronFakes');
const { bindEditShortcuts } = require('../src/main/editShortcuts');

const DOC = 'https://docs.google.com/document/d/1/edit';

function spy(wc) {
  wc.done = [];
  for (const name of ['copy', 'cut', 'paste', 'selectAll', 'undo', 'redo']) wc[name] = () => wc.done.push(name);
  return wc;
}

function press(wc, input) {
  const event = makeEvent();
  wc.emit('before-input-event', event, { type: 'keyDown', control: false, meta: false, shift: false, key: '', ...input });
  return event;
}

const CASES = [
  [{ control: true, key: 'c' }, 'copy'],
  [{ control: true, key: 'x' }, 'cut'],
  [{ control: true, key: 'v' }, 'paste'],
  [{ control: true, key: 'a' }, 'selectAll'],
  [{ control: true, key: 'z' }, 'undo'],
  [{ control: true, shift: true, key: 'z' }, 'redo'],
  [{ control: true, shift: true, key: 'Z' }, 'redo'],
  [{ meta: true, key: 'v' }, 'paste'],
];

test('bindEditShortcuts: each accelerator calls the matching edit command and is consumed', () => {
  for (const [input, expected] of CASES) {
    const wc = spy(new EventEmitter());
    bindEditShortcuts(wc);
    const event = press(wc, input);
    assert.deepEqual(wc.done, [expected], JSON.stringify(input));
    assert.equal(event.defaultPrevented, true);
  }
});

test('bindEditShortcuts: key-up, no modifier, other keys (Ctrl+W, Ctrl+Q, Ctrl+Y) do nothing and are not consumed', () => {
  const wc = spy(new EventEmitter());
  bindEditShortcuts(wc);
  const events = [
    press(wc, { type: 'keyUp', control: true, key: 'c' }),
    press(wc, { key: 'c' }),
    press(wc, { control: true, key: 'w' }),
    press(wc, { control: true, key: 'q' }),
    press(wc, { control: true, key: 'y' }),
  ];
  assert.deepEqual(wc.done, []);
  assert.deepEqual(events.map((e) => e.defaultPrevented), [false, false, false, false, false]);
});

test('app window: the accelerators are bound at creation and act on that window own contents only', () => {
  const h = createGoogleHarness();
  const a = h.open(DOC);
  const b = h.open('https://drive.google.com/file/d/1/view');
  spy(a.webContents);
  spy(b.webContents);
  for (const [input, expected] of CASES) {
    a.webContents.done.length = 0;
    const event = press(a.webContents, input);
    assert.deepEqual(a.webContents.done, [expected], JSON.stringify(input));
    assert.equal(event.defaultPrevented, true);
  }
  assert.deepEqual(b.webContents.done, []);
});

test('app window: a pending forms.gle hop window gets them too, and Ctrl+W / Ctrl+Q stay unhandled (no close or quit path)', () => {
  const h = createGoogleHarness();
  const win = h.open('https://forms.gle/abc', { hop: true });
  spy(win.webContents);
  assert.equal(press(win.webContents, { control: true, key: 'v' }).defaultPrevented, true);
  assert.equal(press(win.webContents, { control: true, key: 'w' }).defaultPrevented, false);
  assert.equal(press(win.webContents, { control: true, key: 'q' }).defaultPrevented, false);
  assert.equal(win.destroyed, false);
});

test('main window: index.js uses the shared helper and keeps no second inline copy', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');
  assert.match(source, /require\(['"]\.\/editShortcuts['"]\)/);
  assert.match(source, /bindEditShortcuts\(\s*mainWindow\.webContents\s*\)/);
  assert.equal(/before-input-event/.test(source), false);
});
