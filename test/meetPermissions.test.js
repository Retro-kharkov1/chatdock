'use strict';

// UI-01 / NFR-07 permission policy for Meet (docs/architecture/meet-call-window.md section 6).
// RED until src/main/meetPermissions.js exists and session.js installs it.
//
// API contract assumed (where the doc is silent, a minimal injectable shape; the implementer may argue
// and then change this header and the tests together):
//
//   src/main/meetPermissions.js
//     meetOriginGate({ requestingOrigin, topLevelOrigin }) -> boolean
//       pure. Each origin may be an origin, a URL with path, or have a trailing slash; both are
//       normalised with new URL(x).origin. true only when BOTH equal https://meet.google.com.
//       Missing / non-string / unparseable -> false (fail closed).
//
//   src/main/session.js  configurePersistentSession(ses, { notificationOrigins, clipboardOrigins?,
//                                                          displayMediaHandler? })
//     * The EXISTING request/check handlers are extended in place (no new handler registration), so the
//       existing stub `ses` objects of session.test.js / sessionPermissions.test.js keep working:
//       `setDisplayMediaRequestHandler` is called ONLY when `displayMediaHandler` is given, and a ses
//       stub without that method must not throw otherwise.
//     * Top-level origin of a request: for the REQUEST handler, `webContents.getURL()`; for the CHECK
//       handler `details.embeddingOrigin` when present, else `webContents.getURL()`. A null/absent
//       webContents with no embeddingOrigin has no top-level origin -> deny (fail closed). An
//       `embeddingOrigin` that is present and not Meet is a denial even if webContents is on Meet.
//     * Requesting origin: request handler `details.requestingUrl`; check handler `requestingOrigin`
//       (details.requestingUrl as fallback), exactly like today's notification path.
//     * media (request): grant iff the gate passes; `details.mediaTypes` may be ['audio'], ['video'],
//       both, or EMPTY (screen-share precursor). media (check): grant iff the gate passes and
//       `details.mediaType` is not 'unknown' (absent is fine). speaker-selection (check) and
//       display-capture (request + check): same gate. Everything else keeps today's behaviour.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configurePersistentSession } = require('../src/main/session.js');
const { load } = require('./helpers/pending');

const CHAT = 'https://chat.google.com';
const MEET = 'https://meet.google.com';
const CLIPBOARD_WRITE = 'clipboard-sanitized-write';

function setup({ displayMediaHandler } = {}) {
  const h = {};
  const ses = {
    setUserAgent: () => {},
    setPermissionRequestHandler: (fn) => { h.request = fn; },
    setPermissionCheckHandler: (fn) => { h.check = fn; },
  };
  if (displayMediaHandler !== undefined) {
    ses.setDisplayMediaRequestHandler = (fn) => { h.displayMedia = fn; };
  }
  configurePersistentSession(ses, { notificationOrigins: [CHAT], displayMediaHandler });
  /** request(permission, { requesting, top, mediaTypes }) - exactly-once callback asserted. */
  const request = (permission, { requesting, top, mediaTypes } = {}) => {
    let granted;
    let calls = 0;
    const wc = top === undefined ? null : { getURL: () => top };
    const details = { requestingUrl: requesting };
    if (mediaTypes !== undefined) details.mediaTypes = mediaTypes;
    h.request(wc, permission, (v) => { granted = v; calls += 1; }, details);
    assert.equal(calls, 1, 'callback must be invoked exactly once');
    return granted;
  };
  /** check(permission, { requesting, top, mediaType, embedding }) */
  const check = (permission, { requesting, top, mediaType, embedding } = {}) => {
    const wc = top === undefined ? null : { getURL: () => top };
    const details = {};
    if (mediaType !== undefined) details.mediaType = mediaType;
    if (embedding !== undefined) details.embeddingOrigin = embedding;
    return h.check(wc, permission, requesting, details);
  };
  return { request, check, h };
}

// --- origin gate (pure) --------------------------------------------------------------------------

test('meetOriginGate: both origins exactly https://meet.google.com -> true (trailing slash and path normalised)', () => {
  const { meetOriginGate } = load('meetPermissions.js');
  for (const [req, top] of [
    [MEET, MEET],
    [`${MEET}/`, `${MEET}/`],
    [`${MEET}/abc-defg-hij`, `${MEET}/abc-defg-hij?x=1`],
    ['https://MEET.GOOGLE.COM:443/', MEET],
  ]) {
    assert.equal(meetOriginGate({ requestingOrigin: req, topLevelOrigin: top }), true, `${req} in ${top}`);
  }
});

