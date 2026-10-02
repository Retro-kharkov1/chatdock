'use strict';

// BUG-05: clicking a native toast must open the conversation, as Chat's own handler does in Chrome.
//
// Root cause under test: Chat raises its notifications from its service worker with
// registration.showNotification() and handles the click in the worker's own `notificationclick`
// listener (docs/adr/0004 [S], from a measured note on a real Chat). Electron shows no toast for
// that call, so BUG-01-B re-raises it as a main-process toast and does NOT call the original - which
// means the browser never owns the notification and the worker's `notificationclick` can never
// fire. The click only focused the window, and the payload `data` Chat attached for that handler
// was dropped.
//
// Fix under test: keep `data` through the toast, and on click replay a `notificationclick` inside
// the originating worker (the same listener Chat registered), catching the window-opening calls a
// replay cannot make natively (clients.openWindow / WindowClient.focus / navigate) and routing a
// resulting URL through the app (in-app for Chat's origin, link router otherwise).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const { sanitizeToastRequest, createToastService } = require('../src/main/nativeToast.js');
const { attachServiceWorkerNotifications, CHANNEL, CLICK_CHANNEL, OPEN_CHANNEL } =
  require('../src/main/serviceWorkerNotifications.js');
const { createNotificationOpener } = require('../src/main/notificationOpen.js');
const { createPage } = require('./helpers/pageHarness');

const SW_PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'serviceWorkerPreload.js');
const ALLOWED = ['https://chat.google.com'];

// --- main-process toast service keeps `data` and the origin it came from ------------------------

test('sanitize: JSON-safe `data` is kept as a clone; other shapes are dropped; no `data` key when absent', () => {
  const r = sanitizeToastRequest({ title: 't', data: { url: '/room/AAA/thread/BBB', n: 1 } });
  assert.deepEqual(r.data, { url: '/room/AAA/thread/BBB', n: 1 });
  assert.equal('data' in sanitizeToastRequest({ title: 't' }), false);
  assert.equal('data' in sanitizeToastRequest({ title: 't', data: undefined }), false);
  const huge = { blob: 'x'.repeat(40000) };
  assert.equal('data' in sanitizeToastRequest({ title: 't', data: huge }), false);
  const circular = {};
  circular.self = circular;
  assert.equal('data' in sanitizeToastRequest({ title: 't', data: circular }), false);
});

test('toast service: the request handed to showNativeToast carries data and the trusted scope', () => {
  const toasts = [];
  const service = createToastService({
    showNativeToast: (req) => { toasts.push(req); },
    getMuted: () => false,
    getSoundEnabled: () => true,
    isWindowFocused: () => false,
    onArrival: () => {},
  });
  service.show({ title: 'Olena', body: 'hi', tag: 'm/1', data: { k: 'v' } }, { scope: 'https://chat.google.com/' });
  assert.equal(toasts.length, 1);
  assert.deepEqual(toasts[0].data, { k: 'v' });
  assert.equal(toasts[0].scope, 'https://chat.google.com/');
});

// --- service-worker channel plumbing --------------------------------------------------------------

function makeSession() {
  const serviceWorkers = new EventEmitter();
  const workers = new Map();
  serviceWorkers.getWorkerFromVersionID = (id) => workers.get(id);
  serviceWorkers.getAllRunning = () => ({});
  const started = [];
  serviceWorkers.startWorkerForScope = (scope) => {
    started.push(scope);
    const w = workers.get('byScope:' + scope);
    return w ? Promise.resolve(w) : Promise.reject(new Error('no worker'));
  };
  return {
    serviceWorkers,
    started,
    registerPreloadScript() {},
    addWorker(id, scope) {
      const ipc = new EventEmitter();
      const sent = [];
      const worker = { ipc, scope, send: (...a) => sent.push(a) };
      workers.set(id, worker);
      workers.set('byScope:' + scope, worker);
      return { worker, sent };
    },
  };
}

test('main: a show from an allowed worker reports the worker scope next to the payload', () => {
  const ses = makeSession();
  const shown = [];
  attachServiceWorkerNotifications(ses, {
    preloadPath: 'p', allowedOrigins: ALLOWED, onShow: (p, ctx) => shown.push({ p, ctx }), log: () => {},
  });
  const { worker } = ses.addWorker(1, 'https://chat.google.com/');
  ses.serviceWorkers.emit('running-status-changed', { versionId: 1, runningStatus: 'running' });
  worker.ipc.emit(CHANNEL, { serviceWorker: { scope: 'https://chat.google.com/' } }, { title: 'x', data: { a: 1 } });
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0].p, { title: 'x', data: { a: 1 } });
  assert.equal(shown[0].ctx.scope, 'https://chat.google.com/');
});

