'use strict';

// FR-19: the optional `allow` predicate of linkRouter.onWillNavigate (docs/architecture/sign-in-flow.md section 7
// "Contracts", section 6 "Router order", test map row "Router predicate"). The existing test/linkRouter.test.js and
// test/googleLinkRouter.test.js stay untouched and green; here the absent-`allow` behaviour is re-pinned.
//
// API ASSUMED (extends src/main/linkRouter.js; the addition is OPTIONAL):
//
//   onWillNavigate(event, url, { allowedOrigins, source, allow })
//     order: the fixed allowedOrigins list first (then `allow` is NOT consulted), else allow(url) === true lets the
//     navigation pass untouched (no preventDefault, no routing), else the router (prevent + route, as today).
//     `allow` absent: byte-for-byte today's behaviour. `allow` throws: fail closed (prevent + route), nothing propagates.
//     (The real predicate is signInFlow.allowNavigation, covered end to end below with the real flow.)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEvent } = require('./helpers/electronFakes');
const { load } = require('./helpers/pending');
const H = require('./helpers/signInHarness');

const ALLOWED = ['https://chat.google.com', 'https://accounts.google.com'];
const MEET = 'https://meet.google.com/abc-defg-hij';
const DOCS = 'https://docs.google.com/document/d/1/edit';
const IDP = 'https://login.idp.example/sso';

function setup() {
  const calls = { callWindow: [], app: [], external: [], main: [], focus: 0, download: [], log: [] };
  const meetLink = load('meetLink.js');
  const googleLink = load('googleLink.js');
  const router = load('linkRouter.js').createLinkRouter({
    classifyLink: meetLink.classifyLink,
    isOpenableExternalScheme: meetLink.isOpenableExternalScheme,
    classifyGoogleLink: googleLink.classifyGoogleLink,
    classifyChatTarget: googleLink.classifyChatTarget,
    openCallWindow: (u) => calls.callWindow.push(u),
    openMainWindow: (u) => calls.main.push(u),
    focusMainWindow: () => { calls.focus += 1; },
    downloadInMainWindow: (u) => calls.download.push(u),
    openGoogleAppWindow: (u, o) => calls.app.push({ u, hop: Boolean(o && o.hop) }),
    openExternal: (u) => calls.external.push(u),
    log: (...a) => calls.log.push(a),
  });
  const nav = (url, opts) => {
    const event = makeEvent();
    router.onWillNavigate(event, url, opts);
    return event;
  };
  return { router, calls, nav };
}

const snapshot = (calls) => JSON.stringify({ ...calls, log: calls.log.length });

test('allow true: a non-listed origin passes untouched - not prevented, nothing routed', () => {
  const { nav, calls } = setup();
  const event = nav(IDP, { allowedOrigins: ALLOWED, allow: () => true });
  assert.equal(event.defaultPrevented, false);
  assert.equal(snapshot(calls), snapshot({ callWindow: [], app: [], external: [], main: [], focus: 0, download: [], log: [] }));
});

test('allow receives the url it was asked about, once', () => {
  const { nav } = setup();
  const seen = [];
  nav(IDP, { allowedOrigins: ALLOWED, allow: (u) => { seen.push(u); return true; } });
  assert.deepEqual(seen, [IDP]);
});

test('allow false: prevented and routed exactly as today (an https link goes to the system browser)', () => {
  const { nav, calls } = setup();
  const event = nav(IDP, { allowedOrigins: ALLOWED, allow: () => false });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(calls.external, [IDP]);
});

test('allow false: a Meet url still goes to the call window, a Google application url to its app window, an http: url to the browser', () => {
  const { nav, calls } = setup();
  const allow = () => false;
  nav(MEET, { allowedOrigins: ALLOWED, allow });
  nav(DOCS, { allowedOrigins: ALLOWED, allow });
  nav('http://login.example.com/', { allowedOrigins: ALLOWED, allow });
  assert.deepEqual(calls.callWindow, [MEET]);
  assert.deepEqual(calls.app, [{ u: DOCS, hop: false }]);
  assert.deepEqual(calls.external, ['http://login.example.com/']);
});

