'use strict';

// UI-01 link router factory (docs/architecture/meet-call-window.md section 3). RED until
// src/main/linkRouter.js exists (and, for the "real classifier" block, src/main/meetLink.js).
//
// API under test (named exactly as the architecture doc names it):
//
//   createLinkRouter({ classifyLink, isOpenableExternalScheme, openCallWindow, openExternal, log })
//     -> { route(url), onWindowOpen({ url }), onWillNavigate(event, url, { allowedOrigins }) }
//
//   route(url) -> 'call-window' | 'external' | 'dropped'
//     - classifyLink(url): 'call-window' -> openCallWindow(result.url)  (the NORMALISED url)
//     - otherwise isOpenableExternalScheme(url) -> openExternal(url)    (the url as given)
//     - otherwise log(...) with the scheme only, NEVER the url, and drop (neither collaborator called)
//   onWindowOpen({ url }) -> { action: 'deny' } always (route(url) as a side effect; never throws)
//   onWillNavigate(event, url, { allowedOrigins }) -> void
//     - origin (new URL(url).origin) in allowedOrigins: untouched (no preventDefault, no routing)
//     - anything else, unparseable included: event.preventDefault() and route(url); a missing /
//       non-array allowedOrigins allows nothing (fail closed)
//
// `log` is called as log(message, ...args) in any form; the tests only check that something is logged
// for a dropped link and that the logged payload carries the scheme but no part of the url.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEvent } = require('./helpers/electronFakes');
const { load } = require('./helpers/pending');

const MEET = 'https://meet.google.com/abc-defg-hij';
const CHAT_ORIGIN = 'https://chat.google.com';
const ACCOUNTS_ORIGIN = 'https://accounts.google.com';
const ALLOWED = [CHAT_ORIGIN, ACCOUNTS_ORIGIN];
const SECRET_PATH = '/very-secret-path-token-123';

// A classifier fake with the same contract as meetLink.classifyLink, controlled per test.
function fakeClassify(table = {}) {
  return (url) => table[url] || { outcome: 'system-browser', url };
}
const openableByScheme = (url) => /^(https?:|mailto:)/i.test(String(url));

function setup({ classify = fakeClassify({ [MEET]: { outcome: 'call-window', url: MEET } }) } = {}) {
  const calls = { callWindow: [], external: [], log: [] };
  const router = load('linkRouter.js').createLinkRouter({
    classifyLink: classify,
    isOpenableExternalScheme: openableByScheme,
    openCallWindow: (url) => calls.callWindow.push(url),
    openExternal: (url) => calls.external.push(url),
    log: (...args) => calls.log.push(args),
  });
  return { router, calls };
}

// --- route ---------------------------------------------------------------------------------------

test('linkRouter.route: a Meet link opens the call window once with the normalised url, never the system browser', () => {
  const normalised = 'https://meet.google.com/abc-defg-hij';
  const raw = 'HTTPS://MEET.GOOGLE.COM/abc-defg-hij';
  const { router, calls } = setup({ classify: fakeClassify({ [raw]: { outcome: 'call-window', url: normalised } }) });
  assert.equal(router.route(raw), 'call-window');
  assert.deepEqual(calls.callWindow, [normalised]);
  assert.deepEqual(calls.external, []);
});

test('linkRouter.route: https, http and mailto links go to the system browser, as given', () => {
  const { router, calls } = setup();
  for (const url of ['https://example.org/page', 'http://example.org/page', 'mailto:someone@example.org']) {
    assert.equal(router.route(url), 'external', url);
  }
  assert.deepEqual(calls.external, ['https://example.org/page', 'http://example.org/page', 'mailto:someone@example.org']);
  assert.deepEqual(calls.callWindow, []);
});

test('linkRouter.route: a disallowed scheme reaches neither the call window nor the OS', () => {
  const { router, calls } = setup();
  for (const url of ['file:///C:/Windows/System32/calc.exe', 'ms-settings:privacy', 'javascript:alert(1)', 'ssh://host.example', 'not a url', '']) {
    assert.equal(router.route(url), 'dropped', url);
  }
  assert.deepEqual(calls.external, []);
  assert.deepEqual(calls.callWindow, []);
});

