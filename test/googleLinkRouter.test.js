'use strict';

// UI-04 router extension (docs/architecture/google-app-windows.md sections 1, 3, 5; coverage-map row
// "Router"). RED until src/main/googleLink.js exists and linkRouter.js accepts the optional collaborators.
// The existing test/linkRouter.test.js and test/callWindow.test.js stay untouched and green: that is the
// "absent collaborators -> exactly today's behaviour" guarantee, re-pinned here against the real classifiers.
//
// API ASSUMED (extends createLinkRouter of test/linkRouter.test.js; every addition is OPTIONAL):
//
//   createLinkRouter({ ...existing,
//     classifyGoogleLink, classifyChatTarget,     // from googleLink.js, injected (the router stays pure)
//     openMainWindow(url),                        // classifyChatTarget 'main-window': load/show/focus main window
//     focusMainWindow(),                          // 'focus-main': restore/show/focus ONLY, never loadURL
//     downloadInMainWindow(url),                  // 'download': mainWindow.webContents.downloadURL(url)
//     openGoogleAppWindow(url, { hop }),          // Google link -> new/existing app window; hop true for forms.gle
//   }) -> { route(url, { source }), onWindowOpen(details), onWillNavigate(event, url, opts) }
//
//   NOTE (spec gap, to argue): the spec names two new collaborators (openMainWindow, openGoogleAppWindow).
//   The 'focus-main' and 'download' outcomes need two more seams; focusMainWindow and downloadInMainWindow
//   are assumed, and openGoogleAppWindow receives { hop } because the spec says the router calls "the
//   app-window collaborator with hop: true" for forms.gle.
//
//   route(url, { source } = {}) -> 'call-window' | 'main-window' | 'focus-main' | 'download' | 'app-window'
//                                  | 'external' | 'dropped'
//     source: 'main' (default; main-window popup / will-navigate to a non-Chat host) | 'app' (a Google app window)
//     Order: Meet (classifyLink) > Chat (classifyGoogleLink 'main-window' outcome, split by
//            classifyChatTarget(url, source)) > Google app / forms.gle hop (classifyGoogleLink 'app-window')
//            > http/https/mailto -> openExternal(url as given; also the 'browser' Chat outcome) > dropped
//            (logged by scheme only).
//     The Google/Chat rules are active only when the optional collaborators are present.
//   onWillNavigate(event, url, { allowedOrigins, source }) passes `source` through to route.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeEvent } = require('./helpers/electronFakes');
const { load } = require('./helpers/pending');

const DRIVE = 'https://drive.google.com/file/d/1/view?usp=sharing';
const MEET = 'https://meet.google.com/abc-defg-hij';
const CHAT_ROOM = 'https://chat.google.com/room/AAAA';
const CHAT_ATTACHMENT = 'https://chat.google.com/api/get_attachment_url?x=1';
const CHAT_POPOUT = 'https://chat.google.com/popout/room/AAAA';
const FORM_SHORT = 'https://forms.gle/abc';
const ALLOWED = ['https://chat.google.com', 'https://accounts.google.com'];

function setup({ google = true } = {}) {
  const calls = { callWindow: [], main: [], focus: 0, download: [], app: [], external: [], log: [] };
  const meetLink = load('meetLink.js');
  const deps = {
    classifyLink: meetLink.classifyLink,
    isOpenableExternalScheme: meetLink.isOpenableExternalScheme,
    openCallWindow: (url) => calls.callWindow.push(url),
    openExternal: (url) => calls.external.push(url),
    log: (...args) => calls.log.push(args),
  };
  if (google) {
    const googleLink = load('googleLink.js');
    Object.assign(deps, {
      classifyGoogleLink: googleLink.classifyGoogleLink,
      classifyChatTarget: googleLink.classifyChatTarget,
      openMainWindow: (url) => calls.main.push(url),
      focusMainWindow: () => { calls.focus += 1; },
      downloadInMainWindow: (url) => calls.download.push(url),
      openGoogleAppWindow: (url, opts) => calls.app.push({ url, hop: Boolean(opts && opts.hop) }),
    });
  }
  return { router: load('linkRouter.js').createLinkRouter(deps), calls };
}

const NOTHING = { callWindow: [], main: [], focus: 0, download: [], app: [], external: [] };
function only(calls, ...keep) {
  const copy = { ...NOTHING };
  for (const k of keep) copy[k] = calls[k];
  const { log, ...rest } = calls;
  return { actual: rest, expected: copy };
}

// --- order: Meet > Chat > Google app > external > dropped ----------------------------------------------------------

test('router: a Meet link opens the call window, never an app window, the main window or the browser', () => {
  const { router, calls } = setup();
  assert.equal(router.route(MEET), 'call-window');
  const { actual, expected } = only(calls, 'callWindow');
  assert.deepEqual(actual, expected);
  assert.deepEqual(calls.callWindow, [MEET]);
});

