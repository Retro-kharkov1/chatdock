'use strict';

// UI-01 display-media handler (docs/architecture/meet-call-window.md section 6 "Display-media handler"
// and section 7 teardown). RED until src/main/meetPermissions.js exports createDisplayMediaGate.
//
// API contract assumed (doc is silent on the exact shape):
//
//   src/main/meetPermissions.js
//     createDisplayMediaGate({ getCallWindow, picker, log })
//       -> { handler(request, callback), abortPending() }
//
//     handler is what session.setDisplayMediaRequestHandler receives (via
//     configurePersistentSession's `displayMediaHandler` option).
//       request  = Electron's DisplayMediaRequest subset: { securityOrigin, userGesture,
//                  frame: { top: { url } } (WebFrameMain: the top-level page is frame.top),
//                  videoRequested, audioRequested }
//       callback = called EXACTLY ONCE per request. Allow: callback({ video: <the source object> })
//                  and NO audio key (video only, no loopback). Deny: callback invoked with NO streams
//                  (no `video`, no `audio`); the exact form (undefined, {}) is the implementer's.
//     Gate order, any failure denies WITHOUT opening the picker: (1) userGesture === true,
//       (2) origin gate on securityOrigin and frame.top.url, (3) getCallWindow() returns a window that
//       is not destroyed, (4) no other display request pending, (5) picker.open(callWindow),
//       (6) the chosen sourceId must be in the list main sent.
//     picker (see pickerWindow.test.js for the real one):
//       open(parentWindow) -> Promise<{ sourceId: string, sources: object[] } | null>
//         null = cancelled / closed / aborted; `sources` = the raw list main sent to that picker, each
//         with at least { id }.
//       abortPending() -> void
//     abortPending() (the teardown hook of section 4): calls picker.abortPending(), denies the pending
//       request (callback once) and forgets it; a choice arriving later is dropped.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { settle, createFakeBrowserWindowClass } = require('./helpers/electronFakes');
const { load } = require('./helpers/pending');

const MEET = 'https://meet.google.com';
const SOURCES = [
  { id: 'screen:1:0', name: 'Entire screen' },
  { id: 'window:42:0', name: 'Some window' },
];

function isDenied(streams) {
  return streams === undefined || streams === null || (streams.video === undefined && streams.audio === undefined);
}

function makeRequest(overrides = {}) {
  return {
    securityOrigin: `${MEET}/`,
    userGesture: true,
    videoRequested: true,
    audioRequested: false,
    frame: { top: { url: `${MEET}/abc-defg-hij`, origin: MEET } },
    ...overrides,
  };
}

function setup({ withWindow = true } = {}) {
  const Win = createFakeBrowserWindowClass();
  const callWindow = new Win({});
  const state = { window: withWindow ? callWindow : null, opens: [], abortCalls: 0, pendingOpens: [] };
  const picker = {
    open(parent) {
      state.opens.push(parent);
      return new Promise((resolve) => state.pendingOpens.push(resolve));
    },
    abortPending() {
      state.abortCalls += 1;
    },
  };
  const gate = load('meetPermissions.js').createDisplayMediaGate({
    getCallWindow: () => state.window,
    picker,
    log: () => {},
  });
  const results = [];
  const run = (request = makeRequest()) => {
    const record = { calls: 0, streams: undefined };
    results.push(record);
    gate.handler(request, (streams) => { record.calls += 1; record.streams = streams; });
    return record;
  };
  return { gate, state, callWindow, run, answer: async (i, value) => { await settle(); state.pendingOpens[i](value); } };
}

// --- gate order: deny without ever showing a picker ----------------------------------------------

test('display-media: userGesture false is denied and no picker is shown', () => {
  const { run, state } = setup();
  const r = run(makeRequest({ userGesture: false }));
  assert.equal(r.calls, 1);
  assert.equal(isDenied(r.streams), true);
  assert.equal(state.opens.length, 0);
});

test('display-media: userGesture absent or truthy-but-not-true is denied (strict)', () => {
  const { run, state } = setup();
  for (const userGesture of [undefined, null, 'true', 1]) {
    const r = run(makeRequest({ userGesture }));
    assert.equal(r.calls, 1);
    assert.equal(isDenied(r.streams), true, String(userGesture));
  }
  assert.equal(state.opens.length, 0);
});

test('display-media: non-Meet securityOrigin is denied without a picker', () => {
  const { run, state } = setup();
  for (const securityOrigin of ['https://chat.google.com/', 'https://evil.example/', 'http://meet.google.com/', 'https://meet.google.com.evil.example/', undefined, 'not a url']) {
    const r = run(makeRequest({ securityOrigin }));
    assert.equal(r.calls, 1, String(securityOrigin));
    assert.equal(isDenied(r.streams), true, String(securityOrigin));
  }
  assert.equal(state.opens.length, 0);
});

test('display-media: a Meet frame embedded in a non-Meet top-level page is denied', () => {
  const { run, state } = setup();
  for (const top of ['https://chat.google.com/', 'https://evil.example/x']) {
    const r = run(makeRequest({ frame: { top: { url: top, origin: new URL(top).origin } } }));
    assert.equal(r.calls, 1, top);
    assert.equal(isDenied(r.streams), true, top);
  }
  assert.equal(state.opens.length, 0);
});

test('display-media: a missing frame or top-level page fails closed', () => {
  const { run, state } = setup();
  for (const frame of [undefined, null, {}, { top: null }]) {
    const r = run(makeRequest({ frame }));
    assert.equal(r.calls, 1);
    assert.equal(isDenied(r.streams), true);
  }
  assert.equal(state.opens.length, 0);
});

