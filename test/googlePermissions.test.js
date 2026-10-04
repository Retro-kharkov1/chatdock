'use strict';

// UI-04 permissions on the shared session (docs/architecture/google-app-windows.md section 6, coverage-map
// row "Permissions"). Part 1 (the constant and the Electron field-name pin) and Part 2 (the grants) are RED until
// src/main/session.js gains GOOGLE_APP_CLIPBOARD_FULLSCREEN_ORIGINS and the requesting-plus-top-level check;
// Part 3 (everything that must NOT change) is GREEN on current code and must stay green.
//
// API ASSUMED: configurePersistentSession(ses, { notificationOrigins, ... }) keeps its signature. New export
// GOOGLE_APP_CLIPBOARD_FULLSCREEN_ORIGINS = frozen [https://docs.google.com, https://drive.google.com] (a separate
// constant, not derived from the nav list). For 'clipboard-sanitized-write' and 'fullscreen' both handlers
// grant ONLY when the requesting origin AND the top-level origin are in that set:
//   request handler: requesting = details.requestingUrl, top-level = origin of webContents.getURL()
//   check handler:   requesting = requestingOrigin,      top-level = details.embeddingOrigin
// A missing, empty or unparseable top-level -> deny. Chat's existing clipboard grant (requesting origin only)
// and every Meet decision are untouched.
//
// SPEC RISK (to raise, not to hide): Electron documents `embeddingOrigin` as "Only set for cross-origin sub
// frames making permission checks". If a TOP-LEVEL docs page's check carries no embeddingOrigin, the spec rule
// "missing top-level -> deny" would deny the very page it means to grant. The tests below pin the spec as
// written (missing embeddingOrigin and no other top-level information -> deny) and do not pin what happens when
// the check handler is also given a webContents URL; the implementer/spike must settle that with evidence.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const session = require('../src/main/session.js');
const { configurePersistentSession } = session;

const CHAT = 'https://chat.google.com';
const DOCS = 'https://docs.google.com';
const DRIVE = 'https://drive.google.com';
const MEET = 'https://meet.google.com';
const GRANTED_ONLY_FOR_DOCS_DRIVE = ['clipboard-sanitized-write', 'fullscreen'];

function setup() {
  const h = {};
  const ses = {
    setUserAgent: () => {},
    setPermissionRequestHandler: (fn) => { h.request = fn; },
    setPermissionCheckHandler: (fn) => { h.check = fn; },
  };
  configurePersistentSession(ses, { notificationOrigins: [CHAT] });
  /** request(permission, requestingUrl, topLevelUrl, extraDetails) -> granted */
  const request = (permission, requestingUrl, topLevelUrl, extra = {}) => {
    let granted;
    let calls = 0;
    const wc = topLevelUrl === undefined ? undefined : { getURL: () => topLevelUrl };
    h.request(wc, permission, (v) => { granted = v; calls += 1; }, { requestingUrl, ...extra });
    assert.equal(calls, 1, 'callback must be invoked exactly once');
    return granted;
  };
  /** check(permission, requestingOrigin, embeddingOrigin, extraDetails) -> boolean */
  const check = (permission, requestingOrigin, embeddingOrigin, extra = {}) =>
    h.check(null, permission, requestingOrigin, { embeddingOrigin, ...extra });
  return { request, check };
}

// --- Part 1: the constant and the Electron field-name pin -----------------------------------------------------------------

test('constant: GOOGLE_APP_CLIPBOARD_FULLSCREEN_ORIGINS is exactly docs.google.com and drive.google.com, frozen', () => {
  const list = session.GOOGLE_APP_CLIPBOARD_FULLSCREEN_ORIGINS;
  assert.deepEqual([...list].sort(), [DOCS, DRIVE].sort());
  assert.equal(Object.isFrozen(list), true);
});

const electronTypes = path.join(__dirname, '..', 'node_modules', 'electron', 'electron.d.ts');