test('router: a google.com/url wrapper around a Meet link still wins as Meet (Meet is first)', () => {
  const { router, calls } = setup();
  assert.equal(router.route(`https://www.google.com/url?q=${encodeURIComponent(MEET)}`), 'call-window');
  assert.deepEqual(calls.callWindow, [MEET]);
});

test('router: a Drive link opens an app window ONCE with the normalised url (no hop); openExternal is never called', () => {
  const { router, calls } = setup();
  assert.equal(router.route('HTTPS://DRIVE.GOOGLE.COM/file/d/1/view?usp=sharing'), 'app-window');
  assert.deepEqual(calls.app, [{ url: DRIVE, hop: false }]);
  assert.deepEqual(calls.external, []);
});

test('router: a wrapper around a Drive link opens an app window with the TARGET url', () => {
  const { router, calls } = setup();
  router.route(`https://www.google.com/url?q=${encodeURIComponent(DRIVE)}`);
  assert.deepEqual(calls.app, [{ url: DRIVE, hop: false }]);
});

test('router: a forms.gle link goes to openGoogleAppWindow with hop: true (the factory decides the hop), not openExternal', () => {
  const { router, calls } = setup();
  assert.equal(router.route(FORM_SHORT), 'app-window');
  assert.deepEqual(calls.app, [{ url: FORM_SHORT, hop: true }]);
  assert.deepEqual(calls.external, []);
});

test('router: forms.gle from source app is the same hop (never openExternal)', () => {
  const { router, calls } = setup();
  assert.equal(router.route(FORM_SHORT, { source: 'app' }), 'app-window');
  assert.deepEqual(calls.app, [{ url: FORM_SHORT, hop: true }]);
  assert.deepEqual(calls.external, []);
});

// --- Chat: by source and path -------------------------------------------------------------------------------------------

test('router: a Chat conversation from a main-window popup only focuses the main window - no loadURL path, no browser', () => {
  const { router, calls } = setup();
  assert.equal(router.route(CHAT_ROOM, { source: 'main' }), 'focus-main');
  assert.equal(calls.focus, 1);
  assert.deepEqual([calls.main, calls.external, calls.download, calls.app], [[], [], [], []]);
});

test('router: the default source is the main window', () => {
  const { router, calls } = setup();
  assert.equal(router.route(CHAT_ROOM), 'focus-main');
  assert.equal(calls.focus, 1);
  assert.deepEqual(calls.main, []);
});

test('router: a Chat conversation from an app window loads in the main window with the normalised url', () => {
  const { router, calls } = setup();
  assert.equal(router.route('https://CHAT.google.com/room/AAAA', { source: 'app' }), 'main-window');
  assert.deepEqual(calls.main, [CHAT_ROOM]);
  assert.equal(calls.focus, 0);
  assert.deepEqual(calls.external, []);
});

test('router: a Chat attachment popup from the main window calls downloadInMainWindow, NOT openMainWindow', () => {
  const { router, calls } = setup();
  assert.equal(router.route(CHAT_ATTACHMENT, { source: 'main' }), 'download');
  assert.deepEqual(calls.download, [CHAT_ATTACHMENT]);
  assert.deepEqual([calls.main, calls.external, calls.app], [[], [], []]);
  assert.equal(calls.focus, 0);
});

test('router: a Chat attachment link from an app window goes to the system browser and NEVER to downloadInMainWindow', () => {
  const { router, calls } = setup();
  assert.equal(router.route(CHAT_ATTACHMENT, { source: 'app' }), 'external');
  assert.deepEqual(calls.external, [CHAT_ATTACHMENT]);
  assert.deepEqual(calls.download, []);
  assert.deepEqual(calls.main, []);
});

for (const source of ['main', 'app']) {
  test(`router: a Chat pop-out / unknown shape from source ${source} stays in the system browser (today's behaviour)`, () => {
    const { router, calls } = setup();
    assert.equal(router.route(CHAT_POPOUT, { source }), 'external');
    assert.deepEqual(calls.external, [CHAT_POPOUT]);
    assert.deepEqual([calls.main, calls.download, calls.app], [[], [], []]);
    assert.equal(calls.focus, 0);
  });
}

for (const url of [
  'https://example.org/',
  'https://maps.google.com/',
  'https://accounts.google.com/signin',
  'https://drive.usercontent.google.com/download?id=1',
  'https://drive.google.com.evil.example/x',
  'http://drive.google.com/x',
  'https://drive.google.com:8443/x',
  'mailto:a@b.example',
]) {
  test(`router: ${url} goes to the system browser and no app window or main window is used`, () => {
    const { router, calls } = setup();
    assert.equal(router.route(url), 'external');
    assert.deepEqual(calls.external, [url]);
    assert.deepEqual([calls.app, calls.main, calls.download], [[], [], []]);
  });
}

