'use strict';

// src/main/session.js permission handlers - full behaviour matrix.
//
// Part 1 (characterization, GREEN on current code): everything that must NOT change.
// Part 2 (BUG-02 spec, RED until fixed): `clipboard-sanitized-write` must be granted to the Google
//   Chat origin only (request AND check handlers), so navigator.clipboard.writeText works in Chat.
//
// The only origin the app loads is https://chat.google.com (START_URL in index.js; sign-in on
// https://accounts.google.com). mail.google.com is never loaded by the app.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configurePersistentSession } = require('../src/main/session.js');

const CHAT = 'https://chat.google.com';
const DEV = 'http://127.0.0.1:5555';
const CLIPBOARD_WRITE = 'clipboard-sanitized-write';

const PERMISSIONS_NEVER_GRANTED = [
  'media', 'geolocation', 'clipboard-read', 'midi', 'midiSysex', 'openExternal',
  'fullscreen', 'pointerLock', 'display-capture', 'mediaKeySystem', 'idle-detection',
  'unknown-permission', 'window-management', 'fileSystem', 'hid', 'serial', 'usb',
];

// Origins that must never receive any permission other than what the allowlist grants.
const FOREIGN_ORIGIN_URLS = [
  'https://chat.google.com.evil.example/',
  'https://evil.chat.google.com.example/',
  'https://notchat.google.com/',
  'http://chat.google.com/',
  'https://chat.google.com:8443/',
  'https://user@chat.google.com.evil.example/',
  'https://mail.google.com/',
  'https://meet.google.com/',
  'https://accounts.google.com/',
  'https://google.com/',
  'https://www.google.com/',
  'https://sub.chat.google.com/',
  'https://evil.example/',
  'file:///C:/x.html',
  'about:blank',
  'not a url',
  '',
  undefined,
];

function setup(notificationOrigins = [CHAT]) {
  const h = {};
  const ses = {
    setUserAgent: () => {},
    setPermissionRequestHandler: (fn) => { h.request = fn; },
    setPermissionCheckHandler: (fn) => { h.check = fn; },
  };
  configurePersistentSession(ses, { notificationOrigins });
  const request = (permission, requestingUrl, wcUrl) => {
    let granted;
    let calls = 0;
    const wc = wcUrl === undefined ? undefined : { getURL: () => wcUrl };
    h.request(wc, permission, (v) => { granted = v; calls += 1; }, { requestingUrl });
    assert.equal(calls, 1, 'callback must be invoked exactly once');
    return granted;
  };
  const check = (permission, origin, details = {}) => h.check(null, permission, origin, details);
  return { request, check };
}

// ---------------------------------------------------------------- Part 1: characterization (GREEN)

test('char/request: notifications granted for chat origin, with or without path/trailing slash/default port', () => {
  const { request } = setup();
  for (const url of [`${CHAT}/`, `${CHAT}/app/chat/x?y=1#z`, 'https://chat.google.com:443/']) {
    assert.equal(request('notifications', url), true, url);
  }
});

test('char/request: notifications denied for every foreign origin', () => {
  const { request } = setup();
  for (const url of FOREIGN_ORIGIN_URLS) {
    assert.equal(request('notifications', url), false, String(url));
  }
});

test('char/request: permissions outside notifications are denied from the chat origin', () => {
  const { request } = setup();
  for (const p of PERMISSIONS_NEVER_GRANTED) {
    assert.equal(request(p, `${CHAT}/`), false, p);
  }
});

test('char/request: permissions outside notifications are denied from foreign origins', () => {
  const { request } = setup();
  for (const p of PERMISSIONS_NEVER_GRANTED) {
    for (const url of FOREIGN_ORIGIN_URLS) {
      assert.equal(request(p, url), false, `${p} @ ${String(url)}`);
    }
  }
});

test('char/request: requestingUrl wins over the webContents URL (embedded frame cannot borrow the page origin)', () => {
  const { request } = setup();
  assert.equal(request('notifications', 'https://evil.example/', `${CHAT}/app`), false);
  assert.equal(request('notifications', `${CHAT}/`, 'https://evil.example/'), true);
});

test('char/request: falls back to the webContents URL only when requestingUrl is absent or unparseable', () => {
  const { request } = setup();
  assert.equal(request('notifications', undefined, `${CHAT}/app`), true);
  assert.equal(request('notifications', 'not a url', `${CHAT}/app`), true);
  assert.equal(request('notifications', undefined, 'https://evil.example/'), false);
  assert.equal(request('notifications', undefined, undefined), false);
});

test('char/request: tolerates missing details and a webContents without getURL (denies, still calls back once)', () => {
  const h = {};
  configurePersistentSession(
    { setUserAgent: () => {}, setPermissionRequestHandler: (f) => { h.r = f; }, setPermissionCheckHandler: () => {} },
    { notificationOrigins: [CHAT] }
  );
  const results = [];
  h.r({}, 'notifications', (v) => results.push(v), undefined);
  h.r(null, 'notifications', (v) => results.push(v), undefined);
  assert.deepEqual(results, [false, false]);
});

test('char/request: allowlist is exact-match on origin - dev loopback origin is granted notifications only when listed', () => {
  assert.equal(setup([CHAT, DEV]).request('notifications', `${DEV}/harness`), true);
  assert.equal(setup([CHAT]).request('notifications', `${DEV}/harness`), false);
});

