'use strict';

// SECURITY HARDENING: the app's own channels are offered to the CHAT ORIGIN ONLY (main frame of the
// main window / the Chat service worker), never to accounts.google.com, a redirect target, or any
// other page the main window ends up on. docs/architecture/ipc-contract.md "Origin gating".
//   1. preload.js exposes __gcdBridge and installs the smart-copy detector only on the chat origin
//      (the dev loopback stand-in is confirmed by MAIN over a sync channel, never by the page).
//   2. injectNotificationBridge is a no-op unless the main frame is on the chat origin.
//   3. both unread-count paths ignore titles unless the main frame is on the chat origin.
//   4. notification:clicked / :arrived / :show accept chat origin + main frame + the main window's sender.
//   5. serviceWorkerPreload.js exposes __gcdSwBridge only when the worker's own origin is chat.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const gate = require('../src/main/mainFrameGate.js');
const {
  attachUnreadTitleListener,
  readTrustedUnreadCount,
  createNotificationBridgeInjector,
} = require('../src/main/notifications.js');

const CHAT = 'https://chat.google.com';
const ORIGINS = [CHAT];
const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'preload.js');
const SW_PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'serviceWorkerPreload.js');
const MAIN_INDEX = path.join(__dirname, '..', 'src', 'main', 'index.js');

const OFF_ORIGIN_URLS = [
  'https://accounts.google.com/v3/signin',
  'https://chat.google.com.evil.example/',
  'http://chat.google.com/',
  'https://evil.example/',
  'about:blank',
  'file:///C:/x.html',
  'data:text/html,hi',
  '',
];

// --- the gate -------------------------------------------------------------------------------------

test('gate.urlOrigin: http(s) origins only; junk and opaque origins are undefined', () => {
  assert.equal(gate.urlOrigin('https://chat.google.com/u/0/room/AAA'), CHAT);
  assert.equal(gate.urlOrigin('http://127.0.0.1:8080/x'), 'http://127.0.0.1:8080');
  for (const bad of ['about:blank', 'file:///x', 'data:text/html,x', '', 'nope', undefined, null, 5]) {
    assert.equal(gate.urlOrigin(bad), undefined, String(bad));
  }
});

function fakeContents(url, { viaMainFrame = true } = {}) {
  const wc = new EventEmitter();
  wc.getURL = () => url;
  wc.mainFrame = viaMainFrame ? { url } : undefined;
  wc.isDestroyed = () => false;
  return wc;
}

test('gate.isChatMainFrame: true only when the main frame URL origin is on the list', () => {
  assert.equal(gate.isChatMainFrame(fakeContents(CHAT + '/'), ORIGINS), true);
  for (const url of OFF_ORIGIN_URLS) assert.equal(gate.isChatMainFrame(fakeContents(url), ORIGINS), false, url);
  assert.equal(gate.isChatMainFrame(fakeContents(CHAT + '/', { viaMainFrame: false }), ORIGINS), true, 'falls back to getURL()');
  assert.equal(gate.isChatMainFrame(null, ORIGINS), false);
  assert.equal(gate.isChatMainFrame({}, ORIGINS), false);
  const destroyed = fakeContents(CHAT + '/');
  destroyed.isDestroyed = () => true;
  assert.equal(gate.isChatMainFrame(destroyed, ORIGINS), false);
  assert.equal(gate.isChatMainFrame(fakeContents(CHAT + '/'), []), false);
});

