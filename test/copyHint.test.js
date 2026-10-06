'use strict';

// UI-05 / FR-18, docs/architecture/smart-copy.md section 4 and 8 (row "Hint window"). RED until
// src/main/copyHint.js, src/renderer/copy-hint.html and src/renderer/copy-hint.css exist. The mixed-DPI placement
// rows are deferred until the spike (smart-copy.md section 8) and are NOT here.
//
// API CONTRACT ASSUMED (the implementer may argue with it and then change the tests together, never silently):
//   src/main/copyHint.js (no Electron import)
//     createCopyHint({
//       BrowserWindow,   // constructor: new BrowserWindow(options)
//       screen,          // { getCursorScreenPoint(), getDisplayNearestPoint(point) -> { workArea } }
//       session,         // { fromPartition(name) -> ses with setPermissionRequestHandler / setPermissionCheckHandler }
//       timers,          // { setTimeout, clearTimeout }
//       htmlPath,        // absolute path of copy-hint.html, passed to win.loadFile
//       log,             // (...args) => void
//     }) -> {
//       showHint(kind, cursorPoint?) -> Promise | void   kind: 'copied' | 'link-copied'; any other kind is ignored.
//                                                         cursorPoint defaults to screen.getCursorScreenPoint().
//       destroy()                                         at app quit: destroys the window, clears every timer.
//     }
//   The window is created lazily on the first valid hint, reused, hidden 1500 ms after the last hint, and destroyed
//   300000 ms (5 min) after the last hint. It is shown ONLY by showInactive(), after loadFile resolved and the text
//   swap (executeJavaScript of one of two fixed strings) resolved. Size: height 28, width 76 ('copied') or 104
//   ('link-copied'); position = cursor + (12, 18), flipped to the left of / above the cursor when it would overflow
//   the work area of the display nearest to the cursor, then clamped inside it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { load } = require('./helpers/pending');
const { createManualClock, settle } = require('./helpers/electronFakes');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = 'C:/app/src/renderer/copy-hint.html';
const SCRIPT = { copied: "document.body.className='copied'", 'link-copied': "document.body.className='link-copied'" };
const WIDTH = { copied: 76, 'link-copied': 104 };
const HEIGHT = 28;
const HINT_MS = 1500;
const IDLE_MS = 5 * 60 * 1000;
const WORK = { x: 0, y: 0, width: 1920, height: 1040 };

function deferred() {
  const d = {};
  d.promise = new Promise((resolve) => { d.resolve = resolve; });
  return d;
}

function setup({ autoLoad = true, displays = [{ workArea: WORK }], cursor = { x: 500, y: 400 } } = {}) {
  const clock = createManualClock();
  const log = [];
  const state = { cursor, loads: [], swaps: [], loadMode: autoLoad, swapMode: true, wins: [] };

  const permission = { request: null, check: null, partitions: [] };
  const ses = {
    setPermissionRequestHandler: (fn) => { permission.request = fn; },
    setPermissionCheckHandler: (fn) => { permission.check = fn; },
  };
  const session = { fromPartition: (name) => { permission.partitions.push(name); return ses; } };

  class FakeWin extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.bounds = null;
      this.mouse = [];
      this.alwaysOnTop = [];
      this.visible = false;
      this.webContents = new EventEmitter();
      this.webContents.handler = null;
      this.webContents.setWindowOpenHandler = (fn) => { this.webContents.handler = fn; };
      this.webContents.executeJavaScript = (script) => {
        this._alive();
        log.push('swap:' + script);
        state.swaps.push(script);
        if (state.swapMode === true) return Promise.resolve();
        const d = deferred();
        state.swapMode.push(d);
        return d.promise;
      };
      state.wins.push(this);
    }
    _alive() {
      if (this.destroyed) throw new Error('Object has been destroyed');
    }
    isDestroyed() { return this.destroyed; }
    loadFile(file) {
      this._alive();
      log.push('loadFile');
      state.loads.push(file);
      if (state.loadMode) return Promise.resolve();
      const d = deferred();
      state.pendingLoad = d;
      return d.promise;
    }
    setIgnoreMouseEvents(...a) { this._alive(); this.mouse.push(a); }
    setAlwaysOnTop(...a) { this._alive(); this.alwaysOnTop.push(a); }
    setBounds(b) { this._alive(); this.bounds = b; log.push('setBounds'); }
    showInactive() { this._alive(); this.visible = true; log.push('showInactive'); }
    show() { this._alive(); log.push('show'); }
    focus() { this._alive(); log.push('focus'); }
    hide() { this._alive(); this.visible = false; log.push('hide'); }
    destroy() {
      this._alive();
      this.destroyed = true;
      log.push('destroy');
      this.emit('closed');
    }
  }

  const screen = {
    getCursorScreenPoint: () => state.cursor,
    getDisplayNearestPoint: (pt) =>
      displays.find((d) => pt.x >= d.workArea.x && pt.x < d.workArea.x + d.workArea.width && pt.y >= d.workArea.y && pt.y < d.workArea.y + d.workArea.height) || displays[0],
  };

  const hint = load('copyHint.js').createCopyHint({
    BrowserWindow: FakeWin,
    screen,
    session,
    timers: clock,
    htmlPath: HTML_PATH,
    log: () => {},
  });
  return { hint, clock, log, state, permission, FakeWin, win: () => state.wins[state.wins.length - 1] };
}