const GATE_DENIALS = [
  ['http meet', 'http://meet.google.com', 'http://meet.google.com'],
  ['chat in chat', CHAT, CHAT],
  ['foreign in foreign', 'https://evil.example', 'https://evil.example'],
  ['meet frame inside chat', MEET, CHAT],
  ['meet frame inside a foreign page', MEET, 'https://evil.example'],
  ['foreign frame inside meet', 'https://evil.example', MEET],
  ['lookalike requesting', 'https://meet.google.com.evil.example', MEET],
  ['lookalike top', MEET, 'https://meet.google.com.evil.example'],
  ['non-default port', 'https://meet.google.com:8443', 'https://meet.google.com:8443'],
  ['trailing dot', 'https://meet.google.com.', 'https://meet.google.com.'],
  ['userinfo', 'https://a@meet.google.com', MEET],
  ['missing requesting', undefined, MEET],
  ['missing top', MEET, undefined],
  ['null top', MEET, null],
  ['unparseable requesting', 'not a url', MEET],
  ['unparseable top', MEET, 'not a url'],
  ['empty strings', '', ''],
  ['non-string origins', 42, {}],
];

for (const [label, req, top] of GATE_DENIALS) {
  test(`meetOriginGate: denied for ${label}`, () => {
    const { meetOriginGate } = load('meetPermissions.js');
    assert.equal(meetOriginGate({ requestingOrigin: req, topLevelOrigin: top }), false);
  });
}

test('meetOriginGate: never throws on a missing argument object', () => {
  const { meetOriginGate } = load('meetPermissions.js');
  assert.doesNotThrow(() => meetOriginGate());
  assert.equal(meetOriginGate(), false);
  assert.equal(meetOriginGate({}), false);
});

// --- NFR-07 requesting / top matrix (seven rows), request AND check handlers --------------------------

const MATRIX = [
  [MEET, MEET, true],
  ['http://meet.google.com', 'http://meet.google.com', false],
  [CHAT, CHAT, false],
  ['https://evil.example', 'https://evil.example', false],
  [MEET, CHAT, true, false], // BUG-09: Chat embeds the call as a Meet iframe; display-capture stays Meet-only
  [MEET, 'https://evil.example', false],
  ['https://evil.example', MEET, false],
  [MEET, 'https://meet.google.com.evil.com', false],
  ['https://meet.google.com.evil.com', CHAT, false],
  ['https://meet.google.com.evil.com', MEET, false],
  ['http://meet.google.com', CHAT, false],
  [MEET, 'http://chat.google.com', false],
  ['https://meet.google.com:8443', CHAT, false],
  [MEET, 'https://chat.google.com:8443', false],
  ['https://user@meet.google.com', CHAT, false],
  [MEET, 'https://user@chat.google.com', false],
  ['https://sub.meet.google.com', CHAT, false],
  [MEET, 'https://sub.chat.google.com', false],
];

for (const [requesting, top, expected, displayCaptureExpected = expected] of MATRIX) {
  const verdict = expected ? 'granted' : 'denied';
  const row = `${requesting} in ${top}`;

  test(`media request matrix: camera, microphone, both and screen-share precursor are ${verdict} for ${row}`, () => {
    const { request } = setup();
    for (const mediaTypes of [['video'], ['audio'], ['audio', 'video'], []]) {
      assert.equal(request('media', { requesting: `${requesting}/`, top: `${top}/`, mediaTypes }), expected, JSON.stringify(mediaTypes));
    }
  });

  test(`media check matrix: video and audio are ${verdict} for ${row}`, () => {
    const { check } = setup();
    for (const mediaType of ['video', 'audio']) {
      assert.equal(check('media', { requesting: `${requesting}/`, top: `${top}/`, mediaType, embedding: `${top}/` }), expected, mediaType);
    }
  });

  test(`display-capture (defence in depth) is ${displayCaptureExpected ? 'granted' : 'denied'} for ${row}, in both handlers`, () => {
    const { request, check } = setup();
    assert.equal(request('display-capture', { requesting: `${requesting}/`, top: `${top}/`, mediaTypes: [] }), displayCaptureExpected);
    assert.equal(check('display-capture', { requesting: `${requesting}/`, top: `${top}/`, embedding: `${top}/` }), displayCaptureExpected);
  });

  test(`speaker-selection check is ${verdict} for ${row}`, () => {
    const { check } = setup();
    assert.equal(check('speaker-selection', { requesting: `${requesting}/`, top: `${top}/`, embedding: `${top}/` }), expected);
  });
}