test('gate.isTrustedMainSender: needs the main window sender, its main frame, and a chat-origin frame', () => {
  const wc = fakeContents(CHAT + '/');
  wc.mainFrame = { url: CHAT + '/', origin: CHAT };
  const ok = { sender: wc, senderFrame: wc.mainFrame };
  assert.equal(gate.isTrustedMainSender(ok, wc, ORIGINS), true);
  // another webContents (e.g. the settings window) with the very same origin
  assert.equal(gate.isTrustedMainSender({ sender: fakeContents(CHAT + '/'), senderFrame: wc.mainFrame }, wc, ORIGINS), false);
  // a sub-frame of the main window
  assert.equal(gate.isTrustedMainSender({ sender: wc, senderFrame: { url: CHAT + '/', origin: CHAT } }, wc, ORIGINS), false);
  // main frame but off-origin
  const off = fakeContents('https://accounts.google.com/');
  off.mainFrame = { url: 'https://accounts.google.com/', origin: 'https://accounts.google.com' };
  assert.equal(gate.isTrustedMainSender({ sender: off, senderFrame: off.mainFrame }, off, ORIGINS), false);
  // frame origin on the list but the window is currently somewhere else (navigated since the frame was created)
  const stale = fakeContents('https://accounts.google.com/');
  stale.mainFrame = { url: 'https://accounts.google.com/', origin: CHAT };
  assert.equal(gate.isTrustedMainSender({ sender: stale, senderFrame: stale.mainFrame }, stale, ORIGINS), false);
  assert.equal(gate.isTrustedMainSender({ sender: wc }, wc, ORIGINS), false, 'no senderFrame');
  assert.equal(gate.isTrustedMainSender(null, wc, ORIGINS), false);
  assert.equal(gate.isTrustedMainSender(ok, null, ORIGINS), false);
});

test('gate.createMainFrameGuard: accept() logs a rejection with the channel and never the payload', () => {
  const wc = fakeContents('https://accounts.google.com/');
  wc.mainFrame = { url: 'https://accounts.google.com/', origin: 'https://accounts.google.com' };
  const logs = [];
  const guard = gate.createMainFrameGuard({ getWebContents: () => wc, origins: ORIGINS, log: (m) => logs.push(m) });
  assert.equal(guard.accept({ sender: wc, senderFrame: wc.mainFrame }, 'notification:clicked'), false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /notification:clicked/);
  const chat = fakeContents(CHAT + '/');
  chat.mainFrame = { url: CHAT + '/', origin: CHAT };
  const g2 = gate.createMainFrameGuard({ getWebContents: () => chat, origins: ORIGINS, log: () => {} });
  assert.equal(g2.accept({ sender: chat, senderFrame: chat.mainFrame }, 'x'), true);
  const g3 = gate.createMainFrameGuard({ getWebContents: () => null, origins: ORIGINS, log: () => {} });
  assert.equal(g3.accept({ sender: chat, senderFrame: chat.mainFrame }, 'x'), false, 'no main window yet');
});

test('gate.registerBridgeProbe: answers the preload synchronously, true only for a trusted main frame', () => {
  const handlers = {};
  const ipcMain = { on: (ch, fn) => { handlers[ch] = fn; } };
  const wc = fakeContents('http://127.0.0.1:9000/');
  wc.mainFrame = { url: 'http://127.0.0.1:9000/', origin: 'http://127.0.0.1:9000' };
  gate.registerBridgeProbe(ipcMain, { getWebContents: () => wc, origins: ['http://127.0.0.1:9000'] });
  assert.equal(typeof handlers[gate.BRIDGE_PROBE_CHANNEL], 'function');
  const e = { sender: wc, senderFrame: wc.mainFrame, returnValue: undefined };
  handlers[gate.BRIDGE_PROBE_CHANNEL](e);
  assert.equal(e.returnValue, true);
  const e2 = { sender: fakeContents('http://127.0.0.1:9000/'), senderFrame: wc.mainFrame, returnValue: undefined };
  handlers[gate.BRIDGE_PROBE_CHANNEL](e2);
  assert.equal(e2.returnValue, false);
  // production origins: a loopback page is refused
  const prod = {};
  gate.registerBridgeProbe({ on: (ch, fn) => { prod[ch] = fn; } }, { getWebContents: () => wc, origins: ORIGINS });
  const e3 = { sender: wc, senderFrame: wc.mainFrame, returnValue: undefined };
  prod[gate.BRIDGE_PROBE_CHANNEL](e3);
  assert.equal(e3.returnValue, false);
});

// --- 1. main-window preload ---------------------------------------------------------------------------

