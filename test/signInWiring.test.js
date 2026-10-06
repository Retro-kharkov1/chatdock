'use strict';

// FR-19 sign-in mode: the wiring seams. docs/architecture/sign-in-flow.md sections 3a, 7 and the test map rows
// "Abort vs beforeunload" (the outcome), "Native title" (wiring half), "Wiring", plus the "Router" and "Tray"
// integration at the main-window boundary. RED until src/main/signInFlow.js (test/signInFlow.test.js) and the new
// src/main/signInWiring.js below exist, and index.js / tray.js use them.
//
// WHY A NEW MODULE (an ASSUMPTION the implementer may argue): the spec puts the wiring in index.js, which cannot run
// under `node --test`, yet the test map asks for OUTCOME tests ("after an abort the unload proceeds without a dialog",
// "page-title-updated is prevented while active", "closed disposes", "listeners registered on the main window only").
// Those are only testable if the glue is a module with injected collaborators, like linkRouter.js and quitGuard.js.
// So this file assumes src/main/signInWiring.js (no Electron import) and index.js reduced to calling it:
//
//   bindSignInFlow({ window, webContents, flow, router, allowedOrigins })
//     Registers on `webContents` (and `window` for 'closed'), reading the event DETAILS object
//     ({ url, isMainFrame, isSameDocument } on the event itself, Electron 44):
//       'will-navigate'         router.onWillNavigate(event, event.url ?? url, { allowedOrigins, allow: flow.allowNavigation })
//                               (index.js therefore registers NO will-navigate listener of its own: two would route twice)
//       'did-start-navigation'  flow.onStartNavigation(details.url, details)
//       'will-redirect'         flow.onWillRedirect(event, details.url, details)      (the redirect source;
//                               'did-redirect-navigation' is NOT listened to)
//       'did-navigate'          flow.onCommitted(url, { isMainFrame: true, isSameDocument: false })
//                               (Electron's did-navigate is main frame, not same-document, by definition)
//       'did-fail-load'         (event, code, desc, url, isMainFrame) -> flow.onLoadFailed({ isMainFrame, isSameDocument: false })
//       'page-title-updated'    event.preventDefault() ONLY while flow.isActive(); registered on the WINDOW (Electron: the
//                               BrowserWindow event "will prevent the native window's title from changing"; the
//                               webContents event of the same name is a notification only - found in a real run)
//       'will-prevent-unload'   event.preventDefault() ONLY while flow.isAborting(); otherwise nothing (the quit guard
//                               registered on the same contents keeps its own behaviour, whichever listener runs first)
//       window 'closed'         flow.dispose()      (hide / close do NOT end the mode: open question 1)
//   createBackToChat({ flow, showMainWindow }) -> () => void
//     flow.abort('user') (a no-op while the mode is off) THEN showMainWindow() - always, on or off.
//   createRefusedStepNotice({ showMessageBox, getMainWindow, onBackToChat, log }) -> () => void   (= notifyRefusedStep)
//     one NON-BLOCKING showMessageBox(parent | undefined, options); parent only when the main window is visible and
//     not minimized. Buttons ["Back to Chat", "Close"], defaultId 0, cancelId 1. Answer 0 -> onBackToChat(); anything
//     else (Close, Escape, a rejected box) -> nothing.
//   createTitleSetter({ window, webContents }) -> (title | null) => void
//     string -> window.setTitle(title); null -> window.setTitle(webContents.getTitle()) (restore); a destroyed window
//     is left alone.
//
// Tray and downloads halves: test/trayMenuSignIn.test.js, test/downloadsSignIn.test.js; router: test/linkRouterSignIn.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/pending');
const { makeEvent, settle, createFakeBrowserWindowClass, createDialogFake } = require('./helpers/electronFakes');
const H = require('./helpers/signInHarness');

const { createFlowHarness, MAIN, SUBFRAME, SAME_DOC, IDLE_MS, MAX_HOPS, ACCOUNTS_URL, IDP_URL, START_URL, CHAT_ORIGIN, SIGN_IN_ORIGIN, LINK_LIST_HOSTS, idp } = H;

const CHAT_URL = 'https://chat.google.com/';
const MEET = 'https://meet.google.com/abc-defg-hij';
const DOCS = 'https://docs.google.com/document/d/1/edit';