test('char/request: missing or non-array notificationOrigins denies everything', () => {
  // (undefined is omitted: setup() substitutes its default for it.)
  for (const origins of [null, 'https://chat.google.com', {}]) {
    const { request, check } = setup(origins);
    assert.equal(request('notifications', `${CHAT}/`), false, String(origins));
    assert.equal(check('notifications', CHAT), false, String(origins));
  }
});

test('char/check: notifications true only for the chat origin (slash/port normalisation tolerated)', () => {
  const { check } = setup();
  assert.equal(check('notifications', CHAT), true);
  assert.equal(check('notifications', `${CHAT}/`), true);
  assert.equal(check('notifications', 'https://chat.google.com:443'), true);
});

test('char/check: notifications false for every foreign origin', () => {
  const { check } = setup();
  for (const o of FOREIGN_ORIGIN_URLS) {
    assert.equal(check('notifications', o), false, String(o));
  }
});

test('char/check: permissions outside notifications are false for chat and foreign origins', () => {
  const { check } = setup();
  for (const p of PERMISSIONS_NEVER_GRANTED) {
    assert.equal(check(p, CHAT), false, p);
    assert.equal(check(p, 'https://evil.example'), false, p);
  }
});

test('char/check: falls back to details.requestingUrl when requestingOrigin is unusable', () => {
  const { check } = setup();
  assert.equal(check('notifications', undefined, { requestingUrl: `${CHAT}/app` }), true);
  assert.equal(check('notifications', 'not a url', { requestingUrl: `${CHAT}/app` }), true);
  assert.equal(check('notifications', undefined, { requestingUrl: 'https://evil.example/' }), false);
  assert.equal(check('notifications', undefined, undefined), false);
});

test('char/check: a usable requestingOrigin wins over details.requestingUrl', () => {
  const { check } = setup();
  assert.equal(check('notifications', 'https://evil.example', { requestingUrl: `${CHAT}/` }), false);
});

test('char: no Meet-origin grants exist today (media/display-capture denied everywhere)', () => {
  // Documents the current state: the brief anticipated Meet grants; there are none in src/.
  const { request, check } = setup();
  for (const p of ['media', 'display-capture']) {
    assert.equal(request(p, 'https://meet.google.com/abc'), false, p);
    assert.equal(check(p, 'https://meet.google.com'), false, p);
  }
});

test('char: setUserAgent is applied and both handlers are registered', () => {
  let ua;
  let reg = 0;
  configurePersistentSession(
    { setUserAgent: (u) => { ua = u; }, setPermissionRequestHandler: () => { reg += 1; }, setPermissionCheckHandler: () => { reg += 1; } },
    { notificationOrigins: [CHAT] }
  );
  assert.match(ua, /^Mozilla\/5\.0 .*Chrome\/.* Safari\/537\.36$/);
  assert.equal(reg, 2);
});

// ---------------------------------------------------------------- Part 2: BUG-02 spec

test('BUG-02 spec/request: clipboard-sanitized-write is granted to the chat origin', () => {
  const { request } = setup();
  assert.equal(request(CLIPBOARD_WRITE, `${CHAT}/app/chat/x`), true);
  assert.equal(request(CLIPBOARD_WRITE, 'https://chat.google.com:443/'), true);
});

test('BUG-02 spec/request: clipboard-sanitized-write falls back to the webContents URL for chat', () => {
  const { request } = setup();
  assert.equal(request(CLIPBOARD_WRITE, undefined, `${CHAT}/app`), true);
});

test('BUG-02 spec/check: clipboard-sanitized-write is true for the chat origin', () => {
  const { check } = setup();
  assert.equal(check(CLIPBOARD_WRITE, CHAT), true);
  assert.equal(check(CLIPBOARD_WRITE, `${CHAT}/`), true);
  assert.equal(check(CLIPBOARD_WRITE, undefined, { requestingUrl: `${CHAT}/app` }), true);
});

// Guards for the fix: these pass today and must keep passing after it.
test('BUG-02 guard/request: clipboard-sanitized-write stays denied for every foreign origin', () => {
  const { request } = setup();
  for (const url of FOREIGN_ORIGIN_URLS) {
    assert.equal(request(CLIPBOARD_WRITE, url), false, String(url));
  }
});

test('BUG-02 guard/check: clipboard-sanitized-write stays false for every foreign origin', () => {
  const { check } = setup();
  for (const o of FOREIGN_ORIGIN_URLS) {
    assert.equal(check(CLIPBOARD_WRITE, o), false, String(o));
  }
});

test('BUG-02 guard: clipboard-read (and other clipboard-ish/unknown permissions) stay denied even for chat', () => {
  const { request, check } = setup();
  for (const p of ['clipboard-read', 'clipboard-write', 'clipboard', 'clipboard-sanitized-read']) {
    assert.equal(request(p, `${CHAT}/`), false, p);
    assert.equal(check(p, CHAT), false, p);
  }
});

test('BUG-02 guard: requestingUrl from a foreign frame cannot borrow the chat page origin for clipboard write', () => {
  const { request } = setup();
  assert.equal(request(CLIPBOARD_WRITE, 'https://evil.example/', `${CHAT}/app`), false);
});

test('BUG-02 guard: the clipboard grant does not widen notifications or other permissions', () => {
  const { request, check } = setup();
  assert.equal(request('notifications', `${CHAT}/`), true);
  for (const p of PERMISSIONS_NEVER_GRANTED) {
    assert.equal(request(p, `${CHAT}/`), false, p);
    assert.equal(check(p, CHAT), false, p);
  }
});