function loadPagePreload({ origin, parentIsSelf = true, probeAnswer = false }) {
  const exposed = [];
  const sent = [];
  const syncCalls = [];
  const listeners = [];
  const electronStub = {
    contextBridge: { exposeInMainWorld: (name, api) => exposed.push({ name, api }) },
    ipcRenderer: {
      send: (...a) => sent.push(a),
      sendSync: (...a) => { syncCalls.push(a); return probeAnswer; },
      invoke: () => { throw new Error('must not invoke'); },
      on: () => { throw new Error('must not subscribe'); },
    },
  };
  const windowFake = {
    document: { body: {}, activeElement: null },
    location: { origin },
    addEventListener: (type, listener, options) => listeners.push({ type, listener, options }),
    getSelection: () => null,
  };
  windowFake.parent = parentIsSelf ? windowFake : {};
  const savedWindow = global.window;
  const savedDocument = global.document;
  global.window = windowFake;
  global.document = windowFake.document;
  const original = Module._load;
  Module._load = function patched(request, ...rest) {
    if (request === 'electron') return electronStub;
    return original.call(this, request, ...rest);
  };
  try {
    delete require.cache[PRELOAD];
    require(PRELOAD);
  } finally {
    Module._load = original;
    delete require.cache[PRELOAD];
    if (savedWindow === undefined) delete global.window; else global.window = savedWindow;
    if (savedDocument === undefined) delete global.document; else global.document = savedDocument;
  }
  return { exposed, sent, syncCalls, listeners };
}

test('preload: on the chat origin the bridge is exposed and the smart-copy detector installed', () => {
  const p = loadPagePreload({ origin: CHAT });
  assert.deepEqual(p.exposed.map((e) => e.name), ['__gcdBridge']);
  assert.deepEqual(Object.keys(p.exposed[0].api).sort(), ['notificationArrived', 'notificationClicked', 'notificationShow']);
  assert.deepEqual(p.listeners.map((l) => l.type).sort(), ['mousedown', 'mouseup']);
  assert.equal(p.syncCalls.length, 0, 'the chat origin needs no round trip to main');
});

for (const origin of ['https://accounts.google.com', 'https://chat.google.com.evil.example', 'http://chat.google.com',
  'https://evil.example', 'null', '', 'file://']) {
  test(`preload: off-origin (${origin || 'empty'}) exposes nothing and installs no listener`, () => {
    const p = loadPagePreload({ origin, probeAnswer: true });
    assert.deepEqual(p.exposed, []);
    assert.deepEqual(p.listeners, []);
    assert.deepEqual(p.sent, []);
    assert.equal(p.syncCalls.length, 0, 'a non-loopback origin never even asks main');
  });
}

test('preload: a sub-frame of the chat origin gets nothing', () => {
  const p = loadPagePreload({ origin: CHAT, parentIsSelf: false });
  assert.deepEqual(p.exposed, []);
  assert.deepEqual(p.listeners, []);
});

test('preload: a loopback page gets the bridge only if MAIN says so; a page cannot decide it', () => {
  const yes = loadPagePreload({ origin: 'http://127.0.0.1:8123', probeAnswer: true });
  assert.deepEqual(yes.syncCalls, [[gate.BRIDGE_PROBE_CHANNEL]]);
  assert.deepEqual(yes.exposed.map((e) => e.name), ['__gcdBridge']);
  assert.equal(yes.listeners.length, 2);
  const no = loadPagePreload({ origin: 'http://localhost:8123', probeAnswer: false });
  assert.equal(no.syncCalls.length, 1);
  assert.deepEqual(no.exposed, []);
  assert.deepEqual(no.listeners, []);
  // anything other than the literal `true` (e.g. a truthy string) is a no
  const odd = loadPagePreload({ origin: 'http://127.0.0.1:1', probeAnswer: 'yes' });
  assert.deepEqual(odd.exposed, []);
});

test('preload: no process.argv / env dependency for the dev origin', () => {
  const src = fs.readFileSync(PRELOAD, 'utf8');
  assert.doesNotMatch(src, /process\.(argv|env)/);
  assert.match(src, /CHAT_ORIGIN\s*=\s*'https:\/\/chat\.google\.com'/);
});

// --- 2. injectNotificationBridge ----------------------------------------------------------------------

function injectorFor(url, { settings = { soundEnabled: true, notificationsMuted: false } } = {}) {
  const wc = fakeContents(url);
  const scripts = [];
  wc.executeJavaScript = (s) => { scripts.push(s); return Promise.resolve(); };
  const logs = [];
  const inject = createNotificationBridgeInjector({
    getWebContents: () => wc,
    getSettings: () => settings,
    origins: ORIGINS,
    log: (...a) => logs.push(a),
  });
  return { inject, scripts, logs, wc };
}