test('linkRouter.route: a dropped link is logged with its scheme, never with the url', () => {
  const { router, calls } = setup();
  router.route(`file://zz-secret-host.example${SECRET_PATH}`);
  assert.equal(calls.log.length, 1);
  const logged = JSON.stringify(calls.log);
  assert.match(logged, /file/);
  assert.equal(logged.includes(SECRET_PATH), false);
  assert.equal(logged.includes('zz-secret-host'), false);
});

test('linkRouter.route: the Meet test runs first (a classified call-window link never reaches the scheme allow-list)', () => {
  let schemeChecks = 0;
  const router = load('linkRouter.js').createLinkRouter({
    classifyLink: fakeClassify({ [MEET]: { outcome: 'call-window', url: MEET } }),
    isOpenableExternalScheme: () => { schemeChecks += 1; return false; },
    openCallWindow: () => {},
    openExternal: () => {},
    log: () => {},
  });
  assert.equal(router.route(MEET), 'call-window');
  assert.equal(schemeChecks, 0);
});

// --- onWindowOpen --------------------------------------------------------------------------------

test('linkRouter.onWindowOpen: always denies, and routes the target as a side effect', () => {
  const { router, calls } = setup();
  assert.deepEqual(router.onWindowOpen({ url: MEET }), { action: 'deny' });
  assert.deepEqual(router.onWindowOpen({ url: 'https://example.org/' }), { action: 'deny' });
  assert.deepEqual(router.onWindowOpen({ url: 'file:///etc/passwd' }), { action: 'deny' });
  assert.deepEqual(calls.callWindow, [MEET]);
  assert.deepEqual(calls.external, ['https://example.org/']);
});

test('linkRouter.onWindowOpen: denies even when the details are malformed', () => {
  const { router } = setup();
  assert.deepEqual(router.onWindowOpen({}), { action: 'deny' });
  assert.deepEqual(router.onWindowOpen({ url: 42 }), { action: 'deny' });
});

// --- onWillNavigate ------------------------------------------------------------------------------

test('linkRouter.onWillNavigate: in-app origins pass untouched (no preventDefault, nothing routed)', () => {
  const { router, calls } = setup();
  for (const url of [`${CHAT_ORIGIN}/`, `${CHAT_ORIGIN}/app/chat/x?y=1#z`, 'https://chat.google.com:443/', `${ACCOUNTS_ORIGIN}/signin/v2`, 'https://CHAT.google.com/x']) {
    const event = makeEvent();
    router.onWillNavigate(event, url, { allowedOrigins: ALLOWED });
    assert.equal(event.defaultPrevented, false, url);
  }
  assert.deepEqual(calls.external, []);
  assert.deepEqual(calls.callWindow, []);
});

test('linkRouter.onWillNavigate: a foreign https link is prevented and goes to the system browser', () => {
  const { router, calls } = setup();
  const event = makeEvent();
  router.onWillNavigate(event, 'https://example.org/', { allowedOrigins: ALLOWED });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(calls.external, ['https://example.org/']);
});

test('linkRouter.onWillNavigate: a Meet url is prevented in the window and opens the call window instead', () => {
  const { router, calls } = setup();
  const event = makeEvent();
  router.onWillNavigate(event, MEET, { allowedOrigins: ALLOWED });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(calls.callWindow, [MEET]);
  assert.deepEqual(calls.external, []);
});

test('linkRouter.onWillNavigate: origin lookalikes are not in-app (exact origin, no suffix / scheme / port tolerance)', () => {
  const { router, calls } = setup();
  for (const url of ['https://chat.google.com.evil.example/', 'https://notchat.google.com/', 'http://chat.google.com/', 'https://chat.google.com:8443/', 'https://user@chat.google.com.evil.example/']) {
    const event = makeEvent();
    router.onWillNavigate(event, url, { allowedOrigins: ALLOWED });
    assert.equal(event.defaultPrevented, true, url);
  }
  assert.equal(calls.external.length, 5);
});

