'use strict';

// BUG-10 coverage map (docs/architecture/main-window-reload.md):
//   AC1  F5, Ctrl+R, Ctrl+Shift+R reload the main window ........ reloadKind table, accelerator tests
//   AC2  a failed main-frame load recovers without quitting ....... back-off tests (delays, reset, manual, targets)
//   AC3  retry works while hidden, window stays live ............... no window object is touched (static check) + main-process timer
//   AC4  FR-19 limits still hold .................................. no retry while the mode is on, retry dropped, manual reload only
//   Safety: ERR_ABORTED / subframe ignored, error page is not a recovery, destroyed/disposed contents, wiring in index.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createMainReload, reloadKind, DEFAULT_BACKOFF_MS } = require('../src/main/mainReload');

const START = 'https://chat.google.com/';
const CHAT = 'https://chat.google.com';

function makeContents() {
  const wc = new EventEmitter();
  wc.destroyed = false;
  wc.url = '';
  wc.calls = [];
  wc.isDestroyed = () => wc.destroyed;
  wc.getURL = () => wc.url;
  wc.loadURL = (u) => {
    wc.calls.push(['loadURL', u]);
    return Promise.resolve();
  };
  wc.reload = () => wc.calls.push(['reload']);
  wc.reloadIgnoringCache = () => wc.calls.push(['reloadIgnoringCache']);
  return wc;
}

function makeClock() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    pending: () => [...timers.values()].map((t) => t.ms),
    fireNext: () => {
      const [id, t] = timers.entries().next().value;
      timers.delete(id);
      t.fn();
    },
  };
}

function setup(opts = {}) {
  const wc = makeContents();
  const clock = makeClock();
  const state = { signIn: false };
  const logs = [];
  const ctl = createMainReload({
    webContents: wc,
    startUrl: START,
    isChatUrl: (u) => u.startsWith(CHAT),
    isSignInActive: () => state.signIn,
    log: (...a) => logs.push(a.join(' ')),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...opts,
  });
  ctl.bind();
  return { wc, clock, state, logs, ctl };
}

const fail = (wc, url = START, code = -106, isMain = true) => wc.emit('did-fail-load', {}, code, 'ERR', url, isMain);
const press = (wc, input) => {
  let prevented = false;
  wc.emit('before-input-event', { preventDefault: () => (prevented = true) }, { type: 'keyDown', key: '', ...input });
  return prevented;
};
const settle = () => new Promise((r) => setImmediate(r));

test('reloadKind: F5 and Ctrl/Cmd+R reload; Ctrl+Shift+R, Ctrl+F5, Shift+F5 reload ignoring cache', () => {
  assert.equal(reloadKind({ type: 'keyDown', key: 'F5' }), 'reload');
  assert.equal(reloadKind({ type: 'keyDown', key: 'r', control: true }), 'reload');
  assert.equal(reloadKind({ type: 'keyDown', key: 'R', meta: true }), 'reload');
  assert.equal(reloadKind({ type: 'keyDown', key: 'R', control: true, shift: true }), 'hard');
  assert.equal(reloadKind({ type: 'keyDown', key: 'F5', control: true }), 'hard');
  assert.equal(reloadKind({ type: 'keyDown', key: 'F5', shift: true }), 'hard');
});

test('reloadKind: ignores plain R, key-up, auto-repeat, Alt combos, other keys, junk input', () => {
  for (const input of [
    { type: 'keyDown', key: 'r' },
    { type: 'keyUp', key: 'F5' },
    { type: 'keyDown', key: 'F5', isAutoRepeat: true },
    { type: 'keyDown', key: 'r', control: true, alt: true },
    { type: 'keyDown', key: 'F6' },
    { type: 'keyDown', key: 'w', control: true },
    null,
    undefined,
  ]) {
    assert.equal(reloadKind(input), null);
  }
});