test('injector: injects on the chat origin, with the current sound/mute values', () => {
  const { inject, scripts } = injectorFor(CHAT + '/u/0/');
  inject();
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /window\.__gcdSoundEnabled = true;/);
  assert.match(scripts[0], /window\.__gcdMuted = false;/);
});

test('injector: a no-op on every other origin, whoever the caller is', () => {
  for (const url of OFF_ORIGIN_URLS) {
    const { inject, scripts } = injectorFor(url);
    inject();
    inject();
    assert.equal(scripts.length, 0, url);
  }
});

test('injector: no window / destroyed window is a no-op and never throws', () => {
  const none = createNotificationBridgeInjector({ getWebContents: () => null, getSettings: () => ({}), origins: ORIGINS, log: () => {} });
  assert.doesNotThrow(() => none());
  const { inject, wc, scripts } = injectorFor(CHAT + '/');
  wc.isDestroyed = () => true;
  inject();
  assert.equal(scripts.length, 0);
});

test('injector: a rejected injection is logged as DEGRADED, not swallowed', async () => {
  const { inject, wc, logs } = injectorFor(CHAT + '/');
  wc.executeJavaScript = () => Promise.reject(new Error('csp'));
  inject();
  await new Promise((r) => setImmediate(r));
  assert.equal(logs.length, 1);
  assert.match(String(logs[0][0]), /DEGRADED/);
});

// --- 3. unread count ----------------------------------------------------------------------------------

test('unread title listener: chat origin reports; every other origin is ignored', () => {
  for (const [url, expected] of [[CHAT + '/', [3]], ['https://accounts.google.com/', []], ['https://evil.example/', []]]) {
    const wc = fakeContents(url);
    const seen = [];
    attachUnreadTitleListener(wc, (n) => seen.push(n), () => gate.isChatMainFrame(wc, ORIGINS));
    wc.emit('page-title-updated', {}, '(3) Google Chat');
    assert.deepEqual(seen, expected, url);
  }
});

test('unread title listener: the origin is re-evaluated on every event (navigating away stops reporting)', () => {
  const wc = fakeContents(CHAT + '/');
  const seen = [];
  attachUnreadTitleListener(wc, (n) => seen.push(n), () => gate.isChatMainFrame(wc, ORIGINS));
  wc.emit('page-title-updated', {}, '(1) Google Chat');
  wc.mainFrame = { url: 'https://accounts.google.com/' };
  wc.emit('page-title-updated', {}, '(99) Fake');
  wc.mainFrame = { url: CHAT + '/' };
  wc.emit('page-title-updated', {}, '(2) Google Chat');
  assert.deepEqual(seen, [1, 2]);
});

test('unread title listener: with no origin predicate it fails closed', () => {
  const wc = fakeContents(CHAT + '/');
  const seen = [];
  attachUnreadTitleListener(wc, (n) => seen.push(n));
  wc.emit('page-title-updated', {}, '(3) Google Chat');
  assert.deepEqual(seen, []);
});

test('unread seed (did-finish-load): the title count on the chat origin, null elsewhere', () => {
  const chat = fakeContents(CHAT + '/');
  chat.getTitle = () => '(4) Google Chat';
  assert.equal(readTrustedUnreadCount(chat, ORIGINS), 4);
  const off = fakeContents('https://accounts.google.com/');
  off.getTitle = () => '(4) Sign in';
  assert.equal(readTrustedUnreadCount(off, ORIGINS), null);
  chat.getTitle = () => 'Google Chat';
  assert.equal(readTrustedUnreadCount(chat, ORIGINS), 0);
  assert.equal(readTrustedUnreadCount(null, ORIGINS), null);
});

// --- 4. index.js wiring (source-level: index.js cannot be required without Electron) ----------------------

const indexSrc = fs.readFileSync(MAIN_INDEX, 'utf8');

