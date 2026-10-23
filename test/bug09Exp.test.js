'use strict';

// BUG-09 experiment (wip branch only): the flag reading, the wake-lock gate (A) and the about:blank popup gate (B).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveExpFlags, EXPERIMENT_BAKED_DEFAULTS } = require('../src/main/expFlags.js');
const { decideMeetRequest, decideMeetCheck } = require('../src/main/meetPermissions.js');
const { configurePersistentSession } = require('../src/main/session.js');
const { createBlankPopup, isBlankPopupRequest } = require('../src/main/blankPopup.js');

const CHAT = 'https://chat.google.com';
const MEET = 'https://meet.google.com';
const WL = 'screen-wake-lock';
const ON = { wakeLock: true };

// --- flags ---------------------------------------------------------------------------------------------

test('flags: default OFF with nothing set', () => {
  assert.deepEqual(resolveExpFlags(), { wakeLock: false, blankPopup: false });
  assert.deepEqual(resolveExpFlags({ argv: ['app.exe'], env: {} }), { wakeLock: false, blankPopup: false });
});

test('flags: command line, environment and baked values; command line wins', () => {
  assert.equal(resolveExpFlags({ argv: ['--exp-wake-lock'] }).wakeLock, true);
  assert.equal(resolveExpFlags({ argv: ['--exp-blank-popup=1'] }).blankPopup, true);
  assert.equal(resolveExpFlags({ env: { GCD_EXP_BLANK_POPUP: 'true' } }).blankPopup, true);
  assert.equal(resolveExpFlags({ baked: EXPERIMENT_BAKED_DEFAULTS }).blankPopup, true);
  const off = resolveExpFlags({ argv: ['--exp-blank-popup=0'], env: { GCD_EXP_BLANK_POPUP: '1' }, baked: EXPERIMENT_BAKED_DEFAULTS });
  assert.deepEqual(off, { wakeLock: true, blankPopup: false });
  const envOff = resolveExpFlags({ env: { GCD_EXP_WAKE_LOCK: 'off' }, baked: EXPERIMENT_BAKED_DEFAULTS });
  assert.equal(envOff.wakeLock, false);
});

test('flags: junk values are ignored (fall through to the default)', () => {
  assert.equal(resolveExpFlags({ argv: ['--exp-wake-lock=maybe'] }).wakeLock, false);
  assert.equal(resolveExpFlags({ env: { GCD_EXP_WAKE_LOCK: 'x' } }).wakeLock, false);
  assert.equal(resolveExpFlags({ argv: [null, 7, '--exp-wake-lock-extra'] }).wakeLock, false);
});

test('flags: this artifact bakes both ON', () => {
  assert.deepEqual(EXPERIMENT_BAKED_DEFAULTS, { wakeLock: true, blankPopup: true });
});

// --- A: wake lock ----------------------------------------------------------------------------------------

const wc = (url) => ({ getURL: () => url });

for (const top of [CHAT + '/room/x', MEET + '/abc']) {
  test(`A request: granted for Meet under ${top}`, () => {
    assert.equal(decideMeetRequest(wc(top), WL, { requestingUrl: MEET + '/abc' }, ON), true);
  });
  test(`A check: granted for Meet under ${top}`, () => {
    assert.equal(decideMeetCheck(wc(top), WL, MEET, { embeddingOrigin: CHAT }, ON), true);
  });
}

test('A: flag off or missing -> undefined (the caller denies)', () => {
  assert.equal(decideMeetRequest(wc(CHAT), WL, { requestingUrl: MEET }), undefined);
  assert.equal(decideMeetRequest(wc(CHAT), WL, { requestingUrl: MEET }, { wakeLock: false }), undefined);
  assert.equal(decideMeetCheck(wc(CHAT), WL, MEET, {}, undefined), undefined);
});

const WL_DENIALS = [
  ['requester is chat', CHAT, CHAT],
  ['requester is a lookalike', 'https://meet.google.com.evil.example', CHAT],
  ['requester http', 'http://meet.google.com', CHAT],
  ['requester other google', 'https://docs.google.com', CHAT],
  ['top level other', MEET, 'https://evil.example'],
  ['top level lookalike', MEET, 'https://chat.google.com.evil.example'],
  ['top level docs', MEET, 'https://docs.google.com'],
  ['requester userinfo', 'https://x@meet.google.com', CHAT],
  ['requester missing', undefined, CHAT],
  ['top missing', MEET, undefined],
];
for (const [label, req, top] of WL_DENIALS) {
  test(`A: denied, ${label} (request and check)`, () => {
    assert.equal(decideMeetRequest(wc(top), WL, { requestingUrl: req }, ON), false);
    assert.equal(decideMeetCheck(wc(top), WL, req, {}, ON), false);
  });
}