async function show(t, kind = 'copied', point) {
  const p = t.hint.showHint(kind, point);
  await settle();
  await p;
  await settle();
}

function calls(t, name) {
  return t.log.filter((c) => c === name).length;
}

// --- window options -------------------------------------------------------------------------------------------

test('hint window: created lazily with the exact hardened options and no preload anywhere', async () => {
  const t = setup();
  assert.equal(t.state.wins.length, 0, 'nothing before the first hint');
  await show(t);
  const o = t.win().options;
  assert.equal(o.frame, false);
  assert.equal(o.transparent, true);
  assert.equal(o.focusable, false);
  assert.equal(o.skipTaskbar, true);
  assert.equal(o.show, false);
  assert.equal(o.resizable, false);
  assert.equal(o.movable, false);
  assert.equal(o.hasShadow, false);
  assert.equal(o.alwaysOnTop, true);
  assert.equal(o.height, HEIGHT);
  assert.equal('preload' in o, false);
  assert.equal('parent' in o, false);
  const wp = o.webPreferences;
  assert.equal(wp.contextIsolation, true);
  assert.equal(wp.nodeIntegration, false);
  assert.equal(wp.sandbox, true);
  assert.equal(wp.webSecurity, true);
  assert.equal(wp.webviewTag, false);
  assert.equal('preload' in wp, false);
});

test('hint window: its own non-persistent partition gcd-copy-hint, never persist: and never the default session', async () => {
  const t = setup();
  await show(t);
  const partition = t.win().options.webPreferences.partition;
  assert.equal(partition, 'gcd-copy-hint');
  assert.equal(partition.startsWith('persist:'), false);
  assert.deepEqual(t.permission.partitions, ['gcd-copy-hint']);
});

test('hint window: every permission request is denied and every permission check is false', async () => {
  const t = setup();
  await show(t);
  assert.equal(typeof t.permission.request, 'function');
  assert.equal(typeof t.permission.check, 'function');
  for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'openExternal']) {
    const answers = [];
    t.permission.request({}, permission, (granted) => answers.push(granted));
    assert.deepEqual(answers, [false], permission);
    assert.equal(t.permission.check({}, permission, 'https://example.com'), false, permission);
  }
});

test('hint window: always on top at the pop-up-menu level, click-through, popups denied, navigation prevented', async () => {
  const t = setup();
  await show(t);
  const w = t.win();
  assert.deepEqual(w.alwaysOnTop, [[true, 'pop-up-menu']]);
  assert.deepEqual(w.mouse[0], [true]);
  assert.deepEqual(w.webContents.handler({ url: 'https://evil.example/' }), { action: 'deny' });
  const nav = { prevented: false, preventDefault() { this.prevented = true; } };
  w.webContents.emit('will-navigate', nav, 'https://evil.example/');
  assert.equal(nav.prevented, true);
});

test('hint window: only the local bundled file is loaded, never a remote URL', async () => {
  const t = setup();
  await show(t);
  assert.deepEqual(t.state.loads, [HTML_PATH]);
});