test('allow absent: identical to today for every kind of target', () => {
  for (const url of [IDP, MEET, DOCS, 'http://x.example/', 'mailto:a@b.example', 'javascript:alert(1)', 'not a url', 'https://chat.google.com/room/A', 'https://accounts.google.com/x']) {
    const plain = setup();
    const withUndefined = setup();
    const a = plain.nav(url, { allowedOrigins: ALLOWED });
    const b = withUndefined.nav(url, { allowedOrigins: ALLOWED, allow: undefined });
    assert.equal(a.defaultPrevented, b.defaultPrevented, url);
    assert.equal(snapshot(plain.calls), snapshot(withUndefined.calls), url);
  }
});

test('allow throws: fails closed - prevented and routed as today, nothing propagates', () => {
  const { nav, calls } = setup();
  let event;
  assert.doesNotThrow(() => {
    event = nav(IDP, { allowedOrigins: ALLOWED, allow: () => { throw new Error('boom'); } });
  });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(calls.external, [IDP]);
});

test('the fixed list still passes without consulting allow (the fixed list is checked first)', () => {
  const { nav, calls } = setup();
  let asked = 0;
  const allow = () => { asked += 1; return false; };
  for (const url of ['https://chat.google.com/room/A', 'https://accounts.google.com/v3/signin']) {
    assert.equal(nav(url, { allowedOrigins: ALLOWED, allow }).defaultPrevented, false, url);
  }
  assert.equal(asked, 0);
  assert.equal(calls.external.length, 0);
});

test('allow never widens a missing / non-array allowedOrigins into a free pass for a refusing predicate (still fail closed)', () => {
  const { nav, calls } = setup();
  assert.equal(nav(IDP, { allow: () => false }).defaultPrevented, true);
  assert.equal(nav(IDP, { allowedOrigins: 'https://chat.google.com', allow: () => false }).defaultPrevented, true);
  assert.deepEqual(calls.external, [IDP, IDP]);
});

// ---- with the REAL flow predicate -------------------------------------------------------------------------------------------------------

function withFlow() {
  const s = setup();
  const t = H.createFlowHarness();
  const nav = (url) => s.nav(url, { allowedOrigins: ALLOWED, allow: t.flow.allowNavigation });
  return { ...s, t, nav };
}

test('real predicate, mode off: an IdP url is routed to the browser (the fixed list alone decides)', () => {
  const s = withFlow();
  assert.equal(s.nav(IDP).defaultPrevented, true);
  assert.deepEqual(s.calls.external, [IDP]);
});

test('real predicate, mode on: an IdP url passes; Meet goes to the call window; a Google app url to its app window; http: to the browser', () => {
  const s = withFlow();
  s.t.enter();
  assert.equal(s.nav(IDP).defaultPrevented, false);
  assert.equal(s.nav(MEET).defaultPrevented, true);
  assert.equal(s.nav(DOCS).defaultPrevented, true);
  assert.equal(s.nav('http://login.example.com/').defaultPrevented, true);
  assert.deepEqual(s.calls.callWindow, [MEET]);
  assert.deepEqual(s.calls.app, [{ u: DOCS, hop: false }]);
  assert.deepEqual(s.calls.external, ['http://login.example.com/']);
});

test('real predicate, mode on: forms.gle hops to an app window, usercontent and googleusercontent go to the system browser', () => {
  const s = withFlow();
  s.t.enter();
  s.nav('https://forms.gle/abc');
  s.nav('https://drive.usercontent.google.com/download?id=1');
  s.nav('https://lh3.googleusercontent.com/a');
  assert.deepEqual(s.calls.app, [{ u: 'https://forms.gle/abc', hop: true }]);
  assert.deepEqual(s.calls.external, ['https://drive.usercontent.google.com/download?id=1', 'https://lh3.googleusercontent.com/a']);
});

test('real predicate, mode on: unacceptable shapes are routed, never allowed (userinfo, port, IP, localhost, xn--)', () => {
  const s = withFlow();
  s.t.enter();
  for (const url of ['https://chat.google.com@evil.example/', 'https://login.example.com:8443/', 'https://10.0.0.1/', 'https://0x7f.1/', 'https://localhost/', 'https://xn--e1afmkfd.example/']) {
    assert.equal(s.nav(url).defaultPrevented, true, url);
  }
  assert.equal(s.calls.callWindow.length + s.calls.app.length, 0);
});

test('real predicate: after the mode ends the same IdP url is routed again', () => {
  const s = withFlow();
  s.t.enter();
  assert.equal(s.nav(IDP).defaultPrevented, false);
  s.t.commit('https://chat.google.com/');
  assert.equal(s.nav(IDP).defaultPrevented, true);
});