test('A check: a non-Chat/Meet embedding origin denies even if the contents are on Chat', () => {
  assert.equal(decideMeetCheck(wc(CHAT), WL, MEET, { embeddingOrigin: 'https://evil.example' }, ON), false);
});

test('A check: no top-level signal at all denies', () => {
  assert.equal(decideMeetCheck(null, WL, MEET, {}, ON), false);
});

function fakeSession() {
  const s = {};
  s.setUserAgent = () => {};
  s.setPermissionRequestHandler = (h) => { s.request = h; };
  s.setPermissionCheckHandler = (h) => { s.check = h; };
  return s;
}
const OPTS = { notificationOrigins: [CHAT] };

test('A via session: off by default, on only with the flag', () => {
  const off = fakeSession();
  configurePersistentSession(off, OPTS);
  assert.equal(off.check(wc(CHAT), WL, MEET, { embeddingOrigin: CHAT }), false);
  let got;
  off.request(wc(CHAT), WL, (d) => { got = d; }, { requestingUrl: MEET });
  assert.equal(got, false);

  const on = fakeSession();
  configurePersistentSession(on, { ...OPTS, experiment: { wakeLock: true } });
  assert.equal(on.check(wc(CHAT), WL, MEET, { embeddingOrigin: CHAT }), true);
  on.request(wc(CHAT), WL, (d) => { got = d; }, { requestingUrl: MEET });
  assert.equal(got, true);
  on.request(wc(CHAT), WL, (d) => { got = d; }, { requestingUrl: CHAT });
  assert.equal(got, false);
});

test('B via session: the popup contents get no permission, not even media from a Meet URL', () => {
  const popup = wc(MEET + '/abc');
  const ses = fakeSession();
  configurePersistentSession(ses, { ...OPTS, experiment: { wakeLock: true, isPopupContents: (c) => c === popup } });
  let got;
  ses.request(popup, 'media', (d) => { got = d; }, { requestingUrl: MEET, mediaTypes: ['audio'] });
  assert.equal(got, false);
  ses.request(popup, WL, (d) => { got = d; }, { requestingUrl: MEET });
  assert.equal(got, false);
  assert.equal(ses.check(popup, 'media', MEET, { mediaType: 'audio' }), false);
  // the same request from other contents still works
  ses.request(wc(CHAT), 'media', (d) => { got = d; }, { requestingUrl: MEET, mediaTypes: ['audio'] });
  assert.equal(got, true);
});

// --- B: about:blank popup -----------------------------------------------------------------------------------

const GOOD = { url: 'about:blank', features: '', disposition: 'other', referrer: { url: CHAT + '/room/abc?x=1' } };

function make(overrides = {}) {
  const logs = [];
  const external = [];
  let t = 1000;
  const popup = createBlankPopup({
    enabled: true,
    openExternal: (u) => external.push(u),
    isOpenableExternalScheme: (u) => /^https?:/.test(u),
    diag: (name, f) => logs.push([name, f]),
    now: () => t,
    ...overrides,
  });
  return { popup, logs, external, tick: (ms) => { t += ms; } };
}

function fakeWin() {
  const handlers = {};
  const winHandlers = {};
  const contents = {
    setWindowOpenHandler: (h) => { contents.open = h; },
    on: (e, h) => { handlers[e] = h; },
    getLastWebPreferences: () => ({ sandbox: true, contextIsolation: true, nodeIntegration: false }),
  };
  return {
    webContents: contents,
    on: (e, h) => { winHandlers[e] = h; },
    destroy() { this.destroyed = true; },
    handlers,
    winHandlers,
  };
}

test('B: the exact shape is allowed with a hardened window', () => {
  const { popup, logs } = make();
  const r = popup.decide(GOOD);
  assert.equal(r.action, 'allow');
  const wp = r.overrideBrowserWindowOptions.webPreferences;
  assert.equal(wp.sandbox, true);
  assert.equal(wp.contextIsolation, true);
  assert.equal(wp.nodeIntegration, false);
  assert.equal('preload' in wp, false);
  assert.ok(logs.some(([n, f]) => n === 'exp-blank-popup' && f.decision === 'allow'));
});