test('router: a disallowed scheme is dropped and logged by scheme only (existing rule kept)', () => {
  const { router, calls } = setup();
  assert.equal(router.route('javascript:alert(1)'), 'dropped');
  assert.deepEqual([calls.app, calls.main, calls.external, calls.download, calls.callWindow], [[], [], [], [], []]);
  assert.equal(calls.log.length, 1);
  assert.equal(JSON.stringify(calls.log).includes('alert'), false);
});

// --- window-open and will-navigate entry points ------------------------------------------------------------------------

test('router.onWindowOpen: always { action: "deny" } for Drive, Chat, Meet, browser and garbage targets', () => {
  const { router } = setup();
  for (const url of [DRIVE, CHAT_ROOM, CHAT_ATTACHMENT, MEET, FORM_SHORT, 'https://example.org/', 'garbage', undefined]) {
    assert.deepEqual(router.onWindowOpen({ url }), { action: 'deny' }, String(url));
  }
});

test('router.onWindowOpen: a Drive popup from the main window opens exactly one app window', () => {
  const { router, calls } = setup();
  router.onWindowOpen({ url: DRIVE });
  assert.deepEqual(calls.app, [{ url: DRIVE, hop: false }]);
});

test('router.onWindowOpen: a Chat conversation popup (main window source) only focuses the main window', () => {
  const { router, calls } = setup();
  router.onWindowOpen({ url: CHAT_ROOM });
  assert.equal(calls.focus, 1);
  assert.deepEqual(calls.main, []);
});

test('router.onWindowOpen: a collaborator that throws is contained (deny, logged), never rethrown', () => {
  const calls = [];
  const meetLink = load('meetLink.js');
  const googleLink = load('googleLink.js');
  const router = load('linkRouter.js').createLinkRouter({
    classifyLink: meetLink.classifyLink,
    isOpenableExternalScheme: meetLink.isOpenableExternalScheme,
    classifyGoogleLink: googleLink.classifyGoogleLink,
    classifyChatTarget: googleLink.classifyChatTarget,
    openCallWindow: () => {},
    openExternal: () => {},
    openMainWindow: () => {},
    focusMainWindow: () => {},
    downloadInMainWindow: () => {},
    openGoogleAppWindow: () => { throw new Error('boom'); },
    log: (...a) => calls.push(a),
  });
  assert.deepEqual(router.onWindowOpen({ url: DRIVE }), { action: 'deny' });
  assert.equal(calls.length, 1);
});

test('router.onWillNavigate: the main window navigating to Drive is prevented and opens an app window', () => {
  const { router, calls } = setup();
  const event = makeEvent();
  router.onWillNavigate(event, DRIVE, { allowedOrigins: ALLOWED });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(calls.app, [{ url: DRIVE, hop: false }]);
});

test('router.onWillNavigate: Chat and accounts origins in allowedOrigins still pass untouched (never reach the router)', () => {
  const { router, calls } = setup();
  for (const url of [CHAT_ROOM, 'https://accounts.google.com/signin']) {
    const event = makeEvent();
    router.onWillNavigate(event, url, { allowedOrigins: ALLOWED });
    assert.equal(event.defaultPrevented, false, url);
  }
  assert.deepEqual([calls.main, calls.app, calls.external, calls.download], [[], [], [], []]);
  assert.equal(calls.focus, 0);
});

test('router.onWillNavigate: source "app" passes through - a Chat conversation loads in the main window', () => {
  const { router, calls } = setup();
  const event = makeEvent();
  router.onWillNavigate(event, CHAT_ROOM, { allowedOrigins: [], source: 'app' });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(calls.main, [CHAT_ROOM]);
});

// --- absent collaborators: exactly today's behaviour -----------------------------------------------------------------------------

test('router without the Google collaborators: Drive, Chat and wrapper links go to the system browser as today', () => {
  const { router, calls } = setup({ google: false });
  assert.equal(router.route(DRIVE), 'external');
  assert.equal(router.route(CHAT_ROOM), 'external');
  assert.equal(router.route(CHAT_ATTACHMENT), 'external');
  assert.equal(router.route(FORM_SHORT), 'external');
  assert.deepEqual(calls.external, [DRIVE, CHAT_ROOM, CHAT_ATTACHMENT, FORM_SHORT]);
});

test('router without the Google collaborators: Meet still opens the call window and bad schemes are still dropped', () => {
  const { router, calls } = setup({ google: false });
  assert.equal(router.route(MEET), 'call-window');
  assert.equal(router.route('file:///x'), 'dropped');
  assert.deepEqual(calls.callWindow, [MEET]);
});

test('router without the Google collaborators: onWindowOpen still always denies and routes to the browser', () => {
  const { router, calls } = setup({ google: false });
  assert.deepEqual(router.onWindowOpen({ url: DRIVE }), { action: 'deny' });
  assert.deepEqual(calls.external, [DRIVE]);
});
