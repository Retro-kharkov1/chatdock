'use strict';

// UI-10: keyboard + Ctrl+wheel zoom (src/main/zoom.js). Coverage map:
//   requirement 1 keys           -> 'keys' tests (Ctrl+= / + / - / 0, Cmd, Alt/keyUp/other keys ignored)
//   requirement 2 bound+persist  -> 'bounds', 'persist' and 'relaunch' tests (a second createZoom on the same file)
//   requirement 3 Ctrl+wheel     -> 'wheel' tests (Chromium already zoomed vs not; both end at one factor)
//   requirement 4 call window    -> 'wiring' test (callWindow.js / meet files do not mention zoom)
//   requirement 5 no UI          -> 'wiring' test (no new window, IPC channel or preload change)
//   requirement 6 nothing logged -> 'log' test (only an error code is logged on a failed write)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { makeEvent } = require('./helpers/electronFakes');
const { createZoom, clampFactor, zoomActionFor, loadFactor, MIN_FACTOR, MAX_FACTOR } = require('../src/main/zoom');

function fakeContents() {
  const wc = new EventEmitter();
  wc.factor = 1;
  wc.destroyedFlag = false;
  wc.getZoomFactor = () => wc.factor;
  wc.setZoomFactor = (f) => { wc.factor = f; };
  wc.isDestroyed = () => wc.destroyedFlag;
  return wc;
}

function press(wc, input) {
  const event = makeEvent();
  wc.emit('before-input-event', event, { type: 'keyDown', control: false, meta: false, shift: false, alt: false, key: '', ...input });
  return event;
}

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gcd-zoom-')), 'zoom.json');
}

const manual = () => {
  const queue = [];
  return { scheduler: (fn) => queue.push(fn), flush: () => { while (queue.length) queue.shift()(); } };
};