test('hint window: it never calls show() or focus(), only showInactive()', async () => {
  const t = setup();
  await show(t, 'copied');
  await show(t, 'link-copied');
  assert.equal(calls(t, 'show'), 0);
  assert.equal(calls(t, 'focus'), 0);
  assert.equal(calls(t, 'showInactive') >= 1, true);
});

// --- text and ordering ----------------------------------------------------------------------------------------

test('text: the swap is exactly one of the two fixed strings per kind', async () => {
  const t = setup();
  await show(t, 'copied');
  await show(t, 'link-copied');
  assert.deepEqual(t.state.swaps, [SCRIPT.copied, SCRIPT['link-copied']]);
});

test('text: any other kind is ignored (no window, no script, no throw)', async () => {
  const t = setup();
  for (const kind of ['', 'Copied', "x';alert(1);'", '<script>', undefined, null, 5, {}, ['copied']]) {
    await assert.doesNotReject(async () => { await t.hint.showHint(kind); });
  }
  await settle();
  assert.equal(t.state.wins.length, 0);
  assert.deepEqual(t.state.swaps, []);
});

test('order: never shown before loadFile resolved and the text swap resolved; then setBounds, then showInactive', async () => {
  const t = setup({ autoLoad: false });
  t.state.swapMode = [];
  const p = t.hint.showHint('copied');
  await settle();
  assert.deepEqual(t.log, ['loadFile'], 'load pending: nothing else happened');
  t.state.pendingLoad.resolve();
  await settle();
  assert.equal(calls(t, 'showInactive'), 0, 'swap pending: still hidden');
  assert.deepEqual(t.log.slice(0, 2), ['loadFile', 'swap:' + SCRIPT.copied]);
  t.state.swapMode[0].resolve();
  await settle();
  await p;
  const afterSwap = t.log.slice(t.log.indexOf('swap:' + SCRIPT.copied) + 1);
  assert.deepEqual(afterSwap, ['setBounds', 'showInactive']);
});

test('order: a hint requested during the first load is queued, the latest wins, and nothing is dropped or shown twice', async () => {
  const t = setup({ autoLoad: false });
  const first = t.hint.showHint('copied');
  const second = t.hint.showHint('link-copied');
  await settle();
  assert.equal(t.state.wins.length, 1, 'one window');
  assert.equal(calls(t, 'showInactive'), 0);
  t.state.pendingLoad.resolve();
  await settle();
  await first;
  await second;
  await settle();
  assert.equal(t.state.swaps[t.state.swaps.length - 1], SCRIPT['link-copied']);
  assert.equal(calls(t, 'showInactive'), 1);
  assert.equal(t.win().bounds.width, WIDTH['link-copied']);
});

test('reuse: two hints use one window and one loadFile', async () => {
  const t = setup();
  await show(t, 'copied');
  await show(t, 'link-copied');
  assert.equal(t.state.wins.length, 1);
  assert.deepEqual(t.state.loads, [HTML_PATH]);
});

// --- timers ---------------------------------------------------------------------------------------------------

test('timer: the window hides 1500 ms after the hint', async () => {
  const t = setup();
  await show(t);
  t.clock.tick(HINT_MS - 1);
  assert.equal(calls(t, 'hide'), 0);
  t.clock.tick(1);
  assert.equal(calls(t, 'hide'), 1);
});

test('timer: a new hint restarts the 1500 ms timer', async () => {
  const t = setup();
  await show(t, 'copied');
  t.clock.tick(1000);
  await show(t, 'link-copied');
  t.clock.tick(1000);
  assert.equal(calls(t, 'hide'), 0, '1000 ms after the second hint: still shown');
  t.clock.tick(500);
  assert.equal(calls(t, 'hide'), 1);
});

test('timer: the window is destroyed 5 minutes after the last hint and a later hint recreates it', async () => {
  const t = setup();
  await show(t);
  t.clock.tick(HINT_MS);
  t.clock.tick(60 * 1000);
  assert.equal(calls(t, 'destroy'), 0);
  t.clock.tick(IDLE_MS);
  assert.equal(calls(t, 'destroy'), 1);
  assert.equal(t.clock.pending(), 0);
  await show(t);
  assert.equal(t.state.wins.length, 2);
  assert.equal(t.win().visible, true);
});

