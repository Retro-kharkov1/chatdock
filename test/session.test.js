'use strict';

// src/main/session.js permission handlers (review: pre-existing gap) - the `notifications`
// permission is granted only to the allowlisted notification origins, for both the request handler
// and the check handler; everything else stays denied.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configurePersistentSession } = require('../src/main/session.js');

const ORIGINS = ['https://chat.google.com'];

function setup() {
  const h = {};
  const ses = {
    setUserAgent: () => {},
    setPermissionRequestHandler: (fn) => { h.request = fn; },
    setPermissionCheckHandler: (fn) => { h.check = fn; },
  };
  configurePersistentSession(ses, { notificationOrigins: ORIGINS });
  const request = (permission, requestingUrl, wcUrl) => {
    let granted;
    h.request({ getURL: () => wcUrl }, permission, (v) => { granted = v; }, { requestingUrl });
    return granted;
  };
  return { request, check: h.check };
}

test('request: notifications from the allowlisted origin is granted', () => {
  const { request } = setup();
  assert.equal(request('notifications', 'https://chat.google.com/app/chat/x'), true);
});

test('request: notifications from any other origin is denied (look-alike, http, sign-in origin)', () => {
  const { request } = setup();
  for (const url of [
    'https://chat.google.com.evil.example/',
    'http://chat.google.com/',
    'https://accounts.google.com/',
    'https://evil.example/',
    'not a url',
    undefined,
  ]) {
    assert.equal(request('notifications', url), false, String(url));
  }
});

test('request: every other permission stays denied even from the allowlisted origin', () => {
  const { request } = setup();
  for (const p of ['media', 'geolocation', 'clipboard-read', 'midi', 'openExternal']) {
    assert.equal(request(p, 'https://chat.google.com/'), false, p);
  }
});

test('request: falls back to the webContents URL when details carry no requestingUrl', () => {
  const { request } = setup();
  assert.equal(request('notifications', undefined, 'https://chat.google.com/app'), true);
});

test('check: notifications is true only for the allowlisted origin', () => {
  const { check } = setup();
  assert.equal(check(null, 'notifications', 'https://chat.google.com', {}), true);
  assert.equal(check(null, 'notifications', 'https://chat.google.com/', {}), true);
  assert.equal(check(null, 'notifications', 'https://evil.example', {}), false);
  assert.equal(check(null, 'notifications', 'https://chat.google.com.evil.example', {}), false);
  assert.equal(check(null, 'notifications', undefined, {}), false);
});

test('check: other permission types are denied', () => {
  const { check } = setup();
  assert.equal(check(null, 'media', 'https://chat.google.com', {}), false);
});