test('display-media: no call window is denied without a picker (the picker needs its parent)', () => {
  const { run, state } = setup({ withWindow: false });
  const r = run();
  assert.equal(r.calls, 1);
  assert.equal(isDenied(r.streams), true);
  assert.equal(state.opens.length, 0);
});

test('display-media: a destroyed call window is denied without a picker', () => {
  const { run, state, callWindow } = setup();
  callWindow.destroy();
  const r = run();
  assert.equal(r.calls, 1);
  assert.equal(isDenied(r.streams), true);
  assert.equal(state.opens.length, 0);
});

// --- picker interplay ------------------------------------------------------------------------------

test('display-media: a valid request opens the picker straight away (no later than the next tick), as a child of the call window, and shares nothing until the user answers', async () => {
  const { run, state, callWindow } = setup();
  const r = run();
  await settle();
  assert.equal(state.opens.length, 1);
  assert.equal(state.opens[0], callWindow);
  assert.equal(r.calls, 0, 'nothing is returned to the page without a user action');
});

test('display-media: the chosen source is returned exactly, video only, callback once', async () => {
  const { run, answer } = setup();
  const r = run();
  await answer(0, { sourceId: 'window:42:0', sources: SOURCES });
  await settle();
  assert.equal(r.calls, 1);
  assert.equal(r.streams.video, SOURCES[1]);
  assert.equal(r.streams.audio, undefined);
});

test('display-media: a sourceId that is not in the list main sent is denied', async () => {
  const { run, answer } = setup();
  const r = run();
  await answer(0, { sourceId: 'screen:999:0', sources: SOURCES });
  await settle();
  assert.equal(r.calls, 1);
  assert.equal(isDenied(r.streams), true);
});

test('display-media: an empty, missing or non-string sourceId is denied', async () => {
  for (const sourceId of ['', undefined, null, 42, {}]) {
    const { run, answer } = setup();
    const r = run();
    await answer(0, { sourceId, sources: SOURCES });
    await settle();
    assert.equal(r.calls, 1, String(sourceId));
    assert.equal(isDenied(r.streams), true, String(sourceId));
  }
});

test('display-media: cancel (picker resolves null) denies, callback once', async () => {
  const { run, answer } = setup();
  const r = run();
  await answer(0, null);
  await settle();
  assert.equal(r.calls, 1);
  assert.equal(isDenied(r.streams), true);
});

test('display-media: a picker failure (rejection) denies, callback once', async () => {
  const Win = createFakeBrowserWindowClass();
  const win = new Win({});
  const gate = load('meetPermissions.js').createDisplayMediaGate({
    getCallWindow: () => win,
    picker: { open: () => Promise.reject(new Error('boom')), abortPending() {} },
    log: () => {},
  });
  let calls = 0;
  let streams;
  gate.handler(makeRequest(), (s) => { calls += 1; streams = s; });
  await settle();
  assert.equal(calls, 1);
  assert.equal(isDenied(streams), true);
});

test('display-media: a second request while one is pending is denied and does not open a second picker', async () => {
  const { run, state, answer } = setup();
  const first = run();
  const second = run();
  assert.equal(second.calls, 1);
  assert.equal(isDenied(second.streams), true);
  await settle();
  assert.equal(state.opens.length, 1);
  assert.equal(first.calls, 0);
  await answer(0, { sourceId: 'screen:1:0', sources: SOURCES });
  await settle();
  assert.equal(first.calls, 1);
  assert.equal(first.streams.video, SOURCES[0]);
});

test('display-media: after an answer the gate is free for the next request', async () => {
  const { run, state, answer } = setup();
  run();
  await answer(0, null);
  await settle();
  const next = run();
  await settle();
  assert.equal(state.opens.length, 2);
  await answer(1, { sourceId: 'screen:1:0', sources: SOURCES });
  await settle();
  assert.equal(next.calls, 1);
  assert.equal(next.streams.video, SOURCES[0]);
});

// --- teardown --------------------------------------------------------------------------------------

test('display-media abortPending: closes the picker, denies the pending request exactly once', async () => {
  const { gate, run, state } = setup();
  const r = run();
  gate.abortPending();
  await settle();
  assert.equal(state.abortCalls, 1);
  assert.equal(r.calls, 1);
  assert.equal(isDenied(r.streams), true);
});

test('display-media abortPending: a selection arriving after teardown is dropped (no second callback, nothing shared)', async () => {
  const { gate, run, answer } = setup();
  const r = run();
  gate.abortPending();
  await answer(0, { sourceId: 'screen:1:0', sources: SOURCES });
  await settle();
  assert.equal(r.calls, 1);
  assert.equal(isDenied(r.streams), true);
});

test('display-media abortPending with nothing pending is a harmless no-op', () => {
  const { gate } = setup();
  assert.doesNotThrow(() => gate.abortPending());
});

test('display-media: a choice that arrives after the call window was destroyed is denied, callback once', async () => {
  const { run, answer, callWindow } = setup();
  const r = run();
  callWindow.destroy();
  await answer(0, { sourceId: 'screen:1:0', sources: SOURCES });
  await settle();
  assert.equal(r.calls, 1);
  assert.equal(isDenied(r.streams), true);
});

test('display-media: an abort followed by a new request works (the pending slot is released)', async () => {
  const { gate, run, state, answer } = setup();
  run();
  gate.abortPending();
  const next = run();
  await settle();
  assert.equal(state.opens.length, 2);
  await answer(1, { sourceId: 'window:42:0', sources: SOURCES });
  await settle();
  assert.equal(next.calls, 1);
  assert.equal(next.streams.video, SOURCES[1]);
});