test('index.js: notification:clicked / :arrived / :show go through the main-frame guard, not a bare origin list', () => {
  for (const ch of ['notification:clicked', 'notification:arrived', 'notification:show']) {
    const m = new RegExp(`ipcMain\\.on\\('${ch}'[\\s\\S]{0,260}`).exec(indexSrc);
    assert.ok(m, ch);
    assert.match(m[0], /mainFrameGuard\.accept\(event, '/, ch);
  }
  assert.doesNotMatch(indexSrc, /isAllowedSender\(senderOrigin, ALLOWED_ORIGINS\)/, 'the sign-in origin is no longer accepted');
  assert.match(indexSrc, /registerBridgeProbe\(/);
});

test('index.js: the bridge is injected only through the origin-checked injector; unread uses the trusted paths', () => {
  assert.doesNotMatch(indexSrc, /webContents\.executeJavaScript\(/);
  assert.match(indexSrc, /createNotificationBridgeInjector\(/);
  assert.match(indexSrc, /readTrustedUnreadCount\(/);
  assert.doesNotMatch(indexSrc, /parseUnreadCount\(mainWindow\.webContents\.getTitle\(\)\)/);
  assert.match(indexSrc, /attachUnreadTitleListener\([\s\S]{0,900}isChatMainFrame\(contents/);
});

test('index.js: settings:get / settings:set accept only the Settings window', () => {
  for (const ch of ['settings:get', 'settings:set']) {
    const m = new RegExp(`ipcMain\\.handle\\('${ch}'[\\s\\S]{0,260}`).exec(indexSrc);
    assert.ok(m, ch);
    assert.match(m[0], /fromSettingsWindow\(event\)/, ch);
  }
});

// --- 5. service-worker preload ---------------------------------------------------------------------------

function loadSwPreloadAt(workerOrigin, { readFails = false } = {}) {
  const main = {};
  main.self = main;
  main.console = console;
  main.Date = Date;
  main.URL = URL;
  main.Promise = Promise;
  main.JSON = JSON;
  main.addEventListener = () => {};
  main.location = { origin: workerOrigin };
  main.registration = { scope: workerOrigin + '/' };
  vm.createContext(main);
  const exposed = [];
  const subscribed = [];
  const executed = [];
  const electronStub = {
    contextBridge: {
      exposeInMainWorld: (name, api) => { exposed.push({ name, api }); },
      executeInMainWorld: ({ func, args = [] }) => {
        executed.push(func.toString().slice(0, 60));
        if (readFails) throw new Error('no main world');
        main.__args = args;
        return vm.runInContext(`(${func.toString()}).apply(null, __args)`, main);
      },
    },
    ipcRenderer: { send: () => {}, on: (ch) => subscribed.push(ch) },
  };
  const original = Module._load;
  Module._load = function patched(request, ...rest) {
    if (request === 'electron') return electronStub;
    return original.call(this, request, ...rest);
  };
  try {
    delete require.cache[SW_PRELOAD];
    require(SW_PRELOAD);
  } finally {
    Module._load = original;
    delete require.cache[SW_PRELOAD];
  }
  return { exposed, subscribed, executed, main };
}

test('sw preload: on the chat origin __gcdSwBridge is exposed and the click channel is subscribed', () => {
  const w = loadSwPreloadAt(CHAT);
  assert.deepEqual(w.exposed.map((e) => e.name), ['__gcdSwBridge']);
  assert.deepEqual(Object.keys(w.exposed[0].api).sort(), ['open', 'show']);
  assert.ok(w.subscribed.includes('notification:sw-click'));
});

for (const origin of ['https://accounts.google.com', 'https://chat.google.com.evil.example', 'http://chat.google.com',
  'https://evil.example', 'http://127.0.0.1:8123']) {
  test(`sw preload: a worker on ${origin} gets no bridge, no subscription, no patches`, () => {
    const w = loadSwPreloadAt(origin);
    assert.deepEqual(w.exposed, []);
    assert.deepEqual(w.subscribed, []);
    assert.equal(w.executed.length, 1, 'only the origin read ran in the main world');
  });
}

test('sw preload: when the origin cannot be read, nothing is exposed (fail closed)', () => {
  const w = loadSwPreloadAt(CHAT, { readFails: true });
  assert.deepEqual(w.exposed, []);
  assert.deepEqual(w.subscribed, []);
  const src = fs.readFileSync(SW_PRELOAD, 'utf8');
  assert.match(src, /CHAT_ORIGIN\s*=\s*'https:\/\/chat\.google\.com'/);
  assert.match(src, /self\.location\.origin/);
});
