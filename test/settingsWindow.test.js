'use strict';

// BUG-06: the Settings window follows its content height (docs/design/00-settings-surface-spec.md
// section 1 "Size"). Root cause: the window was a fixed 380x460 OUTER size; the content grows when
// toggles reveal notes/errors, so the client area (460 minus title bar) overflowed and Chromium drew
// a vertical scrollbar. Stubbed Electron, same style as the other main-process tests.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createManualClock } = require('./helpers/electronFakes');
const sw = require('../src/main/settingsWindow.js');

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 };
const CHROME = 39; // outer height minus content height (title bar + borders)

class FakeWin extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.webContents = { id: 7 };
    this.bounds = { x: 500, y: 200, width: options.width, height: options.height };
    this.shown = options.show !== false;
    this.setBoundsCalls = [];
    this.centerCalls = 0;
    this.destroyed = false;
  }
  setMenu() {}
  loadFile() {}
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.shown; }
  show() { this.shown = true; }
  focus() {}
  center() { this.centerCalls += 1; }
  getBounds() { return { ...this.bounds }; }
  getContentBounds() { return { ...this.bounds, height: this.bounds.height - CHROME }; }
  setBounds(b) { this.setBoundsCalls.push(b); this.bounds = { ...b }; }
  close() { this.destroyed = true; this.emit('closed'); }
}

function setup({ workArea = WORK_AREA } = {}) {
  const prev = sw.getSettingsWindow();
  if (prev && !prev.isDestroyed()) prev.close(); // module singleton: isolate tests
  const clock = createManualClock();
  const electron = {
    BrowserWindow: FakeWin,
    screen: { getDisplayMatching: () => ({ workArea }) },
  };
  const win = sw.openSettingsWindow({ electron, timers: clock });
  const ipcMain = { handlers: {}, on(ch, fn) { this.handlers[ch] = fn; } };
  sw.registerSettingsWindowIpc(ipcMain, { screen: electron.screen });
  const send = (h, id = win.webContents.id) =>
    ipcMain.handlers[sw.SETTINGS_RESIZE_CHANNEL]({ sender: { id } }, h);
  return { win, clock, send, ipcMain };
}

test('settingsWindow: channel name is settings:content-height', () => {
  assert.equal(sw.SETTINGS_RESIZE_CHANNEL, 'settings:content-height');
});

test('fitContentHeight: passes a normal height through, ceiled', () => {
  assert.equal(sw.fitContentHeight(401.2, { chromeHeight: CHROME, workAreaHeight: 1040 }), 402);
});

test('fitContentHeight: clamps to the work area minus the chrome', () => {
  assert.equal(sw.fitContentHeight(5000, { chromeHeight: CHROME, workAreaHeight: 700 }), 700 - CHROME);
});

test('fitContentHeight: rejects non-finite / non-positive / non-number input', () => {
  for (const bad of [NaN, Infinity, -5, 0, '400', null, undefined, {}]) {
    assert.equal(sw.fitContentHeight(bad, { chromeHeight: CHROME, workAreaHeight: 1040 }), null, String(bad));
  }
});

test('computeBounds: keeps the top edge and the width, changes only the height', () => {
  const b = sw.computeBounds({ bounds: { x: 500, y: 200, width: 380, height: 460 }, contentHeight: 400, chromeHeight: CHROME, workArea: WORK_AREA });
  assert.deepEqual(b, { x: 500, y: 200, width: 380, height: 439 });
});

test('computeBounds: moves up when growing would push the bottom off the work area', () => {
  const b = sw.computeBounds({ bounds: { x: 500, y: 900, width: 380, height: 300 }, contentHeight: 400, chromeHeight: CHROME, workArea: WORK_AREA });
  assert.equal(b.height, 439);
  assert.equal(b.y, 1040 - 439);
  assert.equal(b.x, 500);
});

test('computeBounds: never moves above the work area top', () => {
  const b = sw.computeBounds({ bounds: { x: 0, y: -50, width: 380, height: 300 }, contentHeight: 200, chromeHeight: CHROME, workArea: WORK_AREA });
  assert.equal(b.y, 0);
});

test('openSettingsWindow: created hidden (sized before show), non-resizable, same security prefs, width unchanged', () => {
  const { win } = setup();
  assert.equal(win.options.show, false);
  assert.equal(win.options.width, 380);
  assert.equal(win.options.resizable, false);
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.sandbox, true);
});

test('first valid height sizes the window, centers it, then shows it', () => {
  const { win, send } = setup();
  assert.equal(win.shown, false);
  send(420);
  assert.equal(win.setBoundsCalls.length, 1);
  assert.equal(win.bounds.height, 420 + CHROME);
  assert.equal(win.bounds.width, 380);
  assert.equal(win.centerCalls, 1);
  assert.equal(win.shown, true);
});