test('quit: destroy() destroys the window and clears every timer; with no window it does nothing', async () => {
  const t = setup();
  assert.doesNotThrow(() => t.hint.destroy());
  await show(t);
  t.hint.destroy();
  assert.equal(calls(t, 'destroy'), 1);
  assert.equal(t.clock.pending(), 0);
  assert.doesNotThrow(() => t.hint.destroy());
});

// --- destruction safety ---------------------------------------------------------------------------------------

test('destroyed: the window destroyed during the first load makes no further call and does not throw', async () => {
  const t = setup({ autoLoad: false });
  const p = t.hint.showHint('copied');
  await settle();
  t.win().destroyed = true;
  t.state.pendingLoad.resolve();
  await settle();
  await assert.doesNotReject(async () => { await p; });
  assert.deepEqual(t.log, ['loadFile']);
});

test('destroyed: the window destroyed during the text swap makes no setBounds or showInactive and does not throw', async () => {
  const t = setup();
  t.state.swapMode = [];
  const p = t.hint.showHint('copied');
  await settle();
  t.win().destroyed = true;
  t.state.swapMode[0].resolve();
  await settle();
  await assert.doesNotReject(async () => { await p; });
  assert.equal(calls(t, 'setBounds'), 0);
  assert.equal(calls(t, 'showInactive'), 0);
});

test('destroyed: the window destroyed before the 1500 ms expiry or the idle timer is not touched and nothing throws', async () => {
  const t = setup();
  await show(t);
  t.win().destroyed = true;
  assert.doesNotThrow(() => t.clock.tick(HINT_MS));
  assert.doesNotThrow(() => t.clock.tick(IDLE_MS));
  assert.equal(calls(t, 'hide'), 0);
  assert.equal(calls(t, 'destroy'), 0);
});

test('destroyed: the closed event clears the timers and drops the instance, so the next hint builds a new window', async () => {
  const t = setup();
  await show(t);
  t.win().emit('closed');
  assert.equal(t.clock.pending(), 0);
  await show(t);
  assert.equal(t.state.wins.length, 2);
});

// --- OS theme change (spike finding) --------------------------------------------------------------------------

test('theme: an OS theme change drops the window (a transparent window that outlives it stops painting); the next hint recreates it', async () => {
  const nativeTheme = new EventEmitter();
  const t = setup();
  // setup() builds the manager without nativeTheme; build one that has it, reusing the same fakes.
  const clock = createManualClock();
  const wins = [];
  class Win extends t.FakeWin {
    constructor(o) { super(o); wins.push(this); }
  }
  const hint = load('copyHint.js').createCopyHint({
    BrowserWindow: Win,
    screen: { getCursorScreenPoint: () => ({ x: 10, y: 10 }), getDisplayNearestPoint: () => ({ workArea: WORK }) },
    session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) },
    timers: clock,
    htmlPath: HTML_PATH,
    nativeTheme,
    log: () => {},
  });
  await hint.showHint('copied');
  await settle();
  assert.equal(wins.length, 1);
  nativeTheme.emit('updated');
  assert.equal(wins[0].destroyed, true);
  assert.equal(clock.pending(), 0);
  await hint.showHint('copied');
  await settle();
  assert.equal(wins.length, 2, 'recreated lazily');
});

test('theme: without a nativeTheme dependency nothing is registered and nothing throws', async () => {
  const t = setup();
  await show(t);
  assert.equal(t.state.wins.length, 1);
});

// --- position -------------------------------------------------------------------------------------------------

test('position: cursor + (12, 18) with the fixed width per kind and height 28', async () => {
  const t = setup({ cursor: { x: 500, y: 400 } });
  await show(t, 'copied');
  assert.deepEqual(t.win().bounds, { x: 512, y: 418, width: WIDTH.copied, height: HEIGHT });
  await show(t, 'link-copied');
  assert.deepEqual(t.win().bounds, { x: 512, y: 418, width: WIDTH['link-copied'], height: HEIGHT });
});

test('position: an explicit cursorPoint wins over the screen cursor', async () => {
  const t = setup({ cursor: { x: 500, y: 400 } });
  await show(t, 'copied', { x: 100, y: 200 });
  assert.deepEqual(t.win().bounds, { x: 112, y: 218, width: WIDTH.copied, height: HEIGHT });
});

