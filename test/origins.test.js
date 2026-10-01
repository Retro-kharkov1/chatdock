'use strict';

// src/main/origins.js - the two origin lists and the dev-only start-URL seam, extracted from
// index.js so they are testable. S1: the notification allowlist (service-worker IPC and the
// `notifications` permission) is chat.google.com only; the sign-in origin is navigation-only.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  CHAT_ORIGIN,
  START_URL,
  buildOrigins,
  parseDevStartUrl,
} = require('../src/main/origins.js');

test('navigation allowlist keeps chat + sign-in origins', () => {
  const o = buildOrigins(null);
  assert.deepEqual(o.navigationOrigins, ['https://chat.google.com', 'https://accounts.google.com']);
});

test('S1: the notification allowlist is the chat origin only', () => {
  assert.deepEqual(buildOrigins(null).notificationOrigins, ['https://chat.google.com']);
});

test('a dev origin is added to both lists, without mutating shared state between calls', () => {
  const dev = buildOrigins('http://localhost:8765');
  assert.equal(dev.navigationOrigins.includes('http://localhost:8765'), true);
  assert.equal(dev.notificationOrigins.includes('http://localhost:8765'), true);
  const plain = buildOrigins(null);
  assert.equal(plain.navigationOrigins.includes('http://localhost:8765'), false);
  assert.equal(plain.notificationOrigins.includes('http://localhost:8765'), false);
});

test('dev seam: honoured only for an unpackaged build and a loopback http URL', () => {
  assert.deepEqual(parseDevStartUrl('http://localhost:8765/x', false), {
    url: 'http://localhost:8765/x',
    origin: 'http://localhost:8765',
  });
  assert.equal(parseDevStartUrl('http://127.0.0.1:1/', false).origin, 'http://127.0.0.1:1');
});

test('dev seam: never active in a packaged build', () => {
  assert.equal(parseDevStartUrl('http://localhost:8765/', true), null);
});

test('dev seam: rejects https, non-loopback hosts, look-alikes, junk and empty values', () => {
  for (const v of [
    'https://localhost:8765/',
    'http://example.com/',
    'http://localhost.evil.example/',
    'http://user@evil.example@localhost/',
    'ftp://localhost/',
    'not a url',
    '',
    undefined,
  ]) {
    assert.equal(parseDevStartUrl(v, false), null, String(v));
  }
});

test('START_URL is the generic Chat root (no private space ID) and sits inside the navigation allowlist', () => {
  assert.equal(START_URL, 'https://chat.google.com/');
  assert.equal(new URL(START_URL).origin, CHAT_ORIGIN);
  assert.equal(buildOrigins(null).navigationOrigins.includes(new URL(START_URL).origin), true);
  assert.equal(buildOrigins(null).notificationOrigins.includes(new URL(START_URL).origin), true);
});
