'use strict';

// UI-14: Ctrl+P in Google app windows (src/main/printShortcut.js). Coverage map:
//   requirement 1 window.print() in sandboxed no-preload windows -> NOT testable here (Electron docs do not state it;
//                                         owner hand check on a real desktop, see gap row 14)
//   requirement 2 Ctrl+P -> contents.print() -> 'keys' tests (consumed, one call, Cmd+P too; other combos ignored)
//   requirement 3 never silent / PDF / log -> 'dialog' test (print called with NO arguments) and 'wiring' test
//   requirement 2 Google app windows only -> 'manager' + 'wiring' tests
//   robustness                          -> 'guards' test (destroyed / no print function)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { makeEvent } = require('./helpers/electronFakes');
const { createPrintShortcut, isPrintKey } = require('../src/main/printShortcut');

function fakeContents() {
  const wc = new EventEmitter();
  wc.calls = [];
  wc.destroyed = false;
  wc.isDestroyed = () => wc.destroyed;
  wc.print = (...args) => { wc.calls.push(args); };
  return wc;
}

function press(wc, input) {
  const event = makeEvent();
  wc.emit('before-input-event', event, { type: 'keyDown', control: true, meta: false, alt: false, shift: false, key: 'p', ...input });
  return event;
}

const bound = () => createPrintShortcut().bind(fakeContents());

test('keys: Ctrl+P and Cmd+P print once each and are consumed', () => {
  const wc = bound();
  assert.equal(press(wc, {}).defaultPrevented, true);
  assert.equal(wc.calls.length, 1);
  assert.equal(press(wc, { control: false, meta: true, key: 'P' }).defaultPrevented, true);
  assert.equal(wc.calls.length, 2);
});

test('keys: other combinations are ignored and not consumed', () => {
  const wc = bound();
  for (const input of [
    { control: false, key: 'p' },
    { alt: true },
    { shift: true },
    { type: 'keyUp' },
    { key: 'o' },
  ]) assert.equal(press(wc, input).defaultPrevented, false, JSON.stringify(input));
  assert.equal(wc.calls.length, 0);
  assert.equal(isPrintKey(null), false);
});

test('dialog: print is called with no arguments (system dialog, never silent, no options)', () => {
  const wc = bound();
  press(wc, {});
  assert.deepEqual(wc.calls, [[]]);
});

test('guards: a destroyed contents or one without print does nothing', () => {
  const p = createPrintShortcut();
  const wc = fakeContents();
  wc.destroyed = true;
  assert.equal(p.print(wc), false);
  assert.deepEqual(wc.calls, []);
  assert.equal(p.print({ isDestroyed: () => false }), false);
  assert.equal(p.print(null), false);
});

test('manager: the window manager passes the created contents to bindPrint', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'googleAppWindow.js'), 'utf8');
  assert.match(src, /bindPrint\(contents\)/);
});

test('wiring: only the Google app windows bind it; no silent, no PDF, no IPC, no logging', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', p), 'utf8');
  assert.match(read('index.js'), /bindPrint: createPrintShortcut\(\)\.bind/);
  for (const f of ['callWindow.js', 'meetPermissions.js', 'meetLink.js', 'meetingPage.js', 'helpWindow.js', 'settingsWindow.js', 'pickerWindow.js', 'zoom.js', 'historyNav.js', 'editShortcuts.js']) {
    assert.doesNotMatch(read(f), /printShortcut|\.print\(/, f);
  }
  // Comments are stripped first: the header legitimately says "never printToPDF"; the guard checks code only.
  const src = read('printShortcut.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
  assert.match(src, /contents\.print\(\)/); // the stripped source still holds the call, so the guard is not vacuous
  assert.doesNotMatch(src,/silent\s*:|printToPDF|ipcMain|ipcRenderer|BrowserWindow|contextBridge|console\.|\blog\(/);
});