test('keys: Ctrl+= / Ctrl++ zoom in, Ctrl+- / Ctrl+_ zoom out, Ctrl+0 resets; each is consumed', () => {
  const z = createZoom({});
  const wc = z.bind(fakeContents());
  for (const [input, expected] of [
    [{ control: true, key: '=' }, 1.1],
    [{ control: true, shift: true, key: '+' }, 1.2],
    [{ control: true, key: '-' }, 1.1],
    [{ control: true, shift: true, key: '_' }, 1.0],
    [{ meta: true, key: '=' }, 1.1],
  ]) {
    const event = press(wc, input);
    assert.equal(event.defaultPrevented, true, JSON.stringify(input));
    assert.equal(wc.factor, expected, JSON.stringify(input));
  }
  const event = press(wc, { control: true, key: '0' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(wc.factor, 1);
});

test('keys: key-up, no modifier, Alt, and other keys do nothing and are not consumed', () => {
  const z = createZoom({});
  const wc = z.bind(fakeContents());
  const events = [
    press(wc, { type: 'keyUp', control: true, key: '=' }),
    press(wc, { key: '=' }),
    press(wc, { control: true, alt: true, key: '=' }),
    press(wc, { control: true, key: 'w' }),
    press(wc, { control: true, key: 'v' }),
  ];
  assert.equal(wc.factor, 1);
  assert.deepEqual(events.map((e) => e.defaultPrevented), [false, false, false, false, false]);
  assert.equal(zoomActionFor(null), null);
});

test('bounds: the factor never leaves [MIN, MAX] and junk values fall back to 1', () => {
  const z = createZoom({});
  const wc = z.bind(fakeContents());
  for (let i = 0; i < 60; i++) press(wc, { control: true, key: '=' });
  assert.equal(wc.factor, MAX_FACTOR);
  for (let i = 0; i < 80; i++) press(wc, { control: true, key: '-' });
  assert.equal(wc.factor, MIN_FACTOR);
  assert.equal(clampFactor(NaN), 1);
  assert.equal(clampFactor('2'), 1);
  assert.equal(clampFactor(Infinity), 1);
  assert.equal(clampFactor(99), MAX_FACTOR);
  assert.equal(clampFactor(0.01), MIN_FACTOR);
  assert.equal(clampFactor(1.1000000000000001), 1.1);
});

test('persist and relaunch: the factor survives a new controller on the same file; corrupt file gives 1', () => {
  const file = tmpFile();
  const first = createZoom({ filePath: file });
  const wc = first.bind(fakeContents());
  press(wc, { control: true, key: '=' });
  press(wc, { control: true, key: '=' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { factor: 1.2 });

  const second = createZoom({ filePath: file }); // "relaunch"
  assert.equal(second.getFactor(), 1.2);
  const fresh = second.bind(fakeContents());
  fresh.emit('dom-ready');
  assert.equal(fresh.factor, 1.2);

  fs.writeFileSync(file, '{not json', 'utf8');
  assert.equal(loadFactor(file), 1);
  fs.writeFileSync(file, JSON.stringify({ factor: 50 }), 'utf8');
  assert.equal(loadFactor(file), MAX_FACTOR);
  assert.equal(loadFactor(path.join(path.dirname(file), 'missing.json')), 1);
});

test('shared: one factor across windows; a destroyed window is skipped and forgotten', () => {
  const z = createZoom({});
  const a = z.bind(fakeContents());
  const b = z.bind(fakeContents());
  press(a, { control: true, key: '=' });
  assert.equal(b.factor, 1.1);
  b.destroyedFlag = true;
  b.emit('destroyed');
  press(a, { control: true, key: '=' });
  assert.equal(b.factor, 1.1);
  assert.equal(a.factor, 1.2);
});

test('navigation: dom-ready re-applies the factor after the page reset it', () => {
  const z = createZoom({});
  const wc = z.bind(fakeContents());
  press(wc, { control: true, key: '=' });
  wc.factor = 1; // new origin reset
  wc.emit('dom-ready');
  assert.equal(wc.factor, 1.1);
});

test('wheel: Chromium did not zoom -> the app applies one step; unchanged direction none does nothing', () => {
  const m = manual();
  const z = createZoom({ scheduler: m.scheduler });
  const wc = z.bind(fakeContents());
  wc.emit('zoom-changed', makeEvent(), 'in');
  m.flush();
  assert.equal(wc.factor, 1.1);
  wc.emit('zoom-changed', makeEvent(), 'out');
  m.flush();
  assert.equal(wc.factor, 1);
  wc.emit('zoom-changed', makeEvent(), 'sideways');
  m.flush();
  assert.equal(wc.factor, 1);
});

test('wheel: Chromium already zoomed -> its factor is adopted, persisted and shared, not stepped twice', () => {
  const file = tmpFile();
  const m = manual();
  const z = createZoom({ filePath: file, scheduler: m.scheduler });
  const wc = z.bind(fakeContents());
  const other = z.bind(fakeContents());
  wc.emit('zoom-changed', makeEvent(), 'in');
  wc.factor = 1.2; // Chromium's own step landed before our deferred check
  m.flush();
  assert.equal(z.getFactor(), 1.2);
  assert.equal(wc.factor, 1.2);
  assert.equal(other.factor, 1.2);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { factor: 1.2 });
});

test('log: a failed write logs only an error code, never the path or the value', () => {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try {
    const failing = { readFileSync: () => { throw new Error('x'); }, mkdirSync() {}, writeFileSync() { const e = new Error('secret-path'); e.code = 'EACCES'; throw e; } };
    const z = createZoom({ filePath: '/secret/zoom.json', fsImpl: failing });
    press(z.bind(fakeContents()), { control: true, key: '=' });
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('EACCES'));
  assert.ok(!lines[0].includes('secret'));
});

test('wiring: main window and Google app windows bind zoom; the call window and meet code never do', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', p), 'utf8');
  const index = read('index.js');
  assert.match(index, /zoom\.bind\(mainWindow\.webContents\)/);
  assert.match(index, /bindZoom: zoom\.bind/);
  assert.match(read('googleAppWindow.js'), /bindZoom\(contents\)/);
  for (const f of ['callWindow.js', 'meetPermissions.js', 'meetLink.js', 'meetingPage.js', 'helpWindow.js', 'settingsWindow.js', 'pickerWindow.js']) {
    assert.doesNotMatch(read(f), /zoom/i, f);
  }
  const zoomSrc = read('zoom.js');
  assert.doesNotMatch(zoomSrc, /ipcMain|BrowserWindow|Menu|contextBridge/);
});