test('field-name pin: the installed Electron still names the check-handler top-level origin "embeddingOrigin" and the request details "requestingUrl"', { skip: !fs.existsSync(electronTypes) }, () => {
  const text = fs.readFileSync(electronTypes, 'utf8');
  const check = /interface PermissionCheckHandlerHandlerDetails \{[\s\S]*?\n  \}/.exec(text);
  assert.ok(check, 'PermissionCheckHandlerHandlerDetails exists');
  assert.match(check[0], /embeddingOrigin\?: string/);
  assert.match(check[0], /requestingUrl\?: string/);
  const request = /interface PermissionRequest \{[\s\S]*?\n  \}/.exec(text);
  assert.ok(request, 'PermissionRequest exists');
  assert.match(request[0], /requestingUrl: string/);
});

test('field-name pin: "fullscreen" and "clipboard-sanitized-write" are still permission names in the installed Electron', { skip: !fs.existsSync(electronTypes) }, () => {
  const text = fs.readFileSync(electronTypes, 'utf8');
  assert.match(text, /setPermissionRequestHandler\(handler: [^\n]*'clipboard-sanitized-write'[^\n]*'fullscreen'/);
});

// --- Part 2: grants ---------------------------------------------------------------------------------------------------------------------

for (const permission of GRANTED_ONLY_FOR_DOCS_DRIVE) {
  for (const [requesting, top] of [[DOCS, DOCS], [DRIVE, DRIVE], [DOCS, DRIVE], [DRIVE, DOCS]]) {
    test(`request: ${permission} granted when requesting ${requesting} and top-level ${top} are both docs/drive`, () => {
      assert.equal(setup().request(permission, `${requesting}/document/d/1/edit`, `${top}/x`), true);
    });
    test(`check: ${permission} true when requesting ${requesting} and embeddingOrigin ${top} are both docs/drive`, () => {
      assert.equal(setup().check(permission, requesting, top), true);
    });
  }

  test(`check: ${permission} tolerates a trailing slash and default port on both origins`, () => {
    assert.equal(setup().check(permission, `${DOCS}/`, 'https://drive.google.com:443'), true);
  });

  // denied: wrong requesting origin
  for (const requesting of [
    'https://calendar.google.com',
    'https://mail.google.com',
    'https://keep.google.com',
    'https://contacts.google.com',
    'https://sites.google.com',
    'https://accounts.google.com',
    MEET,
    'https://evil.example',
    'https://docs.google.com.evil.example',
    'https://xdocs.google.com',
    'http://docs.google.com',
    'https://docs.google.com:8443',
    'https://drive.usercontent.google.com',
  ]) {
    test(`request: ${permission} denied for requesting ${requesting} under a docs top-level`, () => {
      assert.equal(setup().request(permission, `${requesting}/x`, `${DOCS}/x`), false);
    });
    test(`check: ${permission} false for requesting ${requesting} under a docs embeddingOrigin`, () => {
      assert.equal(setup().check(permission, requesting, DOCS), false);
    });
  }

  // denied: wrong / missing top-level origin (a docs/drive frame embedded under something else)
  for (const top of [
    CHAT,
    'https://calendar.google.com',
    'https://mail.google.com',
    MEET,
    'https://evil.example',
    'https://docs.google.com.evil.example',
    'https://docs.google.com:8443',
    'http://docs.google.com',
    '',
    'not a url',
  ]) {
    test(`request: ${permission} denied for a docs frame whose top-level is ${JSON.stringify(top)}`, () => {
      assert.equal(setup().request(permission, `${DOCS}/x`, top), false);
    });
    test(`check: ${permission} false for a docs frame whose embeddingOrigin is ${JSON.stringify(top)}`, () => {
      assert.equal(setup().check(permission, DOCS, top), false);
    });
  }

  test(`request: ${permission} denied when there is no asking contents (no top-level at all)`, () => {
    assert.equal(setup().request(permission, `${DOCS}/x`, undefined), false);
  });

  test(`check: ${permission} false when embeddingOrigin is missing and there is no webContents (spec: missing top-level -> deny)`, () => {
    const { check } = setup();
    assert.equal(check(permission, DOCS, undefined), false);
    assert.equal(check(permission, DOCS, null), false);
  });

  test(`request: ${permission} a Chat-embedded docs frame (requesting listed, top-level chat.google.com) gets nothing new`, () => {
    assert.equal(setup().request(permission, `${DOCS}/x`, `${CHAT}/room/x`), false);
  });

  test(`check: ${permission} a Chat-embedded drive frame (embeddingOrigin chat.google.com) gets nothing new`, () => {
    assert.equal(setup().check(permission, DRIVE, CHAT), false);
  });

  test(`request: ${permission} a foreign frame cannot borrow the docs top-level ... requestingUrl wins over the webContents url`, () => {
    assert.equal(setup().request(permission, 'https://evil.example/x', `${DOCS}/x`), false);
  });
}

// --- Part 3: everything else stays denied / unchanged (GREEN today) -------------------------------------------------------------------------

const NEVER_GRANTED_TO_APP_WINDOWS = [
  'clipboard-read',
  'clipboard-sanitized-read',
  'clipboard-write',
  'media',
  'speaker-selection',
  'display-capture',
  'notifications',
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

for (const permission of NEVER_GRANTED_TO_APP_WINDOWS) {
  for (const origin of [DOCS, DRIVE, 'https://calendar.google.com', 'https://mail.google.com']) {
    test(`guard: ${permission} stays denied for ${origin} even under a docs top-level (request and check)`, () => {
      const { request, check } = setup();
      assert.equal(request(permission, `${origin}/x`, `${DOCS}/x`, { mediaTypes: ['audio', 'video'] }), false);
      assert.equal(check(permission, origin, DOCS, { mediaType: 'audio' }), false);
    });
  }
}

test('guard: calendar and mail get neither clipboard write nor fullscreen, even as their own top-level', () => {
  const { request, check } = setup();
  for (const origin of ['https://calendar.google.com', 'https://mail.google.com']) {
    for (const permission of GRANTED_ONLY_FOR_DOCS_DRIVE) {
      assert.equal(request(permission, `${origin}/x`, `${origin}/x`), false, `${permission} ${origin}`);
      assert.equal(check(permission, origin, origin), false, `${permission} ${origin}`);
    }
  }
});

test('unchanged: Chat keeps notifications and clipboard-sanitized-write by requesting origin alone', () => {
  const { request, check } = setup();
  assert.equal(request('notifications', `${CHAT}/`, undefined), true);
  assert.equal(request('clipboard-sanitized-write', `${CHAT}/app`, undefined), true);
  assert.equal(check('notifications', CHAT, undefined), true);
  assert.equal(check('clipboard-sanitized-write', CHAT, undefined), true);
});

test('fullscreen: a Chat-origin frame under a docs top-level gets no fullscreen (Chat keeps its clipboard grant by existing logic, nothing more)', () => {
  const { request, check } = setup();
  assert.equal(request('fullscreen', `${CHAT}/x`, `${DOCS}/x`), false);
  assert.equal(check('fullscreen', CHAT, DOCS), false);
});

test('unchanged: Chat (main window) still gets no fullscreen', () => {
  const { request, check } = setup();
  assert.equal(request('fullscreen', `${CHAT}/`, `${CHAT}/`), false);
  assert.equal(check('fullscreen', CHAT, CHAT), false);
});

test('unchanged: Meet (call window) still gets no fullscreen and no clipboard write', () => {
  const { request, check } = setup();
  for (const permission of GRANTED_ONLY_FOR_DOCS_DRIVE) {
    assert.equal(request(permission, `${MEET}/abc-defg-hij`, `${MEET}/abc-defg-hij`), false, permission);
    assert.equal(check(permission, MEET, MEET), false, permission);
  }
});

test('unchanged: the Meet media gate still grants media only when requesting AND top-level are Meet', () => {
  const { request, check } = setup();
  assert.equal(request('media', `${MEET}/abc-defg-hij`, `${MEET}/abc-defg-hij`, { mediaTypes: ['audio', 'video'] }), true);
  assert.equal(request('media', `${MEET}/abc-defg-hij`, `${DOCS}/x`, { mediaTypes: ['audio'] }), false);
  assert.equal(check('media', MEET, MEET, { mediaType: 'audio' }), true);
  assert.equal(check('media', MEET, DOCS, { mediaType: 'audio' }), false);
});

test('unchanged: a docs or drive page still gets no notifications (Chat origin only)', () => {
  const { request, check } = setup();
  for (const origin of [DOCS, DRIVE]) {
    assert.equal(request('notifications', `${origin}/x`, `${origin}/x`), false, origin);
    assert.equal(check('notifications', origin, origin), false, origin);
  }
});
