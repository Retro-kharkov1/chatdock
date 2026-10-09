'use strict';

// BUG-07 (drag a file from the OS into a conversation) and BUG-08 (attach through the picker): the page reads
// the user's file through File System Access handles, which Electron routes to the session's `fileSystem`
// permission. src/main/fileAccess.js grants READ of a user-chosen file to the Chat / Meet / Google-app origins.
// Facts the shapes below come from (observed on Electron 44.4.3, Linux, real app windows): the check handler is
// called with webContents = null, no embeddingOrigin, details = {fileAccessType, filePath, isDirectory, isMainFrame:false}.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  FILE_ACCESS_ORIGINS,
  decideFileSystem,
  decideFileSystemRequest,
  decideFileSystemCheck,
} = require('../src/main/fileAccess.js');
const { configurePersistentSession } = require('../src/main/session.js');
const { LINK_LIST_HOSTS } = require('../src/main/googleLink.js');

const CHAT = 'https://chat.google.com';
const READ = { fileAccessType: 'readable', filePath: '/tmp/a.txt', isDirectory: false, isMainFrame: false };

function setup() {
  const h = {};
  configurePersistentSession(
    {
      setUserAgent: () => {},
      setPermissionRequestHandler: (fn) => { h.request = fn; },
      setPermissionCheckHandler: (fn) => { h.check = fn; },
    },
    { notificationOrigins: [CHAT] }
  );
  const request = (requestingUrl, details, topUrl) => {
    let granted;
    let calls = 0;
    const wc = topUrl === undefined ? null : { getURL: () => topUrl };
    h.request(wc, 'fileSystem', (v) => { granted = v; calls += 1; }, { requestingUrl, ...details });
    assert.equal(calls, 1, 'callback invoked exactly once');
    return granted;
  };
  const check = (origin, details, topUrl) =>
    h.check(topUrl === undefined ? null : { getURL: () => topUrl }, 'fileSystem', origin, details);
  return { request, check };
}

test('the origin set is exactly Chat, Meet and the Google-app link list (all https, no accounts, no wildcard)', () => {
  assert.deepEqual(
    [...FILE_ACCESS_ORIGINS].sort(),
    [CHAT, 'https://meet.google.com', ...LINK_LIST_HOSTS.map((h) => `https://${h}`)].sort()
  );
  assert.ok(!FILE_ACCESS_ORIGINS.includes('https://accounts.google.com'));
  assert.ok(FILE_ACCESS_ORIGINS.every((o) => o.startsWith('https://')));
});

test('check handler (real shape: no webContents, no embeddingOrigin): read is granted on every listed origin', () => {
  const { check } = setup();
  for (const origin of FILE_ACCESS_ORIGINS) {
    assert.equal(check(origin + '/', READ), true, origin);
    assert.equal(check(origin, READ), true, origin);
  }
});

test('request handler: read is granted on every listed origin, with or without a listed top-level page', () => {
  const { request, check } = setup();
  for (const origin of FILE_ACCESS_ORIGINS) {
    assert.equal(request(origin + '/x', READ), true, origin);
    assert.equal(request(origin + '/x', READ, origin + '/x'), true, origin);
    assert.equal(check(origin, READ, CHAT + '/'), true, origin);
  }
});

test('the grant is read-only: writable, missing or unknown access type is denied', () => {
  const { request, check } = setup();
  for (const type of ['writable', undefined, null, '', 'readwrite', 'READABLE']) {
    const details = { ...READ, fileAccessType: type };
    assert.equal(check(CHAT, details), false, String(type));
    assert.equal(request(CHAT + '/', details), false, String(type));
  }
  assert.equal(check(CHAT, undefined), false);
  assert.equal(check(CHAT, {}), false);
});

test('foreign, look-alike, insecure and sign-in origins never read a file', () => {
  const { request, check } = setup();
  for (const origin of [
    'https://accounts.google.com',
    'https://evil.example',
    'https://chat.google.com.evil.example',
    'https://notchat.google.com',
    'https://sub.chat.google.com',
    'http://chat.google.com',
    'https://chat.google.com:8443',
    'https://user@chat.google.com.evil.example',
    'https://user:pw@chat.google.com',
    'http://127.0.0.1:5555',
    'file:///C:/x.html',
    'about:blank',
    'not a url',
    '',
    undefined,
    null,
  ]) {
    assert.equal(check(origin, READ), false, String(origin));
    assert.equal(request(origin, READ), false, String(origin));
  }
});

test('a top-level signal that IS present must be listed too (a listed frame under an unlisted page is denied)', () => {
  const { request, check } = setup();
  for (const top of ['https://evil.example/', 'https://accounts.google.com/', 'not a url', 'about:blank', 'file:///C:/a.html']) {
    assert.equal(request(CHAT + '/', READ, top), false, top);
    assert.equal(check(CHAT, READ, top), false, top);
  }
  assert.equal(check(CHAT, { ...READ, embeddingOrigin: 'https://evil.example' }), false);
  assert.equal(check(CHAT, { ...READ, embeddingOrigin: CHAT }), true);
});

test('details.requestingUrl is used only when the check handler has no usable requesting origin', () => {
  const { check } = setup();
  assert.equal(check(undefined, { ...READ, requestingUrl: CHAT + '/app' }), true);
  assert.equal(check('https://evil.example', { ...READ, requestingUrl: CHAT + '/app' }), false);
});

test('pure functions tolerate junk without throwing', () => {
  assert.equal(decideFileSystem({}), false);
  assert.equal(decideFileSystem({ requesting: CHAT, fileAccessType: 'readable', topLevelSignals: 'x' }), true);
  assert.equal(decideFileSystemRequest(undefined, undefined), false);
  assert.equal(decideFileSystemCheck(undefined, undefined, undefined), false);
  assert.equal(decideFileSystemCheck({ getURL() { throw new Error('boom'); } }, CHAT, READ), true);
});

test('other permissions are untouched by the file grant (still denied from Chat)', () => {
  const h = {};
  configurePersistentSession(
    { setUserAgent: () => {}, setPermissionRequestHandler: (f) => { h.r = f; }, setPermissionCheckHandler: (f) => { h.c = f; } },
    { notificationOrigins: [CHAT] }
  );
  for (const p of ['media', 'geolocation', 'clipboard-read', 'hid', 'usb', 'serial', 'window-management', 'openExternal']) {
    let granted;
    h.r(null, p, (v) => { granted = v; }, { requestingUrl: CHAT + '/', ...READ });
    assert.equal(granted, false, p);
    assert.equal(h.c(null, p, CHAT, READ), false, p);
  }
});