test('later heights keep the top edge (no re-center) and resize', () => {
  const { win, send } = setup();
  send(420);
  const top = win.bounds.y;
  send(470);
  assert.equal(win.bounds.height, 470 + CHROME);
  assert.equal(win.bounds.y, top);
  assert.equal(win.centerCalls, 1);
});

test('an identical height does not call setBounds again', () => {
  const { win, send } = setup();
  send(420);
  send(420);
  assert.equal(win.setBoundsCalls.length, 1);
});

test('content taller than the work area is clamped (scrollbar then allowed)', () => {
  const { win, send } = setup({ workArea: { x: 0, y: 0, width: 1280, height: 600 } });
  send(5000);
  assert.equal(win.bounds.height, 600);
  assert.ok(win.bounds.y >= 0 && win.bounds.y + win.bounds.height <= 600);
});

test('growth near the bottom keeps the window on screen', () => {
  const { win, send } = setup();
  send(300);
  win.bounds.y = 800;
  send(450);
  assert.ok(win.bounds.y + win.bounds.height <= 1040);
});

test('messages from another sender or with junk payloads are ignored', () => {
  const { win, send } = setup();
  send(420, 999);
  for (const bad of [NaN, '420', -1, Infinity, null, {}]) send(bad);
  assert.equal(win.setBoundsCalls.length, 0);
  assert.equal(win.shown, false);
});

test('a message after the window closed is ignored without throwing', () => {
  const { win, send } = setup();
  win.close();
  assert.doesNotThrow(() => send(420));
});

test('fallback: the window is shown anyway if the renderer never reports a height', () => {
  const { win, clock } = setup();
  clock.tick(sw.SHOW_FALLBACK_MS - 1);
  assert.equal(win.shown, false);
  clock.tick(1);
  assert.equal(win.shown, true);
});

test('fallback timer is cancelled once the window closes', () => {
  const { win, clock } = setup();
  win.close();
  assert.equal(clock.pending(), 0);
});

test('a second open focuses the existing window instead of creating another', () => {
  const { win } = setup();
  const again = sw.openSettingsWindow({ electron: { BrowserWindow: FakeWin } });
  assert.equal(again, win);
});

// --- UI-06: settings:open-help ---------------------------------------------------------------------

function setupHelp() {
  const prev = sw.getSettingsWindow();
  if (prev && !prev.isDestroyed()) prev.close();
  const electron = { BrowserWindow: FakeWin, screen: { getDisplayMatching: () => ({ workArea: WORK_AREA }) } };
  const win = sw.openSettingsWindow({ electron, timers: createManualClock() });
  const calls = [];
  const ipcMain = { handlers: {}, on(ch, fn) { this.handlers[ch] = fn; } };
  sw.registerSettingsWindowIpc(ipcMain, { screen: electron.screen, openHelp: (...a) => calls.push(a) });
  const send = (event, ...args) => ipcMain.handlers[sw.SETTINGS_OPEN_HELP_CHANNEL](event, ...args);
  return { win, calls, send, ipcMain };
}

test('settings:open-help: channel name is exactly settings:open-help', () => {
  assert.equal(sw.SETTINGS_OPEN_HELP_CHANNEL, 'settings:open-help');
});

test('settings:open-help: a message from the Settings window opens Help, once per message, ignoring any payload', () => {
  const { win, calls, send } = setupHelp();
  send({ sender: { id: win.webContents.id } });
  assert.deepEqual(calls, [[]]);
  send({ sender: { id: win.webContents.id } }, { url: 'https://evil.example' }, 'x');
  assert.deepEqual(calls, [[], []]); // openHelp is never handed the payload
});

test('settings:open-help: another sender, a missing sender or a malformed event is ignored', () => {
  const { calls, send } = setupHelp();
  send({ sender: { id: 999 } });
  send({});
  send(undefined);
  send({ sender: null });
  assert.deepEqual(calls, []);
});

test('settings:open-help: ignored once the Settings window is closed', () => {
  const { win, calls, send } = setupHelp();
  const id = win.webContents.id;
  win.close();
  assert.doesNotThrow(() => send({ sender: { id } }));
  assert.deepEqual(calls, []);
});

test('settings:open-help: registering without an openHelp callback does not throw when the channel fires', () => {
  const prev = sw.getSettingsWindow();
  if (prev && !prev.isDestroyed()) prev.close();
  const win = sw.openSettingsWindow({ electron: { BrowserWindow: FakeWin }, timers: createManualClock() });
  const ipcMain = { handlers: {}, on(ch, fn) { this.handlers[ch] = fn; } };
  sw.registerSettingsWindowIpc(ipcMain, { screen: {} });
  assert.doesNotThrow(() => ipcMain.handlers[sw.SETTINGS_OPEN_HELP_CHANNEL]({ sender: { id: win.webContents.id } }));
});