test('AC1: F5 and Ctrl+R reload, Ctrl+Shift+R reloads ignoring the cache; the key is consumed', () => {
  const { wc } = setup();
  assert.equal(press(wc, { key: 'F5' }), true);
  assert.equal(press(wc, { key: 'r', control: true }), true);
  assert.equal(press(wc, { key: 'R', control: true, shift: true }), true);
  assert.deepEqual(wc.calls, [['reload'], ['reload'], ['reloadIgnoringCache']]);
});

test('AC1: unrelated keys are not consumed and do not reload', () => {
  const { wc } = setup();
  assert.equal(press(wc, { key: 'c', control: true }), false);
  assert.deepEqual(wc.calls, []);
});

test('AC2: a main-frame failure schedules a retry; the retry loads the failed Chat URL', () => {
  const { wc, clock } = setup();
  fail(wc, 'https://chat.google.com/u/0/#chat/home');
  assert.deepEqual(clock.pending(), [DEFAULT_BACKOFF_MS[0]]);
  clock.fireNext();
  assert.deepEqual(wc.calls, [['loadURL', 'https://chat.google.com/u/0/#chat/home']]);
});

test('AC2: a failed URL outside the Chat origins is never retried; the start page is', () => {
  const { wc, clock } = setup();
  fail(wc, 'https://evil.example/');
  clock.fireNext();
  assert.deepEqual(wc.calls, [['loadURL', START]]);
  fail(wc, 'javascript:alert(1)');
  clock.fireNext();
  assert.deepEqual(wc.calls[1], ['loadURL', START]);
});

test('AC2: delays grow with each failure and the last delay repeats', () => {
  const { wc, clock } = setup();
  const seen = [];
  for (let i = 0; i < DEFAULT_BACKOFF_MS.length + 2; i += 1) {
    fail(wc);
    seen.push(clock.pending()[0]);
    clock.fireNext();
  }
  const last = DEFAULT_BACKOFF_MS[DEFAULT_BACKOFF_MS.length - 1];
  assert.deepEqual(seen, [...DEFAULT_BACKOFF_MS, last, last]);
});

test('AC2: a successful http(s) load clears the recovery state and the back-off', () => {
  const { wc, clock, ctl } = setup();
  fail(wc);
  fail(wc);
  assert.equal(ctl.isRecovering(), true);
  wc.url = START;
  wc.emit('did-finish-load');
  assert.equal(ctl.isRecovering(), false);
  assert.deepEqual(clock.pending(), []);
  fail(wc);
  assert.deepEqual(clock.pending(), [DEFAULT_BACKOFF_MS[0]]);
});

test('AC2: the engine error page finishing its own load is not a recovery', () => {
  const { wc, clock, ctl } = setup();
  fail(wc);
  wc.url = 'chrome-error://chromewebdata/';
  wc.emit('did-finish-load');
  assert.equal(ctl.isRecovering(), true);
  assert.equal(clock.pending().length, 1);
});

test('AC2: a second failure replaces the pending timer (one timer at a time)', () => {
  const { wc, clock } = setup();
  fail(wc);
  fail(wc);
  assert.equal(clock.pending().length, 1);
});

test('AC2: ERR_ABORTED and sub-frame failures are ignored', () => {
  const { wc, clock, ctl } = setup();
  fail(wc, START, -3, true);
  fail(wc, START, -106, false);
  assert.equal(ctl.isRecovering(), false);
  assert.deepEqual(clock.pending(), []);
});

test('AC2: F5 after a failure retries at once (loadURL of the target), cancels the timer, restarts the back-off', () => {
  const { wc, clock } = setup();
  fail(wc);
  fail(wc);
  assert.equal(press(wc, { key: 'F5' }), true);
  assert.deepEqual(wc.calls, [['loadURL', START]]);
  assert.deepEqual(clock.pending(), []);
  fail(wc);
  assert.deepEqual(clock.pending(), [DEFAULT_BACKOFF_MS[0]]);
});