// --- Spike B shapes ------------------------------------------------------------------------------------

test('media request: origins arrive with a trailing slash (Spike B) and with or without a path', () => {
  const { request } = setup();
  for (const requesting of ['https://meet.google.com/', 'https://meet.google.com', 'https://meet.google.com/abc-defg-hij']) {
    assert.equal(request('media', { requesting, top: 'https://meet.google.com/abc-defg-hij', mediaTypes: ['audio'] }), true, requesting);
  }
});

test('media request: the empty mediaTypes of getDisplayMedia is granted for Meet or the display handler is never reached', () => {
  const { request } = setup();
  assert.equal(request('media', { requesting: `${MEET}/`, top: `${MEET}/`, mediaTypes: [] }), true);
});

test('media check: absent mediaType (Spike B: sometimes absent) is granted for Meet; "unknown" is denied', () => {
  const { check } = setup();
  assert.equal(check('media', { requesting: `${MEET}/`, top: `${MEET}/`, embedding: `${MEET}/` }), true);
  assert.equal(check('media', { requesting: `${MEET}/`, top: `${MEET}/`, mediaType: 'unknown', embedding: `${MEET}/` }), false);
});

test('speaker-selection check from the Meet origin is granted (output-device choice)', () => {
  const { check } = setup();
  assert.equal(check('speaker-selection', { requesting: `${MEET}/`, top: `${MEET}/`, embedding: `${MEET}/` }), true);
});

// --- BUG-09: Meet iframe embedded in Chat --------------------------------------------------------------

test('BUG-09 media check: embedding "<none>" falls back to webContents.getURL() on Chat (log shape)', () => {
  const { check } = setup();
  for (const mediaType of ['audio', 'video']) {
    assert.equal(check('media', { requesting: `${MEET}/`, top: `${CHAT}/`, mediaType }), true, mediaType);
  }
  assert.equal(check('media', { requesting: `${MEET}/`, top: 'https://evil.example/', mediaType: 'audio' }), false);
});

test('BUG-09 media request: Meet iframe in Chat is granted for audio, video and both', () => {
  const { request } = setup();
  for (const mediaTypes of [['audio'], ['video'], ['audio', 'video']]) {
    assert.equal(request('media', { requesting: `${MEET}/`, top: `${CHAT}/`, mediaTypes }), true);
  }
});

test('BUG-09 speaker-selection: Meet iframe in Chat is granted', () => {
  const { check } = setup();
  assert.equal(check('speaker-selection', { requesting: `${MEET}/`, top: `${CHAT}/`, embedding: `${CHAT}/` }), true);
});

test('BUG-09 media: Chat as requester stays denied, also under a Meet top level', () => {
  const { request, check } = setup();
  assert.equal(request('media', { requesting: `${CHAT}/`, top: `${CHAT}/`, mediaTypes: ['audio'] }), false);
  assert.equal(request('media', { requesting: `${CHAT}/`, top: `${MEET}/`, mediaTypes: ['audio'] }), false);
  assert.equal(check('media', { requesting: `${CHAT}/`, top: `${MEET}/`, mediaType: 'audio', embedding: `${MEET}/` }), false);
});

test('BUG-09 display-capture and screen-wake-lock stay denied for the Meet iframe in Chat', () => {
  const { request, check } = setup();
  assert.equal(request('display-capture', { requesting: `${MEET}/`, top: `${CHAT}/`, mediaTypes: [] }), false);
  assert.equal(check('display-capture', { requesting: `${MEET}/`, top: `${CHAT}/`, embedding: `${CHAT}/` }), false);
  assert.equal(request('screen-wake-lock', { requesting: `${MEET}/`, top: `${CHAT}/` }), false);
  assert.equal(check('screen-wake-lock', { requesting: `${MEET}/`, top: `${CHAT}/`, embedding: `${CHAT}/` }), false);
});

const DOCS = 'https://docs.google.com';
const CYRILLIC_A_CHAT = 'https://ch\u0430t.google.com';
const BAD_TOPS = [
  'https://chat.google.com.',
  'https://chat.google.com.evil.com',
  CYRILLIC_A_CHAT,
  'https://xn--cht-8cd.google.com',
  'null',
  'about:blank',
  'about:srcdoc',
  'data:text/html,<p>x</p>',
  'file:///c:/x.html',
  '',
  DOCS,
];

