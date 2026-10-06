'use strict';

// FR-19 section 4 "Permissions" row, the full pin that docs/architecture/sign-in-flow.md marks *pending*: an identity
// provider origin, as REQUESTING origin and as TOP-LEVEL origin, is denied every permission (notifications, every
// clipboard kind, media, display capture, fullscreen, speaker selection ...). The mode changes no permission handler;
// this is a characterization of today's src/main/session.js, GREEN now and a regression net for the sign-in mode.
// test/sessionPermissions.test.js covers a generic foreign origin; this file adds the IdP shapes, the top-level path,
// the embeddingOrigin signal and the permissions that file does not list (speaker-selection, clipboard-sanitized-write
// and notifications are asserted here for IdP origins too).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configurePersistentSession } = require('../src/main/session.js');

const CHAT = 'https://chat.google.com';
const IDP_ORIGINS = [
  'https://login.idp.example',
  'https://adfs',
  'https://sso.corp.example.com',
  'https://login.microsoftonline.com',
  'https://dev-123456.okta.com',
  'https://www.google.com',
  'https://chat.google.com.evil.example',
];
const PERMISSIONS = [
  'notifications',
  'clipboard-sanitized-write',
  'clipboard-read',
  'media',
  'display-capture',
  'fullscreen',
  'speaker-selection',
  'geolocation',
  'midi',
  'midiSysex',
  'openExternal',
  'pointerLock',
  'mediaKeySystem',
  'idle-detection',
  'window-management',
  'fileSystem',
  'hid',
  'serial',
  'usb',
  'unknown-permission',
];

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
  const request = (permission, requestingUrl, topLevelUrl) => {
    let granted;
    let calls = 0;
    const wc = topLevelUrl === undefined ? undefined : { getURL: () => topLevelUrl };
    h.request(wc, permission, (v) => { granted = v; calls += 1; }, { requestingUrl });
    assert.equal(calls, 1, 'callback invoked exactly once');
    return granted;
  };
  const check = (permission, requestingOrigin, details = {}, topLevelUrl) => {
    const wc = topLevelUrl === undefined ? null : { getURL: () => topLevelUrl };
    return h.check(wc, permission, requestingOrigin, details);
  };
  return { request, check };
}

test('permission request: an IdP origin as REQUESTER is denied every permission (page URL IdP too)', () => {
  const { request } = setup();
  for (const origin of IDP_ORIGINS) {
    for (const permission of PERMISSIONS) {
      assert.equal(request(permission, `${origin}/sso`, `${origin}/sso`), false, `${permission} @ ${origin}`);
    }
  }
});

test('permission request: an IdP origin as TOP-LEVEL page (requestingUrl absent) is denied every permission', () => {
  const { request } = setup();
  for (const origin of IDP_ORIGINS) {
    for (const permission of PERMISSIONS) {
      assert.equal(request(permission, undefined, `${origin}/sso`), false, `${permission} @ ${origin}`);
    }
  }
});

test('permission request: the sign-in origin itself (accounts.google.com) is denied every permission', () => {
  const { request } = setup();
  for (const permission of PERMISSIONS) {
    assert.equal(request(permission, 'https://accounts.google.com/v3/signin', 'https://accounts.google.com/v3/signin'), false, permission);
  }
});

test('permission check: an IdP origin as requester, with or without an IdP top-level / embedding origin, is denied every permission', () => {
  const { check } = setup();
  for (const origin of IDP_ORIGINS) {
    for (const permission of PERMISSIONS) {
      assert.equal(check(permission, origin), false, `${permission} @ ${origin}`);
      assert.equal(check(permission, `${origin}/`, { embeddingOrigin: `${origin}/` }, `${origin}/sso`), false, `${permission} embedded @ ${origin}`);
      assert.equal(check(permission, origin, { requestingUrl: `${origin}/x` }, `${origin}/sso`), false, `${permission} top-level @ ${origin}`);
    }
  }
});

test('permission check: Chat keeps its two grants and nothing else (the pin has a positive control)', () => {
  const { check, request } = setup();
  assert.equal(request('notifications', `${CHAT}/`), true);
  assert.equal(check('notifications', CHAT), true);
  assert.equal(request('clipboard-sanitized-write', `${CHAT}/`), true);
  assert.equal(check('clipboard-sanitized-write', CHAT), true);
  for (const permission of ['media', 'display-capture', 'fullscreen', 'speaker-selection', 'clipboard-read']) {
    assert.equal(request(permission, `${CHAT}/`), false, permission);
  }
});