test('main: deliverClick starts the worker for the scope and sends the click record to it', async () => {
  const ses = makeSession();
  const { sent } = ses.addWorker(2, 'https://chat.google.com/');
  const api = attachServiceWorkerNotifications(ses, {
    preloadPath: 'p', allowedOrigins: ALLOWED, onShow: () => {}, onOpen: () => {}, log: () => {},
  });
  const record = { title: 't', body: 'b', tag: 'x', data: { k: 1 } };
  await api.deliverClick('https://chat.google.com/', record);
  assert.deepEqual(ses.started, ['https://chat.google.com/']);
  assert.deepEqual(sent, [[CLICK_CHANNEL, record]]);
});

test('main: deliverClick refuses a disallowed scope and never throws when no worker can be started', async () => {
  const ses = makeSession();
  ses.addWorker(3, 'https://chat.google.com.evil.example/');
  const logs = [];
  const api = attachServiceWorkerNotifications(ses, {
    preloadPath: 'p', allowedOrigins: ALLOWED, onShow: () => {}, onOpen: () => {}, log: (m) => logs.push(m),
  });
  await api.deliverClick('https://chat.google.com.evil.example/', { title: 't' });
  await api.deliverClick('https://chat.google.com/', { title: 't' }); // no worker registered
  await api.deliverClick(undefined, { title: 't' });
  assert.deepEqual(ses.started, ['https://chat.google.com/']);
  assert.ok(logs.length >= 1);
});

test('main: an open request from an allowed worker reaches onOpen; one from a disallowed scope does not', () => {
  const ses = makeSession();
  const opened = [];
  attachServiceWorkerNotifications(ses, {
    preloadPath: 'p', allowedOrigins: ALLOWED, onShow: () => {}, onOpen: (u, ctx) => opened.push({ u, ctx }), log: () => {},
  });
  const good = ses.addWorker(4, 'https://chat.google.com/');
  const bad = ses.addWorker(5, 'https://evil.example/');
  ses.serviceWorkers.emit('running-status-changed', { versionId: 4, runningStatus: 'running' });
  ses.serviceWorkers.emit('running-status-changed', { versionId: 5, runningStatus: 'running' });
  good.worker.ipc.emit(OPEN_CHANNEL, { serviceWorker: { scope: 'https://chat.google.com/' } }, 'https://chat.google.com/room/AAA');
  bad.worker.ipc.emit(OPEN_CHANNEL, { serviceWorker: { scope: 'https://evil.example/' } }, 'https://chat.google.com/room/AAA');
  good.worker.ipc.emit(OPEN_CHANNEL, { serviceWorker: { scope: 'https://chat.google.com/' } }, { not: 'a string' });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].u, 'https://chat.google.com/room/AAA');
  assert.equal(opened[0].ctx.scope, 'https://chat.google.com/');
});

// --- opening a URL requested by a notification click ------------------------------------------------

function makeOpener() {
  const calls = { inApp: [], routed: [], focus: 0, logs: [] };
  const opener = createNotificationOpener({
    inAppOrigins: ALLOWED,
    loadInApp: (u) => calls.inApp.push(u),
    route: (u) => calls.routed.push(u),
    focus: () => { calls.focus += 1; },
    log: (...a) => calls.logs.push(a.join(' ')),
  });
  return { opener, calls };
}

test('opener: a Chat-origin URL opens in the app window and focuses it (not the system browser)', () => {
  const { opener, calls } = makeOpener();
  opener.open('https://chat.google.com/u/0/room/AAA/BBB', { scope: 'https://chat.google.com/' });
  assert.deepEqual(calls.inApp, ['https://chat.google.com/u/0/room/AAA/BBB']);
  assert.deepEqual(calls.routed, []);
  assert.equal(calls.focus, 1);
});

test('opener: a relative URL resolves against the worker scope', () => {
  const { opener, calls } = makeOpener();
  opener.open('/u/0/dm/XYZ', { scope: 'https://chat.google.com/' });
  assert.deepEqual(calls.inApp, ['https://chat.google.com/u/0/dm/XYZ']);
});