test('meetMediaGate: direct table', () => {
  const { meetMediaGate } = load('meetPermissions.js');
  const g = (requestingOrigin, topLevelOrigin) => meetMediaGate({ requestingOrigin, topLevelOrigin });
  assert.equal(g(MEET, MEET), true);
  assert.equal(g(MEET, CHAT), true);
  assert.equal(g(`${MEET}/`, `${CHAT}/x/y`), true);
  assert.equal(g('https://MEET.GOOGLE.COM', 'https://CHAT.GOOGLE.COM'), true, 'host case is normalised by URL');
  assert.equal(g(CHAT, CHAT), false);
  assert.equal(g(CHAT, MEET), false);
  assert.equal(g(DOCS, CHAT), false);
  assert.equal(g(MEET, DOCS), false);
  assert.equal(g(MEET, undefined), false);
  assert.equal(g(undefined, CHAT), false);
  assert.equal(g(MEET, null), false);
  assert.equal(g(MEET, 42), false);
  assert.equal(meetMediaGate(), false);
  assert.equal(meetMediaGate({}), false);
  for (const top of BAD_TOPS) assert.equal(g(MEET, top), false, `top ${top}`);
  for (const req of ['https://meet.google.com.', CYRILLIC_A_CHAT, 'null', 'about:blank', 'data:text/html,x', '']) {
    assert.equal(g(req, CHAT), false, `requester ${req}`);
  }
});

test('BUG-09 look-alike and opaque top levels are denied in request and check handlers', () => {
  const { request, check } = setup();
  for (const top of BAD_TOPS) {
    assert.equal(request('media', { requesting: `${MEET}/`, top, mediaTypes: ['audio'] }), false, `request top ${top}`);
    assert.equal(check('media', { requesting: `${MEET}/`, top, mediaType: 'audio' }), false, `check wc ${top}`);
    assert.equal(check('media', { requesting: `${MEET}/`, top: CHAT, mediaType: 'audio', embedding: top }), false, `check embedding ${top}`);
  }
});

test('BUG-09 check: Docs window (top docs.google.com) embedding Chat embedding Meet is denied, request too', () => {
  const { request, check } = setup();
  assert.equal(check('media', { requesting: `${MEET}/`, top: `${DOCS}/document/d/1`, mediaType: 'audio', embedding: `${CHAT}/` }), false);
  assert.equal(check('speaker-selection', { requesting: `${MEET}/`, top: `${DOCS}/`, embedding: `${CHAT}/` }), false);
  assert.equal(request('media', { requesting: `${MEET}/`, top: `${DOCS}/`, mediaTypes: ['audio'] }), false);
});

test('BUG-09 check: a third-party frame between Chat and Meet is denied (embedding is the third party)', () => {
  const { check } = setup();
  assert.equal(check('media', { requesting: `${MEET}/`, top: `${CHAT}/`, mediaType: 'video', embedding: 'https://evil.example/' }), false);
  assert.equal(check('speaker-selection', { requesting: `${MEET}/`, top: `${CHAT}/`, embedding: 'https://evil.example/' }), false);
});

test('BUG-09 check: every signal must pass; a Meet embedding under a non-Chat webContents is denied', () => {
  const { check } = setup();
  assert.equal(check('media', { requesting: `${MEET}/`, top: `${CHAT}/`, mediaType: 'audio', embedding: `${CHAT}/` }), true);
  assert.equal(check('media', { requesting: `${MEET}/`, top: `${MEET}/`, mediaType: 'audio', embedding: `${CHAT}/` }), true);
  assert.equal(check('media', { requesting: `${MEET}/`, top: 'https://evil.example/', mediaType: 'audio', embedding: `${CHAT}/` }), false);
  assert.equal(check('media', { requesting: `${MEET}/`, top: 'https://evil.example/', mediaType: 'audio', embedding: `${MEET}/` }), false);
});

test('BUG-09 media: Meet iframe under an embedding that is not Chat or Meet is denied even if webContents is Chat', () => {
  const { check } = setup();
  assert.equal(check('media', { requesting: `${MEET}/`, top: `${CHAT}/`, mediaType: 'audio', embedding: 'https://evil.example/' }), false);
});

// --- fail closed ---------------------------------------------------------------------------------------

test('media request: null webContents (no top-level page) is denied, callback still invoked once', () => {
  const { request } = setup();
  assert.equal(request('media', { requesting: `${MEET}/`, top: undefined, mediaTypes: ['audio'] }), false);
});