const B_DENIALS = [
  ['opener is Meet', { ...GOOD, referrer: { url: MEET + '/abc' } }],
  ['opener lookalike', { ...GOOD, referrer: { url: 'https://chat.google.com.evil.example/' } }],
  ['opener http', { ...GOOD, referrer: { url: 'http://chat.google.com/' } }],
  ['opener userinfo', { ...GOOD, referrer: { url: 'https://a@chat.google.com/' } }],
  ['no referrer', { ...GOOD, referrer: undefined }],
  ['url is not about:blank', { ...GOOD, url: 'about:srcdoc' }],
  ['url is a Meet link', { ...GOOD, url: MEET + '/abc-defg-hij' }],
  ['url blank with suffix', { ...GOOD, url: 'about:blank#x' }],
  ['features not empty', { ...GOOD, features: 'width=400' }],
  ['features missing', { ...GOOD, features: undefined }],
  ['no details', undefined],
];
for (const [label, details] of B_DENIALS) {
  test(`B: not allowed, ${label}`, () => {
    const { popup } = make();
    assert.equal(popup.decide(details), null);
    assert.equal(isBlankPopupRequest(details), false);
  });
}

test('B: flag off -> never allowed (default)', () => {
  const { popup } = make({ enabled: false });
  assert.equal(popup.decide(GOOD), null);
  assert.equal(make({ enabled: undefined }).popup.decide(GOOD), null);
});

test('B: only one popup at a time; slot frees on close and when creation never happens', () => {
  const { popup, tick } = make();
  assert.equal(popup.decide(GOOD).action, 'allow');
  assert.equal(popup.decide(GOOD), null); // pending
  tick(6000);
  assert.equal(popup.decide(GOOD).action, 'allow'); // creation never reported: released
  const win = fakeWin();
  popup.onCreated(win, GOOD);
  assert.equal(popup.decide(GOOD), null); // live
  win.winHandlers.closed();
  assert.equal(popup.decide(GOOD).action, 'allow');
});

test('B: navigation only to exact meet / accounts; the rest goes to the system browser or is dropped', () => {
  const { popup, external } = make();
  popup.decide(GOOD);
  const win = fakeWin();
  popup.onCreated(win, GOOD);
  const nav = (url) => {
    let prevented = false;
    win.handlers['will-navigate']({ url, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  assert.equal(nav(MEET + '/abc'), false);
  assert.equal(nav('https://accounts.google.com/signin'), false);
  assert.equal(nav('https://evil.example/'), true);
  assert.equal(nav('https://meet.google.com.evil.example/'), true);
  assert.equal(nav('http://meet.google.com/'), true);
  assert.equal(nav(CHAT + '/x'), true);
  assert.equal(nav('javascript:alert(1)'), true);
  assert.deepEqual(external, [
    'https://evil.example/',
    'https://meet.google.com.evil.example/',
    'http://meet.google.com/',
    CHAT + '/x',
  ]);
});

test('B: its own popups are denied; permissions identify the popup contents', () => {
  const { popup } = make();
  popup.decide(GOOD);
  const win = fakeWin();
  assert.equal(popup.isPopupContents(win.webContents), false);
  popup.onCreated(win, GOOD);
  assert.deepEqual(win.webContents.open({ url: 'https://x.example/' }), { action: 'deny' });
  assert.equal(popup.isPopupContents(win.webContents), true);
  assert.equal(popup.isPopupContents({}), false);
});

test('B: an unapproved window or wrong web preferences is destroyed', () => {
  const a = make();
  const w1 = fakeWin();
  a.popup.onCreated(w1, GOOD);
  assert.equal(w1.destroyed, true);

  const b = make();
  b.popup.decide(GOOD);
  const w2 = fakeWin();
  w2.webContents.getLastWebPreferences = () => ({ sandbox: true, contextIsolation: true, nodeIntegration: false, preload: '/p.js' });
  b.popup.onCreated(w2, GOOD);
  assert.equal(w2.destroyed, true);
  assert.equal(b.popup.isPopupContents(w2.webContents), false);
});