test('linkRouter.onWillNavigate: an unparseable or non-openable target is prevented and opened nowhere', () => {
  const { router, calls } = setup();
  for (const url of ['not a url', '', 'javascript:alert(1)', 'file:///C:/x.html', 'ms-settings:privacy']) {
    const event = makeEvent();
    router.onWillNavigate(event, url, { allowedOrigins: ALLOWED });
    assert.equal(event.defaultPrevented, true, JSON.stringify(url));
  }
  assert.deepEqual(calls.external, []);
  assert.deepEqual(calls.callWindow, []);
});

test('linkRouter.onWillNavigate: missing or invalid allowedOrigins fails closed (nothing is in-app)', () => {
  const { router } = setup();
  for (const opts of [undefined, {}, { allowedOrigins: null }, { allowedOrigins: 'https://chat.google.com' }]) {
    const event = makeEvent();
    router.onWillNavigate(event, `${CHAT_ORIGIN}/`, opts);
    assert.equal(event.defaultPrevented, true, JSON.stringify(opts));
  }
});

test('linkRouter.onWillNavigate: the call window origin list (meet + accounts) lets those pass and blocks chat', () => {
  const { router, calls } = setup();
  const callOrigins = ['https://meet.google.com', ACCOUNTS_ORIGIN];
  const ok = makeEvent();
  router.onWillNavigate(ok, 'https://meet.google.com/xyz-uvwx-rst', { allowedOrigins: callOrigins });
  const acc = makeEvent();
  router.onWillNavigate(acc, `${ACCOUNTS_ORIGIN}/ServiceLogin`, { allowedOrigins: callOrigins });
  const chat = makeEvent();
  router.onWillNavigate(chat, `${CHAT_ORIGIN}/`, { allowedOrigins: callOrigins });
  assert.equal(ok.defaultPrevented, false);
  assert.equal(acc.defaultPrevented, false);
  assert.equal(chat.defaultPrevented, true);
  assert.deepEqual(calls.external, [`${CHAT_ORIGIN}/`]);
});

// --- with the REAL classifier and scheme allow-list (red until meetLink.js exists too) -------------

function realSetup() {
  const meetLink = load('meetLink.js');
  const calls = { callWindow: [], external: [], log: [] };
  const router = load('linkRouter.js').createLinkRouter({
    classifyLink: meetLink.classifyLink,
    isOpenableExternalScheme: meetLink.isOpenableExternalScheme,
    openCallWindow: (url) => calls.callWindow.push(url),
    openExternal: (url) => calls.external.push(url),
    log: (...args) => calls.log.push(args),
  });
  return { router, calls };
}

test('linkRouter (real classifier): the NFR-07 outcome table drives the router', () => {
  const { router, calls } = realSetup();
  const enc = encodeURIComponent;
  assert.equal(router.route('https://MEET.GOOGLE.COM/abc-defg-hij'), 'call-window');
  assert.equal(router.route(`https://www.google.com/url?q=${enc(MEET)}`), 'call-window');
  assert.equal(router.route('https://meet.google.com@evil.example/'), 'external');
  assert.equal(router.route('http://meet.google.com/abc-defg-hij'), 'external');
  assert.equal(router.route('mailto:someone@example.org'), 'external');
  assert.equal(router.route('file:///C:/Windows/System32/calc.exe'), 'dropped');
  assert.equal(router.route('ms-settings:privacy'), 'dropped');
  assert.deepEqual(calls.callWindow, [MEET, MEET]);
  assert.equal(calls.external.length, 3);
});

test('linkRouter (real classifier): a main-window navigation to a Meet wrapper is intercepted and opens the call window', () => {
  const { router, calls } = realSetup();
  const event = makeEvent();
  router.onWillNavigate(event, `https://www.google.com/url?q=${encodeURIComponent(MEET)}`, { allowedOrigins: ALLOWED });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(calls.callWindow, [MEET]);
});
