'use strict';

// src/main/serviceWorkerNotifications.js - main-process hook for the service-worker preload route
// (BUG-01-B). Uses a stand-in session; the real Electron behaviour is verified by the harness
// described in the BUG-01 report (registerPreloadScript + ServiceWorkerMain.ipc on Electron 44.4.3).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { attachServiceWorkerNotifications, CHANNEL } = require('../src/main/serviceWorkerNotifications.js');

const ALLOWED = ['https://chat.google.com']; // S1: the sign-in origin is NOT a notification source

function makeSession() {
  const workers = new Map();
  const serviceWorkers = new EventEmitter();
  const infoByVersion = new Map();
  serviceWorkers.getWorkerFromVersionID = (id) => workers.get(id);
  serviceWorkers.getInfoFromVersionID = (id) => infoByVersion.get(id);
  serviceWorkers.getAllRunning = () => Object.fromEntries([...workers.keys()].map((k) => [k, infoByVersion.get(k)]));
  const registered = [];
  return {
    registered,
    serviceWorkers,
    running: {},
    registerPreloadScript: (s) => registered.push(s),
    addWorker(id, scope) {
      const ipc = new EventEmitter();
      const worker = { ipc, scope };
      workers.set(id, worker);
      infoByVersion.set(id, { scope });
      return {
        worker,
        emit: (payload) => ipc.emit(CHANNEL, { serviceWorker: { scope } }, payload),
      };
    },
    status: (versionId, runningStatus) =>
      serviceWorkers.emit('running-status-changed', { versionId, runningStatus }),
  };
}

function attach(ses, extra = {}) {
  const shown = [];
  const logs = [];
  attachServiceWorkerNotifications(ses, {
    preloadPath: 'C:\\x\\sw-preload.js',
    allowedOrigins: ALLOWED,
    onShow: (p) => shown.push(p),
    log: (m) => logs.push(m),
    ...extra,
  });
  return { shown, logs };
}

test('registers the service-worker preload script for the session', () => {
  const ses = makeSession();
  attach(ses);
  assert.deepEqual(ses.registered, [{ type: 'service-worker', filePath: 'C:\\x\\sw-preload.js' }]);
});

test('a worker from an allowed scope reaches onShow with its payload', () => {
  const ses = makeSession();
  const { shown } = attach(ses);
  const w = ses.addWorker(1, 'https://chat.google.com/');
  ses.status(1, 'running');
  w.emit({ title: 'Olena' });
  assert.deepEqual(shown, [{ title: 'Olena' }]);
});

test('a worker from a disallowed scope is rejected and logged, never forwarded', () => {
  const ses = makeSession();
  const { shown, logs } = attach(ses);
  const w = ses.addWorker(2, 'https://chat.google.com.evil.example/');
  ses.status(2, 'starting');
  w.emit({ title: 'x' });
  assert.equal(shown.length, 0);
  assert.equal(logs.length, 1);
});

test('a malformed scope is rejected without throwing', () => {
  const ses = makeSession();
  const { shown } = attach(ses);
  const w = ses.addWorker(3, 'not a url');
  ses.status(3, 'running');
  assert.doesNotThrow(() => w.emit({ title: 'x' }));
  assert.equal(shown.length, 0);
});

test('repeated status events for one worker hook it once (no duplicate toasts)', () => {
  const ses = makeSession();
  const { shown } = attach(ses);
  const w = ses.addWorker(4, 'https://chat.google.com/');
  ses.status(4, 'starting');
  ses.status(4, 'running');
  ses.status(4, 'stopping');
  w.emit({ title: 'once' });
  assert.equal(shown.length, 1);
});

test('a stopped worker (undefined) is ignored; a restarted one is hooked again', () => {
  const ses = makeSession();
  const { shown } = attach(ses);
  assert.doesNotThrow(() => ses.status(5, 'stopped'));
  assert.doesNotThrow(() => ses.status(5, 'running')); // no worker registered yet -> undefined
  const w = ses.addWorker(5, 'https://chat.google.com/');
  ses.status(5, 'running');
  w.emit({ title: 'after restart' });
  assert.equal(shown.length, 1);
});

test('only [gcd-sw]-prefixed worker console messages from an ALLOWED scope are logged (S2)', () => {
  const ses = makeSession();
  const { logs } = attach(ses);
  ses.addWorker(6, 'https://chat.google.com/');
  ses.addWorker(7, 'https://evil.example/');
  ses.serviceWorkers.emit('console-message', {}, { versionId: 6, message: 'chat noise' });
  ses.serviceWorkers.emit('console-message', {}, { versionId: 6, message: '[gcd-sw] bridge failed' });
  ses.serviceWorkers.emit('console-message', {}, { versionId: 7, message: '[gcd-sw] forged line' });
  ses.serviceWorkers.emit('console-message', {}, { versionId: 99, message: '[gcd-sw] unknown worker' });
  assert.deepEqual(logs, ['[gcd-sw] bridge failed']);
});

test('S1: a worker whose scope is the sign-in origin is rejected (only chat.google.com may notify)', () => {
  const ses = makeSession();
  const { shown } = attach(ses);
  const w = ses.addWorker(8, 'https://accounts.google.com/');
  ses.status(8, 'running');
  w.emit({ title: 'x' });
  assert.equal(shown.length, 0);
});

test('F5: two DIFFERENT workers that both report versionId 0 are each hooked (identity, not versionId, is the key)', () => {
  const ses = makeSession();
  const { shown } = attach(ses);
  const a = ses.addWorker(0, 'https://chat.google.com/');
  ses.status(0, 'running');
  const b = ses.addWorker(0, 'https://chat.google.com/x/'); // distinct wrapper, same reported id
  ses.status(0, 'running');
  a.emit({ title: 'from a' });
  b.emit({ title: 'from b' });
  assert.equal(shown.length, 2);
});

test('D4: workers already running when the hook is attached are hooked at startup', () => {
  const ses = makeSession();
  const w = ses.addWorker(11, 'https://chat.google.com/');
  const { shown } = attach(ses);
  w.emit({ title: 'early' });
  assert.equal(shown.length, 1);
});

test('D4: a getAllRunning that throws or is missing never breaks attaching', () => {
  const ses = makeSession();
  ses.serviceWorkers.getAllRunning = () => { throw new Error('nope'); };
  assert.doesNotThrow(() => attach(ses));
  const ses2 = makeSession();
  delete ses2.serviceWorkers.getAllRunning;
  assert.doesNotThrow(() => attach(ses2));
});
