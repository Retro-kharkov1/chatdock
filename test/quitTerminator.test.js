'use strict';

// Quit-hang fix (owner decision 2026-10-02; docs/architecture/meet-call-window.md section 8 "Risk to
// watch"). On quit: flush persisted state (bounded), and only THEN force-terminate the process.
//
// API contract:
//   src/main/quitTerminator.js
//   createQuitTerminator({ flushers: [{ name, run: () => Promise|void }], timers, timeoutMs = 3000,
//                          requestQuit, terminate, log })
//     -> { onWillQuit(event), onQuit(), onSessionEnd() }
//   - onWillQuit (first call): event.preventDefault(), run every flusher concurrently, bounded by
//     timeoutMs overall; when they settle (or time out) call requestQuit() (app.quit()). A second
//     will-quit after that is let through untouched. A will-quit while flushing is prevented, no 2nd run.
//   - onQuit: terminate() ONLY when the flush phase completed. Never otherwise.
//   - onSessionEnd (OS shutdown/logoff): terminate is disabled for the rest of the process life.
//   - A flusher that throws/rejects never blocks the others or the quit; log gets name only, never
//     the error payload's contents beyond its message.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createManualClock, makeEvent } = require('./helpers/electronFakes');
const { load } = require('./helpers/pending');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flushMicrotasks = () => new Promise((r) => setImmediate(r));

function setup({ flushers, ...opts } = {}) {
  const clock = createManualClock();
  const calls = [];
  const logs = [];
  const t = load('quitTerminator.js').createQuitTerminator({
    flushers: flushers || [],
    timers: clock,
    requestQuit: () => calls.push('requestQuit'),
    terminate: () => calls.push('terminate'),
    log: (m) => logs.push(m),
    ...opts,
  });
  return { t, clock, calls, logs };
}

test('quitTerminator: will-quit is prevented and every flusher runs before requestQuit', async () => {
  const order = [];
  const a = deferred();
  const { t, calls } = setup({
    flushers: [
      { name: 'cookies', run: () => { order.push('cookies'); return a.promise; } },
      { name: 'storage', run: () => { order.push('storage'); } },
    ],
  });
  const ev = makeEvent();
  t.onWillQuit(ev);
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(order, ['cookies', 'storage']);
  await flushMicrotasks();
  assert.deepEqual(calls, []); // cookies flush still pending
  a.resolve();
  await flushMicrotasks();
  assert.deepEqual(calls, ['requestQuit']);
});

test('quitTerminator: terminate happens only at quit, after the flush phase, never before', async () => {
  const { t, calls } = setup({ flushers: [{ name: 'x', run: () => Promise.resolve() }] });
  t.onWillQuit(makeEvent());
  await flushMicrotasks();
  assert.deepEqual(calls, ['requestQuit']);
  const second = makeEvent();
  t.onWillQuit(second); // the re-issued quit
  assert.equal(second.defaultPrevented, false);
  assert.deepEqual(calls, ['requestQuit']);
  t.onQuit();
  assert.deepEqual(calls, ['requestQuit', 'terminate']);
});

test('quitTerminator: a stuck flusher is bounded by timeoutMs, then the quit proceeds', async () => {
  const { t, clock, calls, logs } = setup({
    timeoutMs: 3000,
    flushers: [{ name: 'cookies', run: () => new Promise(() => {}) }],
  });
  t.onWillQuit(makeEvent());
  await flushMicrotasks();
  clock.tick(2999);
  await flushMicrotasks();
  assert.deepEqual(calls, []);
  clock.tick(1);
  await flushMicrotasks();
  assert.deepEqual(calls, ['requestQuit']);
  assert.ok(logs.some((m) => /timed out/i.test(m)));
});

test('quitTerminator: the timeout timer is cleared when flushing finishes first', async () => {
  const { t, clock } = setup({ flushers: [{ name: 'x', run: () => {} }] });
  t.onWillQuit(makeEvent());
  await flushMicrotasks();
  assert.equal(clock.pending(), 0);
});

test('quitTerminator: a throwing or rejecting flusher does not block the others or the quit', async () => {
  const ran = [];
  const { t, calls, logs } = setup({
    flushers: [
      { name: 'bad-sync', run: () => { throw new Error('boom1'); } },
      { name: 'bad-async', run: () => Promise.reject(new Error('boom2')) },
      { name: 'good', run: () => { ran.push('good'); } },
    ],
  });
  t.onWillQuit(makeEvent());
  await flushMicrotasks();
  assert.deepEqual(ran, ['good']);
  assert.deepEqual(calls, ['requestQuit']);
  assert.ok(logs.some((m) => m.includes('bad-sync')));
  assert.ok(logs.some((m) => m.includes('bad-async')));
});

test('quitTerminator: a will-quit while flushing is prevented and does not start a second flush', async () => {
  let runs = 0;
  const d = deferred();
  const { t, calls } = setup({ flushers: [{ name: 'x', run: () => { runs += 1; return d.promise; } }] });
  t.onWillQuit(makeEvent());
  const again = makeEvent();
  t.onWillQuit(again);
  assert.equal(again.defaultPrevented, true);
  assert.equal(runs, 1);
  d.resolve();
  await flushMicrotasks();
  assert.deepEqual(calls, ['requestQuit']); // requested once
});

test('quitTerminator: quit without a completed flush phase never terminates (app.exit / odd paths)', () => {
  const { t, calls } = setup({ flushers: [{ name: 'x', run: () => {} }] });
  t.onQuit();
  assert.deepEqual(calls, []);
});

test('quitTerminator: quit while the flush is still pending never terminates', () => {
  const { t, calls } = setup({ flushers: [{ name: 'x', run: () => new Promise(() => {}) }] });
  t.onWillQuit(makeEvent());
  t.onQuit();
  assert.deepEqual(calls, []);
});

test('quitTerminator: OS session end disables the forced terminate (shutdown path stays untouched)', async () => {
  const { t, calls } = setup({ flushers: [{ name: 'x', run: () => {} }] });
  t.onSessionEnd();
  t.onWillQuit(makeEvent());
  await flushMicrotasks();
  t.onWillQuit(makeEvent());
  t.onQuit();
  assert.equal(calls.includes('terminate'), false);
});

test('quitTerminator: log never receives anything but the flusher name and error message', async () => {
  const secret = 'SID=abc123-cookie-value';
  const { t, logs } = setup({
    flushers: [{ name: 'cookies', run: () => Promise.reject(Object.assign(new Error('failed'), { cookie: secret })) }],
  });
  t.onWillQuit(makeEvent());
  await flushMicrotasks();
  assert.ok(logs.length > 0);
  assert.ok(logs.every((m) => typeof m === 'string' && !m.includes(secret)));
});

test('quitTerminator.sessionFlushers: cookies.flushStore and flushStorageData, from the given session only', async () => {
  const { sessionFlushers } = load('quitTerminator.js');
  const seen = [];
  const ses = {
    cookies: { flushStore: () => { seen.push('cookies'); return Promise.resolve(); } },
    flushStorageData: () => { seen.push('storage'); },
  };
  const fl = sessionFlushers(ses);
  assert.deepEqual(fl.map((f) => f.name), ['cookies', 'storage']);
  for (const f of fl) await f.run();
  assert.deepEqual(seen, ['cookies', 'storage']);
});