test('position: near the right edge the hint flips to the left of the cursor and stays inside the work area', async () => {
  const t = setup({ cursor: { x: 1900, y: 400 } });
  await show(t, 'link-copied');
  const b = t.win().bounds;
  assert.equal(b.x + b.width <= 1900, true, 'left of the cursor');
  assert.equal(b.x >= WORK.x && b.x + b.width <= WORK.x + WORK.width, true);
});

test('position: near the bottom edge the hint flips above the cursor and stays inside the work area', async () => {
  const t = setup({ cursor: { x: 500, y: 1030 } });
  await show(t, 'copied');
  const b = t.win().bounds;
  assert.equal(b.y + b.height <= 1030, true, 'above the cursor');
  assert.equal(b.y >= WORK.y && b.y + b.height <= WORK.y + WORK.height, true);
});

test('position: in the bottom-right corner the hint is flipped on both axes and inside the work area', async () => {
  const t = setup({ cursor: { x: 1919, y: 1039 } });
  await show(t, 'link-copied');
  const b = t.win().bounds;
  assert.equal(b.x >= 0 && b.y >= 0 && b.x + b.width <= WORK.width && b.y + b.height <= WORK.height, true);
});

test('position: the display nearest to the cursor decides, including one with a negative origin', async () => {
  const left = { workArea: { x: -1920, y: 0, width: 1920, height: 1040 } };
  const right = { workArea: { x: 0, y: 0, width: 2560, height: 1400 } };
  const t = setup({ displays: [left, right], cursor: { x: -1000, y: 100 } });
  await show(t, 'copied');
  assert.deepEqual(t.win().bounds, { x: -988, y: 118, width: WIDTH.copied, height: HEIGHT });

  const edge = setup({ displays: [left, right], cursor: { x: -10, y: 100 } });
  await show(edge, 'link-copied');
  const b = edge.win().bounds;
  assert.equal(b.x >= -1920 && b.x + b.width <= 0, true, 'kept inside the left display');
  assert.equal(b.x + b.width <= -10, true, 'flipped left of the cursor');
});

// --- the hint page (source pins) ------------------------------------------------------------------------------

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('source pin: copy-hint.html has no script, a CSP without script-src, and links its local stylesheet', () => {
  const html = read('src/renderer/copy-hint.html');
  assert.equal(/<script/i.test(html), false, 'no <script>');
  assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'no inline event handler');
  const csp = /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/i.exec(html);
  assert.notEqual(csp, null, 'a CSP meta');
  assert.match(csp[0], /default-src 'none'/);
  assert.match(csp[0], /style-src 'self'/);
  assert.equal(/script-src/i.test(csp[0]), false, 'no script-src');
  assert.match(html, /<link[^>]+href=["']copy-hint\.css["']/i);
});

test('source pin: copy-hint.css holds both strings as body-class CSS content', () => {
  const css = read('src/renderer/copy-hint.css');
  assert.match(css, /body\.copied::before\s*\{[^}]*content:\s*["']Copied["']/);
  assert.match(css, /body\.link-copied::before\s*\{[^}]*content:\s*["']Link copied["']/);
  assert.match(css, /prefers-color-scheme/);
});

test('source pin: the pill is drawn by body::before as a border-box 28 px box and body paints no background (spike: no propagation to the whole transparent window, no clipped right border)', () => {
  const css = read('src/renderer/copy-hint.css');
  const pill = /body::before\s*\{([^}]*)\}/.exec(css);
  assert.notEqual(pill, null);
  assert.match(pill[1], /box-sizing:\s*border-box/);
  assert.match(pill[1], /height:\s*28px/);
  const root = /html,\s*body\s*\{([^}]*)\}/.exec(css);
  assert.notEqual(root, null);
  assert.match(root[1], /background:\s*transparent/);
});

test('source pin: copyHint.js has no Electron import, never calls show() or focus(), and names no preload', () => {
  const code = stripComments(read('src/main/copyHint.js'));
  assert.equal(/require\(['"]electron['"]\)/.test(code), false);
  assert.equal(/\.show\(/.test(code), false);
  assert.equal(/\.focus\(/.test(code), false);
  assert.equal(/\bpreload\b/.test(code), false);
  assert.equal(/persist:/.test(code), false);
  assert.equal(/\bloadURL\b/.test(code), false, 'loads the bundled file only');
});