test('opener: any other origin goes to the link router, so Meet and the scheme rules still apply', () => {
  const { opener, calls } = makeOpener();
  opener.open('https://meet.google.com/abc-defg-hij', { scope: 'https://chat.google.com/' });
  opener.open('https://example.org/x', { scope: 'https://chat.google.com/' });
  opener.open('javascript:alert(1)', { scope: 'https://chat.google.com/' });
  opener.open('https://chat.google.com.evil.example/x', { scope: 'https://chat.google.com/' });
  opener.open('https://user:pw@chat.google.com/x', { scope: 'https://chat.google.com/' });
  assert.deepEqual(calls.inApp, []);
  assert.equal(calls.routed.length, 5);
});

test('opener: junk input is ignored, never throws, and the log never contains the URL', () => {
  const { opener, calls } = makeOpener();
  for (const bad of [undefined, null, 5, {}, '', 'http://']) {
    assert.doesNotThrow(() => opener.open(bad, { scope: 'https://chat.google.com/' }));
  }
  opener.open('https://chat.google.com/room/SECRETID', { scope: 'https://chat.google.com/' });
  assert.ok(!calls.logs.join('\n').includes('SECRETID'));
});

// --- the service-worker preload: data kept, click replayed in the worker -------------------------------

function loadSwPreload() {
  const target = new EventTarget();
  const main = {};
  main.self = main;
  main.console = console;
  main.Date = Date;
  main.URL = URL;
  main.Promise = Promise;
  main.JSON = JSON;
  main.Event = Event;
  main.addEventListener = (...a) => target.addEventListener(...a);
  main.dispatchEvent = (e) => target.dispatchEvent(e);
  main.registration = { scope: 'https://chat.google.com/' };
  class ExtendableEvent extends Event {
    waitUntil() { throw new DOMException('not active', 'InvalidStateError'); }
  }
  main.ExtendableEvent = ExtendableEvent;
  const calls = { originalShow: [], originalOpen: [], originalFocus: [], originalNavigate: [] };
  main.ServiceWorkerRegistration = class { showNotification(...a) { calls.originalShow.push(a); return Promise.resolve(); } };
  main.Clients = class { openWindow(...a) { calls.originalOpen.push(a); return Promise.resolve(null); } };
  main.WindowClient = class {
    focus(...a) { calls.originalFocus.push(a); return Promise.reject(new Error('InvalidAccessError')); }
    navigate(...a) { calls.originalNavigate.push(a); return Promise.resolve(null); }
  };
  main.clients = new main.Clients();
  vm.createContext(main);

  const sent = [];
  const ipcHandlers = {};
  const electronStub = {
    contextBridge: {
      exposeInMainWorld: (name, api) => { main[name] = api; },
      executeInMainWorld: ({ func, args = [] }) => {
        main.__args = args;
        return vm.runInContext(`(${func.toString()}).apply(null, __args)`, main);
      },
    },
    ipcRenderer: {
      send: (...a) => sent.push(a),
      on: (ch, fn) => { ipcHandlers[ch] = fn; },
    },
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
  return { main, sent, ipcHandlers, calls };
}

test('worker preload: showNotification forwards options.data (JSON-safe) next to title/body/tag', () => {
  const w = loadSwPreload();
  w.main.ServiceWorkerRegistration.prototype.showNotification.call({}, 'Olena', {
    body: 'hi', tag: 'm/1', data: { url: '/room/AAA' },
  });
  const [channel, payload] = w.sent[0];
  assert.equal(channel, CHANNEL);
  assert.deepEqual(payload.data, { url: '/room/AAA' });
  assert.equal(payload.title, 'Olena');
  assert.equal(w.calls.originalShow.length, 0, 'the original is still not called');
});

test('worker preload: data that cannot be cloned never breaks the notification', () => {
  const w = loadSwPreload();
  const circular = {};
  circular.self = circular;
  w.main.ServiceWorkerRegistration.prototype.showNotification.call({}, 'Olena', { data: circular });
  assert.equal(w.sent.length, 1);
  assert.equal('data' in w.sent[0][1] && w.sent[0][1].data !== undefined, false);
  assert.equal(w.calls.originalShow.length, 0);
});

test('worker preload: a click record replays notificationclick to the listener Chat registered', () => {
  const w = loadSwPreload();
  const seen = [];
  w.main.addEventListener('notificationclick', (e) => {
    seen.push({ title: e.notification.title, tag: e.notification.tag, data: e.notification.data, action: e.action });
    e.notification.close();
    e.waitUntil(Promise.resolve());
  });
  assert.equal(typeof w.ipcHandlers[CLICK_CHANNEL], 'function', 'the preload subscribes to the click channel');
  w.ipcHandlers[CLICK_CHANNEL]({}, { title: 'Olena', body: 'hi', tag: 'm/1', data: { url: '/room/AAA' } });
  assert.deepEqual(seen, [{ title: 'Olena', tag: 'm/1', data: { url: '/room/AAA' }, action: '' }]);
});

test('worker preload: clients.openWindow during a replay is routed to main, not called natively', async () => {
  const w = loadSwPreload();
  w.main.addEventListener('notificationclick', (e) => {
    e.waitUntil(w.main.clients.openWindow(e.notification.data.url));
  });
  w.ipcHandlers[CLICK_CHANNEL]({}, { title: 't', data: { url: '/u/0/room/AAA' } });
  const open = w.sent.find((s) => s[0] === OPEN_CHANNEL);
  assert.ok(open, 'an open request was sent to main');
  assert.equal(open[1], 'https://chat.google.com/u/0/room/AAA');
  assert.equal(w.calls.originalOpen.length, 0);
});

test('worker preload: WindowClient.focus resolves and navigate is routed to main during a replay', async () => {
  const w = loadSwPreload();
  const client = new w.main.WindowClient();
  w.ipcHandlers[CLICK_CHANNEL]({}, { title: 't', data: {} });
  await assert.doesNotReject(() => client.focus());
  await client.navigate('https://chat.google.com/u/0/dm/ZZZ');
  assert.equal(w.calls.originalFocus.length, 0);
  assert.equal(w.calls.originalNavigate.length, 0);
  assert.deepEqual(w.sent.filter((s) => s[0] === OPEN_CHANNEL).map((s) => s[1]), ['https://chat.google.com/u/0/dm/ZZZ']);
});

test('worker preload: outside a replay openWindow/focus/navigate are untouched', async () => {
  const w = loadSwPreload();
  await w.main.clients.openWindow('https://chat.google.com/x');
  assert.equal(w.calls.originalOpen.length, 1);
  assert.equal(w.sent.filter((s) => s[0] === OPEN_CHANNEL).length, 0);
});

test('worker preload: a replay with no listener, or a malformed record, never throws', () => {
  const w = loadSwPreload();
  assert.doesNotThrow(() => w.ipcHandlers[CLICK_CHANNEL]({}, { title: 't' }));
  assert.doesNotThrow(() => w.ipcHandlers[CLICK_CHANNEL]({}, null));
  assert.doesNotThrow(() => w.ipcHandlers[CLICK_CHANNEL]({}, 'junk'));
});

// --- page-initiated showNotification: same data, same click path ------------------------------------

test('page bridge: showNotification forwards data and the registration scope to main', () => {
  const page = createPage();
  page.inject(true, false);
  page.registration.scope = 'https://chat.google.com/';
  page.showViaServiceWorker('Olena', { body: 'hi', tag: 'm/1', data: { url: '/room/AAA' } });
  const sent = page.record.bridgeShows[0];
  assert.deepEqual(JSON.parse(JSON.stringify(sent.data)), { url: '/room/AAA' });
  assert.equal(sent.scope, 'https://chat.google.com/');
});

test('page bridge: non-cloneable data is dropped, the toast request still goes to main', () => {
  const page = createPage();
  page.inject(true, false);
  const circular = {};
  circular.self = circular;
  page.showViaServiceWorker('Olena', { body: 'hi', data: circular });
  assert.equal(page.record.bridgeShows.length, 1);
  assert.equal(page.record.bridgeShows[0].data, undefined);
  assert.equal(page.record.swShowCalls.length, 0);
});

// --- wiring in index.js (source-level: index.js cannot be required without Electron) ----------------

test('index.js wiring: toast click focuses and replays the click into the worker; open channel is wired', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');
  assert.match(src, /createNotificationOpener\(/);
  assert.match(src, /deliverClick\(/);
  assert.match(src, /onOpen:/);
});