test('media request: missing or unparseable requesting origin is denied', () => {
  const { request } = setup();
  assert.equal(request('media', { requesting: undefined, top: `${MEET}/`, mediaTypes: ['audio'] }), false);
  assert.equal(request('media', { requesting: 'not a url', top: `${MEET}/`, mediaTypes: ['audio'] }), false);
});

test('media check: null webContents and no embeddingOrigin is denied', () => {
  const { check } = setup();
  assert.equal(check('media', { requesting: `${MEET}/`, top: undefined, mediaType: 'audio' }), false);
});

test('media check: an embeddingOrigin that is not Meet is a denial even when webContents shows a Meet page', () => {
  const { check } = setup();
  for (const mediaType of ['audio', 'video']) {
    assert.equal(check('media', { requesting: `${MEET}/`, top: `${MEET}/`, mediaType, embedding: 'https://evil.example/' }), false, mediaType);
  }
});

test('media check: missing or unparseable requesting origin is denied', () => {
  const { check } = setup();
  assert.equal(check('media', { requesting: undefined, top: `${MEET}/`, mediaType: 'audio', embedding: `${MEET}/` }), false);
  assert.equal(check('media', { requesting: 'not a url', top: `${MEET}/`, mediaType: 'audio', embedding: `${MEET}/` }), false);
});

test('handlers tolerate a webContents without getURL and missing details (deny, callback once)', () => {
  const { h } = setup();
  const results = [];
  h.request({}, 'media', (v) => results.push(v), undefined);
  h.request(null, 'media', (v) => results.push(v), {});
  assert.deepEqual(results, [false, false]);
  assert.equal(h.check({}, 'media', undefined, undefined), false);
});

// --- everything else is unchanged ---------------------------------------------------------------------

test('Meet gate does not widen anything else: other permissions stay denied from the Meet origin', () => {
  const { request, check } = setup();
  for (const p of ['geolocation', 'clipboard-read', 'midi', 'midiSysex', 'openExternal', 'pointerLock', 'idle-detection', 'hid', 'serial', 'usb', 'unknown-permission']) {
    assert.equal(request(p, { requesting: `${MEET}/`, top: `${MEET}/` }), false, `request ${p}`);
    assert.equal(check(p, { requesting: `${MEET}/`, top: `${MEET}/`, embedding: `${MEET}/` }), false, `check ${p}`);
  }
});

test('Meet origin does not gain notifications or clipboard write (those stay Chat-only)', () => {
  const { request, check } = setup();
  for (const p of ['notifications', CLIPBOARD_WRITE]) {
    assert.equal(request(p, { requesting: `${MEET}/`, top: `${MEET}/` }), false, `request ${p}`);
    assert.equal(check(p, { requesting: `${MEET}/`, top: `${MEET}/`, embedding: `${MEET}/` }), false, `check ${p}`);
  }
});

test('main window still works: Chat keeps notifications and clipboard write, and gets no media or display-capture', () => {
  const { request, check } = setup();
  assert.equal(request('notifications', { requesting: `${CHAT}/`, top: `${CHAT}/` }), true);
  assert.equal(request(CLIPBOARD_WRITE, { requesting: `${CHAT}/`, top: `${CHAT}/` }), true);
  assert.equal(check('notifications', { requesting: CHAT }), true);
  assert.equal(check(CLIPBOARD_WRITE, { requesting: CHAT }), true);
  for (const p of ['media', 'display-capture', 'speaker-selection']) {
    assert.equal(request(p, { requesting: `${CHAT}/`, top: `${CHAT}/`, mediaTypes: ['audio'] }), false, `request ${p}`);
    assert.equal(check(p, { requesting: `${CHAT}/`, top: `${CHAT}/`, mediaType: 'audio', embedding: `${CHAT}/` }), false, `check ${p}`);
  }
});

test('Chat notifications from a page embedded in Meet are still denied (requesting origin wins)', () => {
  const { request } = setup();
  assert.equal(request('notifications', { requesting: 'https://evil.example/', top: `${CHAT}/` }), false);
});

// --- display-media handler installation ----------------------------------------------------------------

test('configurePersistentSession installs the display-media handler only when one is supplied', () => {
  const handler = () => {};
  const withHandler = setup({ displayMediaHandler: handler });
  assert.equal(withHandler.h.displayMedia, handler);
  assert.doesNotThrow(() => setup());
});