test('AC2: a rejected loadURL is swallowed (no unhandled rejection) and logged by name only', async () => {
  const { wc, clock, logs } = setup();
  wc.loadURL = () => Promise.reject(Object.assign(new Error('ERR_INTERNET_DISCONNECTED https://secret.example/x'), { name: 'Error' }));
  fail(wc);
  clock.fireNext();
  await settle();
  assert.ok(logs.some((l) => l.includes('load rejected')));
  assert.ok(!logs.some((l) => l.includes('secret.example')));
});

test('AC2: a synchronous throw from loadURL does not escape the timer', async () => {
  const { wc, clock } = setup();
  wc.loadURL = () => {
    throw new Error('boom');
  };
  fail(wc);
  assert.doesNotThrow(() => clock.fireNext());
  await settle();
});

test('AC3: the retry path touches only the contents: no show, focus, hide, destroy, throttling or power calls', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'mainReload.js'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\.(show|showInactive|focus|hide|close|destroy|minimize|restore)\(/);
  assert.doesNotMatch(code, /backgroundThrottling|setBackgroundThrottling|powerSaveBlocker|require\(['"]electron['"]\)/);
  assert.doesNotMatch(code, /app\.(quit|exit)|process\.exit/);
});

test('AC3: retry fires from the timer with no window visibility input at all (hidden window recovers)', () => {
  const { wc, clock } = setup();
  fail(wc);
  clock.fireNext();
  assert.deepEqual(wc.calls, [['loadURL', START]]);
});

test('AC4: while sign-in mode is on a failure schedules no retry and cancels a pending one', () => {
  const { wc, clock, state } = setup();
  fail(wc);
  assert.equal(clock.pending().length, 1);
  state.signIn = true;
  fail(wc, 'https://login.idp.example/step');
  assert.deepEqual(clock.pending(), []);
  assert.deepEqual(wc.calls, []);
});

test('AC4: a retry already pending when the mode turns on is dropped, not run', () => {
  const { wc, clock, state, logs } = setup();
  fail(wc);
  state.signIn = true;
  clock.fireNext();
  assert.deepEqual(wc.calls, []);
  assert.ok(logs.some((l) => l.includes('sign-in in progress')));
});

test('AC4: during the mode F5 reloads the current page only (no loadURL, no origin chosen by this module)', () => {
  const { wc, state } = setup();
  fail(wc);
  state.signIn = true;
  press(wc, { key: 'F5' });
  press(wc, { key: 'R', control: true, shift: true });
  assert.deepEqual(wc.calls, [['reload'], ['reloadIgnoringCache']]);
});

test('AC4: this module never loads anything but the start URL or a failed Chat-origin URL', () => {
  const { wc, clock } = setup();
  for (const url of ['https://accounts.google.com/', 'http://chat.google.com.evil.example/', 'file:///etc/passwd', '']) {
    fail(wc, url);
    clock.fireNext();
  }
  for (const call of wc.calls) assert.equal(call[1], START);
});

test('safety: destroyed contents and a disposed controller never act', () => {
  const a = setup();
  fail(a.wc);
  a.wc.destroyed = true;
  a.clock.fireNext();
  press(a.wc, { key: 'F5' });
  assert.deepEqual(a.wc.calls, []);

  const b = setup();
  fail(b.wc);
  b.ctl.dispose();
  assert.deepEqual(b.clock.pending(), []);
  fail(b.wc);
  press(b.wc, { key: 'F5' });
  assert.deepEqual(b.wc.calls, []);
});

test('wiring: index.js binds the module to the main window, handles the start load rejection and disposes on close', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');
  assert.match(source, /require\(['"]\.\/mainReload['"]\)/);
  assert.match(source, /createMainReload\(\{[\s\S]*isSignInActive:\s*\(\)\s*=>\s*signInFlow\.isActive\(\)/);
  assert.match(source, /mainReload\.bind\(\)/);
  assert.match(source, /mainReload\.dispose\(\)/);
  assert.match(source, /mainWindow\.loadURL\(startUrl\)\.catch\(/);
});