const SRC = path.join(__dirname, '..', 'src');
const readSrc = (...parts) => fs.readFileSync(path.join(SRC, ...parts), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

// ---------------------------------------------------------------------------------------------------------------
// harness: a fake main window + the REAL flow, router and quit guard
// ---------------------------------------------------------------------------------------------------------------

function setup({ guardFirst = true, bind = true } = {}) {
  const BrowserWindow = createFakeBrowserWindowClass();
  const win = new BrowserWindow({});
  const contents = win.webContents;
  const s = { win, contents, loadCount: 0, unload: [], calls: { callWindow: [], app: [], external: [], main: [], focus: 0, download: [] } };

  // Every START_URL load runs while the page objects to unloading, like a real beforeunload prompt.
  s.f = createFlowHarness({
    loadStartUrl: () => {
      s.loadCount += 1;
      s.unload.push(contents.objectToUnload().defaultPrevented);
    },
  });

  const meetLink = require('../src/main/meetLink');
  const googleLink = require('../src/main/googleLink');
  s.router = load('linkRouter.js').createLinkRouter({
    classifyLink: meetLink.classifyLink,
    isOpenableExternalScheme: meetLink.isOpenableExternalScheme,
    classifyGoogleLink: googleLink.classifyGoogleLink,
    classifyChatTarget: googleLink.classifyChatTarget,
    openCallWindow: (u) => s.calls.callWindow.push(u),
    openMainWindow: (u) => s.calls.main.push(u),
    focusMainWindow: () => { s.calls.focus += 1; },
    downloadInMainWindow: (u) => s.calls.download.push(u),
    openGoogleAppWindow: (u, o) => s.calls.app.push({ u, hop: Boolean(o && o.hop) }),
    openExternal: (u) => s.calls.external.push(u),
    log: () => {},
  });

  s.guard = load('quitGuard.js').createQuitGuard();
  if (guardFirst) s.guard.guardContents(contents);
  if (bind) {
    load('signInWiring.js').bindSignInFlow({
      window: win,
      webContents: contents,
      flow: s.f.flow,
      router: s.router,
      allowedOrigins: [CHAT_ORIGIN, SIGN_IN_ORIGIN],
    });
  }
  if (!guardFirst) s.guard.guardContents(contents);

  const details = (type, url, d) => makeEvent({ url, isMainFrame: d.isMainFrame, isSameDocument: d.isSameDocument });
  s.routed = () => s.calls.callWindow.length + s.calls.app.length + s.calls.external.length + s.calls.main.length + s.calls.focus + s.calls.download.length;
  /** will-navigate (details on the event AND the deprecated positional url, as Electron 44 still passes). */
  s.willNavigate = (url, d = MAIN) => {
    const e = details('will-navigate', url, d);
    contents.emit('will-navigate', e, url, d.isSameDocument, d.isMainFrame);
    return e;
  };
  /** did-start-navigation / will-redirect: ONLY the details object (the positional arguments are deprecated). */
  s.startNav = (url, d = MAIN) => {
    const e = details('did-start-navigation', url, d);
    contents.emit('did-start-navigation', e);
    return e;
  };
  s.willRedirect = (url, d = MAIN) => {
    const e = details('will-redirect', url, d);
    contents.emit('will-redirect', e);
    return e;
  };
  s.didNavigate = (url) => {
    contents.emit('did-navigate', makeEvent(), url, 200, 'OK');
  };
  s.failLoad = (isMainFrame = true) => {
    contents.emit('did-fail-load', makeEvent(), -3, 'ERR_ABORTED', 'https://x.example/', isMainFrame, 1, 1);
  };
  s.titleUpdated = () => {
    const e = makeEvent();
    // The window's event (what keeps the native title from following the page); the contents' own event is a notification.
    win.emit('page-title-updated', e, 'Some page title', true);
    return e;
  };
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// bindSignInFlow: what is registered, and where
// ---------------------------------------------------------------------------------------------------------------

test('bind: listeners are registered on the given contents (and the window\'s closed), and did-redirect-navigation is NOT used', () => {
  const s = setup();
  for (const type of ['will-navigate', 'did-start-navigation', 'will-redirect', 'did-navigate', 'did-fail-load', 'will-prevent-unload']) {
    assert.ok(s.contents.listenerCount(type) >= 1, type);
  }
  assert.equal(s.contents.listenerCount('did-redirect-navigation'), 0);
  assert.ok(s.win.listenerCount('closed') >= 1);
  // Real Electron 44 (verified in a real run): the event that stops the NATIVE title from following the page is the
  // BrowserWindow's `page-title-updated`; the webContents event of the same name is only a notification.
  assert.ok(s.win.listenerCount('page-title-updated') >= 1, 'page-title-updated is registered on the WINDOW');
  assert.equal(s.contents.listenerCount('page-title-updated'), 0, 'not on the contents (preventDefault there changes nothing)');
});

test('bind: it registers on the main window only - another window\'s contents gets nothing', () => {
  const BrowserWindow = createFakeBrowserWindowClass();
  const other = new BrowserWindow({});
  setup();
  for (const type of ['will-navigate', 'did-start-navigation', 'will-redirect', 'did-navigate', 'did-fail-load', 'page-title-updated', 'will-prevent-unload']) {
    assert.equal(other.webContents.listenerCount(type), 0, type);
  }
  assert.equal(other.listenerCount('page-title-updated'), 0);
});

// ---------------------------------------------------------------------------------------------------------------
// will-navigate through the real router
// ---------------------------------------------------------------------------------------------------------------

test('will-navigate (mode off): the fixed list passes, anything else is prevented and routed as today', () => {
  const s = setup();
  assert.equal(s.willNavigate('https://chat.google.com/room/AAAA').defaultPrevented, false);
  assert.equal(s.willNavigate(ACCOUNTS_URL).defaultPrevented, false);
  assert.equal(s.routed(), 0);
  assert.equal(s.willNavigate(IDP_URL).defaultPrevented, true);
  assert.deepEqual(s.calls.external, [IDP_URL]);
});

test('will-navigate (mode on): an acceptable https origin the page navigates to is allowed (not prevented, not routed)', () => {
  const s = setup();
  s.didNavigate(ACCOUNTS_URL);
  assert.equal(s.f.flow.isActive(), true);
  for (const url of ['https://login.idp.example/next', 'https://adfs/step', 'https://www.google.com/x', 'https://chat.google.com.evil.example/']) {
    assert.equal(s.willNavigate(url).defaultPrevented, false, url);
  }
  assert.equal(s.routed(), 0);
});

test('will-navigate (mode on): Meet reaches the router and opens the call window, not the main window', () => {
  const s = setup();
  s.didNavigate(ACCOUNTS_URL);
  assert.equal(s.willNavigate(MEET).defaultPrevented, true);
  assert.deepEqual(s.calls.callWindow, [MEET]);
  assert.equal(s.calls.external.length, 0);
});

for (const host of LINK_LIST_HOSTS) {
  test(`will-navigate (mode on): ${host} is refused by the mode and reaches the router (prevented, routed exactly once)`, () => {
    const s = setup();
    s.didNavigate(ACCOUNTS_URL);
    const e = s.willNavigate(`https://${host}/`);
    assert.equal(e.defaultPrevented, true);
    assert.equal(s.routed(), 1);
  });
}

test('will-navigate (mode on): a Google application link opens its app window, forms.gle hops, the rest go to the system browser', () => {
  const s = setup();
  s.didNavigate(ACCOUNTS_URL);
  s.willNavigate(DOCS);
  s.willNavigate('https://forms.gle/abc');
  s.willNavigate('https://drive.usercontent.google.com/download?id=1');
  s.willNavigate('https://x.googleusercontent.com/a');
  assert.deepEqual(s.calls.app, [{ u: DOCS, hop: false }, { u: 'https://forms.gle/abc', hop: true }]);
  assert.deepEqual(s.calls.external, ['https://drive.usercontent.google.com/download?id=1', 'https://x.googleusercontent.com/a']);
});

test('will-navigate (mode on): an http: link is prevented and opened in the system browser, never loaded in the window', () => {
  const s = setup();
  s.didNavigate(ACCOUNTS_URL);
  const e = s.willNavigate('http://login.example.com/');
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(s.calls.external, ['http://login.example.com/']);
});

test('will-navigate: reads the url from the event details when the positional argument is missing', () => {
  const s = setup();
  s.didNavigate(ACCOUNTS_URL);
  const e = makeEvent({ url: 'https://login.idp.example/', isMainFrame: true, isSameDocument: false });
  s.contents.emit('will-navigate', e);
  assert.equal(e.defaultPrevented, false);
  const bad = makeEvent({ url: 'http://login.idp.example/', isMainFrame: true, isSameDocument: false });
  s.contents.emit('will-navigate', bad);
  assert.equal(bad.defaultPrevented, true);
});

test('will-navigate: after Chat commits the window is back on the fixed list (an IdP navigation is routed again)', () => {
  const s = setup();
  s.didNavigate(ACCOUNTS_URL);
  s.didNavigate(CHAT_URL);
  assert.equal(s.f.flow.isActive(), false);
  assert.equal(s.willNavigate(IDP_URL).defaultPrevented, true);
  assert.deepEqual(s.calls.external, [IDP_URL]);
});

test('popups are unchanged: a window.open to an IdP https url is denied and goes to the system browser, in the mode or not', () => {
  const s = setup();
  assert.deepEqual(s.router.onWindowOpen({ url: IDP_URL }), { action: 'deny' });
  s.didNavigate(ACCOUNTS_URL);
  assert.deepEqual(s.router.onWindowOpen({ url: IDP_URL }), { action: 'deny' });
  assert.deepEqual(s.calls.external, [IDP_URL, IDP_URL]);
  assert.equal(s.f.flow.isActive(), true, 'a popup does not change the mode');
});

// ---------------------------------------------------------------------------------------------------------------
// entry / redirect / failure through the events
// ---------------------------------------------------------------------------------------------------------------

test('entry (a) via did-navigate on accounts.google.com; exit via did-navigate on Chat', () => {
  const s = setup();
  s.didNavigate(ACCOUNTS_URL);
  assert.equal(s.f.flow.isActive(), true);
  s.didNavigate(CHAT_URL);
  assert.equal(s.f.flow.isActive(), false);
  assert.equal(s.loadCount, 0);
});

test('entry (b) via events: did-start-navigation + will-redirect through accounts.google.com, then did-navigate on the IdP', () => {
  const s = setup();
  s.startNav(CHAT_URL);
  assert.equal(s.willRedirect(ACCOUNTS_URL).defaultPrevented, false);
  assert.equal(s.willRedirect(IDP_URL).defaultPrevented, false);
  s.didNavigate(IDP_URL);
  assert.equal(s.f.flow.isActive(), true);
});

test('entry (b) via events: the redirect hops are unchecked while the mode is off (unchanged), a Chat bounce changes nothing', () => {
  const s = setup();
  s.startNav(CHAT_URL);
  s.willRedirect(ACCOUNTS_URL);
  assert.equal(s.willRedirect('http://anything.example/').defaultPrevented, false);
  s.willRedirect(CHAT_URL);
  s.didNavigate(CHAT_URL);
  assert.equal(s.f.flow.isActive(), false);
});

test('entry (b) via events: a same-document or subframe did-start-navigation never sets the flag', () => {
  const s = setup();
  s.startNav(ACCOUNTS_URL, SAME_DOC);
  s.startNav(ACCOUNTS_URL, SUBFRAME);
  s.willRedirect(ACCOUNTS_URL, SUBFRAME);
  s.didNavigate(IDP_URL);
  assert.equal(s.f.flow.isActive(), false);
});

test('did-fail-load on the main frame clears the chain flag; a subframe failure does not', () => {
  const a = setup();
  a.startNav(ACCOUNTS_URL);
  a.failLoad(true);
  a.didNavigate(IDP_URL);
  assert.equal(a.f.flow.isActive(), false);

  const b = setup();
  b.startNav(ACCOUNTS_URL);
  b.failLoad(false);
  b.didNavigate(IDP_URL);
  assert.equal(b.f.flow.isActive(), true);
});

test('redirect (mode on): a refused redirect cancels the whole navigation, opens NOTHING in the browser, and the notice is asked once', () => {
  const s = setup();
  s.didNavigate(ACCOUNTS_URL);
  const first = s.willRedirect('http://evil.example/x');
  assert.equal(first.defaultPrevented, true);
  assert.equal(s.willRedirect(`https://${LINK_LIST_HOSTS[0]}/`).defaultPrevented, true);
  assert.equal(s.willRedirect(MEET).defaultPrevented, true);
  assert.equal(s.routed(), 0, 'cancelled, not routed to the browser, the call window or an app window');
  assert.equal(s.f.rec.notices, 1);
  assert.equal(s.f.flow.isActive(), true);
});

test('redirect (mode on): an acceptable redirect is allowed', () => {
  const s = setup();
  s.didNavigate(ACCOUNTS_URL);
  assert.equal(s.willRedirect('https://login.idp.example/next').defaultPrevented, false);
  assert.equal(s.f.rec.notices, 0);
});

test('redirect: a SUBFRAME will-redirect never cancels the page, mode on or off, and leaves the state alone', () => {
  const off = setup();
  assert.equal(off.willRedirect('http://evil.example/', SUBFRAME).defaultPrevented, false);
  const on = setup();
  on.didNavigate(ACCOUNTS_URL);
  assert.equal(on.willRedirect('http://evil.example/', SUBFRAME).defaultPrevented, false);
  assert.equal(on.willRedirect('http://evil.example/', SAME_DOC).defaultPrevented, false);
  assert.equal(on.f.rec.notices, 0);
  assert.equal(on.f.flow.isActive(), true);
});

test('hop cap through the events: the 41st cross-origin did-navigate returns the window to START_URL', () => {
  const s = setup();
  s.didNavigate(ACCOUNTS_URL);
  for (let i = 1; i <= MAX_HOPS; i += 1) s.didNavigate(idp(i));
  assert.equal(s.loadCount, 0);
  s.didNavigate(idp(MAX_HOPS + 1));
  assert.equal(s.loadCount, 1);
  assert.equal(s.f.flow.isActive(), false);
});

// ---------------------------------------------------------------------------------------------------------------
// abort vs beforeunload: the OUTCOME, whichever of the quit guard / the sign-in listener is registered first
// ---------------------------------------------------------------------------------------------------------------

for (const guardFirst of [true, false]) {
  const order = guardFirst ? 'quit guard registered first' : 'sign-in listener registered first';

  test(`beforeunload (${order}): an abort by Back to Chat overrides the page's prompt (the unload proceeds, no dialog)`, () => {
    const s = setup({ guardFirst });
    s.didNavigate(ACCOUNTS_URL);
    s.f.flow.abort('user');
    assert.deepEqual(s.unload, [true], 'will-prevent-unload was preventDefault()ed during the START_URL load');
  });

  test(`beforeunload (${order}): an idle / cap timeout abort overrides the page's prompt`, () => {
    const s = setup({ guardFirst });
    s.didNavigate(ACCOUNTS_URL);
    s.f.tick(IDLE_MS);
    assert.deepEqual(s.unload, [true]);
  });

  test(`beforeunload (${order}): a hop-cap abort overrides the page's prompt`, () => {
    const s = setup({ guardFirst });
    s.didNavigate(ACCOUNTS_URL);
    for (let i = 1; i <= MAX_HOPS + 1; i += 1) s.didNavigate(idp(i));
    assert.deepEqual(s.unload, [true]);
  });

  test(`beforeunload (${order}): with no abort and no quit nothing is prevented (the default dialog is left alone), mode on or off`, () => {
    const s = setup({ guardFirst });
    assert.equal(s.contents.objectToUnload().defaultPrevented, false);
    s.didNavigate(ACCOUNTS_URL);
    assert.equal(s.contents.objectToUnload().defaultPrevented, false);
    s.didNavigate(CHAT_URL);
    assert.equal(s.contents.objectToUnload().defaultPrevented, false);
  });

  test(`beforeunload (${order}): the existing quit behaviour is unchanged (a quit in progress still overrides)`, () => {
    const s = setup({ guardFirst });
    s.guard.onBeforeQuit();
    assert.equal(s.contents.objectToUnload().defaultPrevented, true);
  });

  test(`beforeunload (${order}): the override ends when Chat commits, on a load failure, and after the safety timer - not on another commit`, () => {
    const a = setup({ guardFirst });
    a.didNavigate(ACCOUNTS_URL);
    a.f.flow.abort('user');
    a.didNavigate('https://racing.page.example/');
    assert.equal(a.contents.objectToUnload().defaultPrevented, true, 'an unrelated commit mid-abort must not end it');
    a.didNavigate(CHAT_URL);
    assert.equal(a.contents.objectToUnload().defaultPrevented, false);

    const b = setup({ guardFirst });
    b.didNavigate(ACCOUNTS_URL);
    b.f.flow.abort('user');
    b.failLoad(true);
    assert.equal(b.contents.objectToUnload().defaultPrevented, false);

    const c = setup({ guardFirst });
    c.didNavigate(ACCOUNTS_URL);
    c.f.flow.abort('user');
    c.f.tick(H.SAFETY_MS);
    assert.equal(c.contents.objectToUnload().defaultPrevented, false);
  });
}

test('beforeunload: Back to Chat with the mode OFF overrides nothing', () => {
  const s = setup();
  s.f.flow.abort('user');
  assert.equal(s.contents.objectToUnload().defaultPrevented, false);
  assert.equal(s.loadCount, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// native title: page-title-updated is prevented only while the mode is on
// ---------------------------------------------------------------------------------------------------------------

test('title: page-title-updated is NOT prevented with the mode off (the page title is never touched)', () => {
  const s = setup();
  assert.equal(s.titleUpdated().defaultPrevented, false);
  assert.deepEqual(s.f.rec.titles, []);
});

test('title: page-title-updated is prevented while the mode is on and the window title is "Sign-in" site first on each commit', () => {
  const s = setup();
  s.didNavigate(ACCOUNTS_URL);
  assert.equal(s.titleUpdated().defaultPrevented, true);
  s.didNavigate('https://signin-verify.evil.example/');
  assert.equal(s.titleUpdated().defaultPrevented, true);
  assert.equal(s.f.lastTitle(), H.titleFor('evil.example', 'signin-verify.evil.example'));
});

test('title: on exit and on abort the window stops preventing and the title is restored (null)', () => {
  const exit = setup();
  exit.didNavigate(ACCOUNTS_URL);
  exit.didNavigate(CHAT_URL);
  assert.equal(exit.titleUpdated().defaultPrevented, false);
  assert.equal(exit.f.lastTitle(), null);

  const aborted = setup();
  aborted.didNavigate(ACCOUNTS_URL);
  aborted.f.flow.abort('user');
  assert.equal(aborted.titleUpdated().defaultPrevented, false);
  assert.equal(aborted.f.lastTitle(), null);
});

test('createTitleSetter: a string sets the native title; null restores it from the contents\' own title', () => {
  const calls = [];
  const set = load('signInWiring.js').createTitleSetter({
    window: { setTitle: (t) => calls.push(t), isDestroyed: () => false },
    webContents: { getTitle: () => 'Chat - Google' },
  });
  set(`Sign-in ${H.SEP_DOT} login.example`);
  set(null);
  assert.deepEqual(calls, [`Sign-in ${H.SEP_DOT} login.example`, 'Chat - Google']);
});

test('createTitleSetter: a destroyed window is left alone and nothing throws', () => {
  const calls = [];
  const set = load('signInWiring.js').createTitleSetter({
    window: { setTitle: (t) => calls.push(t), isDestroyed: () => true },
    webContents: { getTitle: () => 'x' },
  });
  assert.doesNotThrow(() => set('Sign-in'));
  assert.doesNotThrow(() => set(null));
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------------------------------------------
// window lifecycle: closed disposes; hide / close do not end the mode
// ---------------------------------------------------------------------------------------------------------------

test('closed: the main window being destroyed disposes the flow - timers cleared, nothing loaded, no abort', () => {
  const s = setup();
  s.didNavigate(ACCOUNTS_URL);
  s.win.destroy();
  s.f.tick(H.CAP_MS * 2);
  assert.equal(s.loadCount, 0);
  assert.equal(s.f.flow.isActive(), false);
  assert.equal(s.f.clock.pending(), 0);
});

test('closed: calls dispose() of the flow it was given exactly once (and no abort)', () => {
  const calls = [];
  const stub = new Proxy({}, { get: (_t, name) => (...args) => { calls.push([name, ...args.map((a) => typeof a)]); return false; } });
  const BrowserWindow = createFakeBrowserWindowClass();
  const win = new BrowserWindow({});
  load('signInWiring.js').bindSignInFlow({ window: win, webContents: win.webContents, flow: stub, router: { onWillNavigate() {} }, allowedOrigins: [] });
  calls.length = 0;
  win.destroy();
  assert.deepEqual(calls.map((c) => c[0]), ['dispose']);
});

test('hide / close (the X button) do NOT end the mode: a phone approval completes in the background (open question 1)', () => {
  const s = setup();
  s.didNavigate(ACCOUNTS_URL);
  s.win.hide();
  s.win.emit('hide');
  s.win.emit('close', makeEvent());
  assert.equal(s.f.flow.isActive(), true);
  assert.equal(s.loadCount, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// Back to Chat (tray entry action and the notice button)
// ---------------------------------------------------------------------------------------------------------------

test('Back to Chat (mode on): aborts with "user" first, THEN shows the main window', () => {
  const order = [];
  const back = load('signInWiring.js').createBackToChat({
    flow: { abort: (reason) => order.push(`abort:${reason}`) },
    showMainWindow: () => order.push('show'),
  });
  back();
  assert.deepEqual(order, ['abort:user', 'show']);
});

test('Back to Chat (real flow, mode on): loads START_URL once, the mode is off, the window is shown, the override applies', () => {
  const s = setup();
  let shown = 0;
  s.didNavigate(ACCOUNTS_URL);
  const back = load('signInWiring.js').createBackToChat({ flow: s.f.flow, showMainWindow: () => { shown += 1; } });
  back();
  assert.equal(s.loadCount, 1);
  assert.deepEqual(s.unload, [true]);
  assert.equal(s.f.flow.isActive(), false);
  assert.equal(shown, 1);
});

test('Back to Chat (mode OFF, a stale tray item or notice): loads nothing, changes nothing, but STILL shows and focuses the window', () => {
  const s = setup();
  let shown = 0;
  const back = load('signInWiring.js').createBackToChat({ flow: s.f.flow, showMainWindow: () => { shown += 1; } });
  back();
  assert.equal(s.loadCount, 0);
  assert.equal(s.f.flow.isAborting(), false);
  assert.deepEqual(s.f.rec.modes, []);
  assert.equal(shown, 1);
});

test('Back to Chat: a second click after the first is harmless (one load, the window is shown each time)', () => {
  const s = setup();
  let shown = 0;
  s.didNavigate(ACCOUNTS_URL);
  const back = load('signInWiring.js').createBackToChat({ flow: s.f.flow, showMainWindow: () => { shown += 1; } });
  back();
  back();
  assert.equal(s.loadCount, 1);
  assert.equal(shown, 2);
});

// ---------------------------------------------------------------------------------------------------------------
// refused-step notice (native message box, wording spec of section 3a)
// ---------------------------------------------------------------------------------------------------------------

const NOTICE_TITLE = "This sign-in step can't open in the app";
const NOTICE_DETAIL =
  'The page asked to continue somewhere the app does not open. You can go back to Chat and start the sign-in again, or close this message and keep using this page.';
const BACK = 'Back to Chat';
const CLOSE = 'Close';

function noticeSetup({ visible = true, minimized = false, rejects = false, throwsSync = false } = {}) {
  const BrowserWindow = createFakeBrowserWindowClass();
  const main = new BrowserWindow({});
  main.visible = visible;
  main.minimized = minimized;
  const dialog = createDialogFake();
  const state = { back: 0, logs: [] };
  const showMessageBox = rejects
    ? () => Promise.reject(new Error('dialog failed'))
    : throwsSync
      ? () => { throw new Error('dialog failed'); }
      : dialog.showMessageBox;
  const notify = load('signInWiring.js').createRefusedStepNotice({
    showMessageBox,
    getMainWindow: () => main,
    onBackToChat: () => { state.back += 1; },
    log: (...a) => state.logs.push(a),
  });
  return { notify, dialog, main, state, BrowserWindow };
}

test('notice: one native message box with the spec wording, buttons ["Back to Chat", "Close"], Back to Chat default, Close the Escape answer', () => {
  const n = noticeSetup();
  n.notify();
  assert.equal(n.dialog.calls.length, 1);
  const { options } = n.dialog.calls[0];
  const text = n.dialog.textOf(n.dialog.calls[0]);
  assert.ok(text.includes(NOTICE_TITLE), text);
  assert.ok(text.includes(NOTICE_DETAIL), text);
  assert.deepEqual(options.buttons, [BACK, CLOSE]);
  assert.equal(options.defaultId, 0);
  assert.equal(options.cancelId, 1);
});

test('notice: it is non-blocking - notify() returns at once, before the box is answered', () => {
  const n = noticeSetup();
  n.notify();
  assert.equal(n.dialog.open().length, 1, 'the box is still open and notify() already returned');
});

test('notice: attached to the main window when it is visible, unattached when hidden, minimized or gone', () => {
  const visible = noticeSetup();
  visible.notify();
  assert.equal(visible.dialog.calls[0].parent, visible.main);

  for (const opts of [{ visible: false }, { minimized: true }]) {
    const n = noticeSetup(opts);
    n.notify();
    assert.ok(n.dialog.calls[0].parent == null, JSON.stringify(opts));
  }

  const destroyed = noticeSetup();
  destroyed.main.destroy();
  assert.doesNotThrow(() => destroyed.notify());
  assert.ok(destroyed.dialog.calls[0].parent == null);
});

test('notice: "Back to Chat" runs the Back to Chat action once', async () => {
  const n = noticeSetup();
  n.notify();
  n.dialog.answer(n.dialog.calls[0], BACK);
  await settle();
  assert.equal(n.state.back, 1);
});

test('notice: "Close", the Escape answer and a closed box do nothing at all', async () => {
  const closeBtn = noticeSetup();
  closeBtn.notify();
  closeBtn.dialog.answer(closeBtn.dialog.calls[0], CLOSE);
  const escape = noticeSetup();
  escape.notify();
  escape.dialog.calls[0].resolve(escape.dialog.calls[0].options.cancelId);
  const closed = noticeSetup();
  closed.notify();
  closed.dialog.calls[0].resolve(undefined);
  await settle();
  assert.equal(closeBtn.state.back + escape.state.back + closed.state.back, 0);
});

test('notice: a box that fails to open or is rejected neither throws nor triggers Back to Chat', async () => {
  const rejected = noticeSetup({ rejects: true });
  assert.doesNotThrow(() => rejected.notify());
  await settle();
  assert.equal(rejected.state.back, 0);
  const sync = noticeSetup({ throwsSync: true });
  assert.doesNotThrow(() => sync.notify());
  assert.equal(sync.state.back, 0);
});

test('notice: it never shows an address - whatever a caller passes, the text carries no host or url', () => {
  const n = noticeSetup();
  n.notify('https://secret-host-xyz.example/secret-path-xyz');
  const text = n.dialog.textOf(n.dialog.calls[0]);
  assert.equal(/secret-host-xyz|secret-path-xyz|https?:/.test(text), false);
});

test('notice + Back to Chat (real flow): the button after the mode already ended is a no-op that still shows the window', async () => {
  const s = setup();
  let shown = 0;
  const back = load('signInWiring.js').createBackToChat({ flow: s.f.flow, showMainWindow: () => { shown += 1; } });
  const dialog = createDialogFake();
  const notify = load('signInWiring.js').createRefusedStepNotice({
    showMessageBox: dialog.showMessageBox,
    getMainWindow: () => s.win,
    onBackToChat: back,
    log: () => {},
  });
  s.didNavigate(ACCOUNTS_URL);
  notify();
  s.didNavigate(CHAT_URL); // the sign-in ended while the box was open
  dialog.answer(dialog.calls[0], BACK);
  await settle();
  assert.equal(s.loadCount, 0, 'a stale notice does not reload Chat');
  assert.equal(shown, 1);
});

// ---------------------------------------------------------------------------------------------------------------
// source-level seams (the bootstrap cannot run under node --test; same style as test/googleWiring.test.js)
// ---------------------------------------------------------------------------------------------------------------

test('index.js: requires signInFlow and signInWiring, builds ONE flow and binds it ONCE', () => {
  const code = stripComments(readSrc('main', 'index.js'));
  assert.match(code, /require\(['"]\.\/signInFlow['"]\)/);
  assert.match(code, /require\(['"]\.\/signInWiring['"]\)/);
  assert.equal((code.match(/createSignInFlow\(/g) || []).length, 1);
  assert.equal((code.match(/bindSignInFlow\(/g) || []).length, 1);
});

test('index.js: the flow gets its collaborators - the Chat origins, the refused lists imported (never literal), START_URL, the notice, the tray refresh', () => {
  const code = stripComments(readSrc('main', 'index.js'));
  assert.match(code, /chatOrigins:\s*NOTIFICATION_ORIGINS/);
  assert.match(code, /signInOrigin/);
  assert.match(code, /refusedHosts/);
  for (const name of ['LINK_LIST_HOSTS', 'ENTRY_HOP_HOST', 'USERCONTENT_HOST']) assert.match(code, new RegExp(name), name);
  assert.match(code, /refusedHostSuffixes[\s\S]{0,60}googleusercontent\.com/);
  assert.match(code, /startUrl/);
  assert.match(code, /loadStartUrl/);
  assert.match(code, /setWindowTitle/);
  assert.match(code, /notifyRefusedStep/);
  assert.match(code, /createRefusedStepNotice\(/);
  assert.match(code, /createTitleSetter\(/);
  assert.match(code, /createBackToChat\(/);
  assert.match(code, /onModeChange[\s\S]{0,300}refreshMenu/, 'the tray menu is rebuilt when the mode changes');
});

test('index.js: Back to Chat shows the window through the existing focusMainWindow (restore, show, focus)', () => {
  const code = stripComments(readSrc('main', 'index.js'));
  assert.match(code, /showMainWindow:\s*(?:\(\)\s*=>\s*)?focusMainWindow/);
});

test('index.js: will-navigate is registered by the sign-in wiring only (a second listener would route every link twice)', () => {
  assert.equal(/['"]will-navigate['"]/.test(stripComments(readSrc('main', 'index.js'))), false);
  const wiring = stripComments(readSrc('main', 'signInWiring.js'));
  assert.equal((wiring.match(/['"]will-navigate['"]/g) || []).length, 1);
  assert.equal(/did-redirect-navigation/.test(wiring), false, 'will-redirect is the redirect source');
});

test('index.js: the popup handler is unchanged and the quit guard is still registered on the main contents', () => {
  const code = stripComments(readSrc('main', 'index.js'));
  assert.match(code, /setWindowOpenHandler\(\(details\)\s*=>\s*linkRouter\.onWindowOpen\(details\)\)/);
  assert.match(code, /quitGuard\.guardContents\(mainWindow\.webContents\)/);
});

test('index.js: the download handler receives isMainDownloadBlocked, bound to the flow\'s isActive', () => {
  const code = stripComments(readSrc('main', 'index.js'));
  const block = /createDownloadHandler\(\{[\s\S]*?\n  \}\);/.exec(code);
  assert.ok(block, 'createDownloadHandler call found');
  assert.match(block[0], /isMainDownloadBlocked/);
  assert.match(code, /isActive/);
});

test('index.js: the tray gets the Back to Chat collaborators; the blink tick never rebuilds the menu', () => {
  const code = stripComments(readSrc('main', 'index.js'));
  const tray = /createAppTray\(\{[\s\S]*?\n    \}\);/.exec(code);
  assert.ok(tray, 'createAppTray call found');
  assert.match(tray[0], /isSignInActive/);
  assert.match(tray[0], /onBackToChat/);
  const tick = /onTick:[\s\S]*?\n      \},/.exec(code);
  assert.ok(tick, 'trayBlink onTick found');
  assert.equal(/refreshMenu|buildMenu/.test(tick[0]), false);
});

test('tray.js: accepts isSignInActive / onBackToChat and passes them to buildTrayMenuTemplate', () => {
  const code = stripComments(readSrc('main', 'tray.js'));
  assert.match(code, /isSignInActive/);
  assert.match(code, /onBackToChat/);
  const call = /buildTrayMenuTemplate\(\{[\s\S]*?\}\)/.exec(code);
  assert.ok(call);
  assert.match(call[0], /isSignInActive/);
  assert.match(call[0], /onBackToChat/);
});

test('signInWiring.js: no Electron import (collaborators are injected)', () => {
  assert.equal(/require\(['"]electron['"]\)/.test(stripComments(readSrc('main', 'signInWiring.js'))), false);
});

test('no other window type knows the sign-in mode (app windows, call window, picker, help, settings, hint)', () => {
  for (const file of ['googleAppWindow.js', 'callWindow.js', 'pickerWindow.js', 'helpWindow.js', 'settingsWindow.js', 'copyHint.js', 'quitGuard.js']) {
    const code = stripComments(readSrc('main', file));
    assert.equal(/signInFlow|signInWiring|bindSignInFlow|createSignInFlow/.test(code), false, file);
  }
});

test('the preload files and the service-worker preload know nothing of the mode (no new IPC channel, no new bridge)', () => {
  for (const file of ['preload.js', 'serviceWorkerPreload.js', 'settingsPreload.js', 'pickerPreload.js']) {
    const code = stripComments(readSrc('preload', file));
    assert.equal(/signInFlow|sign-in-mode|signin-mode|sign_in/i.test(code), false, file);
  }
});
