'use strict';

// FR-19 sign-in mode: the pure state machine and the two exported predicates.
// docs/architecture/sign-in-flow.md sections 1, 2, 7 and the test map (section 8) rows: isAcceptableIdpUrl,
// Refused set, State machine, Redirect gate, Abort vs beforeunload (the isAborting lifecycle), Native title.
// RED until src/main/signInFlow.js exists.
//
// MODULE API ASSUMED (exactly section 7; src/main/signInFlow.js, no Electron import):
//
//   isAcceptableIdpUrl(url) -> boolean   the six rules only (https, no userinfo, no port, no IPv4/IPv6 literal,
//                                        no localhost / *.localhost / *.local / trailing dot, no xn-- label);
//                                        NO refused-set rule; never throws, non-string / unparseable -> false.
//   isRefusedHost(url) -> boolean        the refused set only (LINK_LIST_HOSTS + ENTRY_HOP_HOST + USERCONTENT_HOST +
//                                        meet host exactly; googleusercontent.com and every subdomain). Standalone
//                                        export, so it reads the lists from googleLink.js / meetLink.js itself.
//   createSignInFlow({ chatOrigins, signInOrigin, refusedHosts, refusedHostSuffixes, startUrl, loadStartUrl,
//                      setWindowTitle, notifyRefusedStep, onModeChange, setTimer, clearTimer, log,
//                      idleMs = 10 min, capMs = 30 min, maxHops = 40 })
//     -> { isActive, isAborting, allowNavigation(url), onStartNavigation(url, details),
//          onWillRedirect(event, url, details), onCommitted(url, details), onLoadFailed(details),
//          abort(reason), dispose() }
//   details = { isMainFrame, isSameDocument }; a call with isMainFrame !== true or isSameDocument === true is ignored.
//
// ASSUMPTIONS beyond the letter of the spec (the implementer may argue any of them):
//   A1  the abort reason ('timeout' | 'hop-cap' | 'user') is observable through `log` (the spec says it is
//       "recorded"; log is the only sink in the contract). dispose records none.
//   A2  dispose() leaves the mode off (the section 1 table says "mode off"; the section 7 contract says "timers only").
//   A3  a throwing notifyRefusedStep never un-prevents the cancelled redirect.
//   A4  the title text is built with the exact separators U+00B7 (middle dot) and U+2014 (em dash).
//
// Wiring (listeners, tray, downloads, notice, index.js) is in test/signInWiring.test.js and friends.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/pending');
const { createManualClock, makeEvent } = require('./helpers/electronFakes');
const H = require('./helpers/signInHarness');

const {
  createFlowHarness,
  MAIN,
  SUBFRAME,
  SAME_DOC,
  IDLE_MS,
  CAP_MS,
  SAFETY_MS,
  MAX_HOPS,
  ACCOUNTS_URL,
  IDP_URL,
  START_URL,
  LINK_LIST_HOSTS,
  ENTRY_HOP_HOST,
  USERCONTENT_HOST,
  MEET_HOST,
  idp,
  titleFor,
} = H;

const CHAT_URL = 'https://chat.google.com/';
const DEV_ORIGIN = 'http://127.0.0.1:5555';
const acceptable = (url) => load('signInFlow.js').isAcceptableIdpUrl(url);
const refused = (url) => load('signInFlow.js').isRefusedHost(url);

// ================================================================================================================
// isAcceptableIdpUrl: the six rules, nothing else
// ================================================================================================================

const ACCEPTED = [
  'https://login.example.com/x',
  'https://LOGIN.EXAMPLE.COM/x',
  'https://login.example.com:443/x', // the default port normalises away
  'https://login.example.com/path?x=1#frag',
  'https://adfs/', // single-label intranet host is accepted
  'https://adfs.corp.example/',
  'https://www.google.com/',
  'https://chat.google.com.evil.example/', // an ordinary acceptable host (the gate, not this predicate, tells it from Chat)
  'https://axn--b.example/', // "xn--" must START a label
  'https://localhost.example.com/', // not "localhost", does not END in .localhost
  'https://notlocalhost.example/',
  'https://local.example/', // does not END in .local
  'https://1.example/', // numeric label, but not an IPv4 literal
  // proof that this predicate has no refused-set rule:
  'https://meet.google.com/abc-defg-hij',
  'https://docs.google.com/document/d/1/edit',
  'https://drive.usercontent.google.com/download?id=1',
  'https://x.googleusercontent.com/a',
  'https://chat.google.com/',
  'https://accounts.google.com/',
];

for (const url of ACCEPTED) {
  test(`isAcceptableIdpUrl: accepts ${url}`, () => {
    assert.equal(acceptable(url), true);
  });
}

const REJECTED = [
  // scheme
  'http://login.example.com/',
  'file:///C:/x.html',
  'data:text/html,hi',
  'javascript:alert(1)',
  'blob:https://login.example.com/uuid',
  'about:blank',
  'view-source:https://login.example.com/',
  'ftp://login.example.com/',
  'chrome://settings',
  'myapp://login.example.com/',
  // userinfo
  'https://chat.google.com@evil.example/',
  'https://user:pw@login.example.com/',
  'https://:pw@login.example.com/',
  'https://user@login.example.com/',
  // port
  'https://login.example.com:8443/',
  'https://login.example.com:444/',
  'https://login.example.com:80/',
  // IPv4 literals, plain and obfuscated (the parser normalises them first)
  'https://10.0.0.1/',
  'https://192.168.1.1/',
  'https://8.8.8.8/',
  'https://0x7f.1/',
  'https://2130706433/',
  'https://127.1/',
  'https://0177.0.0.1/',
  'https://0x7f000001/',
  'https://1.2.3/',
  // IPv6 literals
  'https://[::1]/',
  'https://[2001:db8::1]/',
  // loopback, mDNS, trailing dot
  'https://localhost/',
  'https://LOCALHOST/',
  'https://a.localhost/',
  'https://a.b.localhost/',
  'https://printer.local/',
  'https://x.y.local/',
  'https://host./',
  'https://login.example.com./',
  'https://adfs./',
  // punycode labels, in any position, any case, and a Unicode host the parser converts to punycode
  'https://xn--e1afmkfd.example/',
  'https://login.xn--p1ai/',
  'https://a.xn--b.example/',
  'https://XN--E1AFMKFD.example/',
  'https://\u043f\u0440\u0438\u043c\u0435\u0440.example/',
  // unparseable
  'not a url',
  '//login.example.com/',
  'https://',
  'https://a b/',
  '',
];

for (const url of REJECTED) {
  test(`isAcceptableIdpUrl: rejects ${JSON.stringify(url)}`, () => {
    assert.equal(acceptable(url), false);
  });
}

for (const [label, value] of [
  ['undefined', undefined],
  ['null', null],
  ['a number', 123],
  ['an object', {}],
  ['an array', ['https://login.example.com/']],
  ['a symbol', Symbol('x')],
  ['an object with a throwing toString', { toString() { throw new Error('boom'); } }],
  ['a URL object', new URL('https://login.example.com/')],
]) {
  test(`isAcceptableIdpUrl: ${label} is false and nothing throws`, () => {
    assert.doesNotThrow(() => acceptable(value));
    assert.equal(acceptable(value), false);
  });
}

// ================================================================================================================
// isRefusedHost: the refused set alone
// ================================================================================================================

for (const host of [...LINK_LIST_HOSTS, ENTRY_HOP_HOST, USERCONTENT_HOST, MEET_HOST]) {
  test(`isRefusedHost: ${host} is refused (list imported from googleLink.js / meetLink.js, so a new entry is covered)`, () => {
    assert.equal(refused(`https://${host}/x`), true);
    assert.equal(refused(`https://${host.toUpperCase()}/x`), true, 'host comparison is case-insensitive (parsed hostname)');
  });
}

for (const host of ['googleusercontent.com', 'x.googleusercontent.com', 'lh3.googleusercontent.com', 'a.b.googleusercontent.com']) {
  test(`isRefusedHost: ${host} (googleusercontent.com and every subdomain) is refused`, () => {
    assert.equal(refused(`https://${host}/a`), true);
  });
}

for (const url of [
  'https://www.google.com/',
  'https://chat.google.com/',
  'https://accounts.google.com/',
  'https://notgoogleusercontent.com/',
  'https://evilgoogleusercontent.com/',
  'https://googleusercontent.com.evil.example/',
  'https://docs.google.com.evil.example/',
  'https://meet.google.com.evil.example/',
  'https://x.docs.google.com/', // exact host match: only googleusercontent.com has suffix semantics
  'https://login.example.com/',
]) {
  test(`isRefusedHost: ${url} is NOT refused`, () => {
    assert.equal(refused(url), false);
  });
}

test('isRefusedHost: non-string and unparseable input is false and never throws', () => {
  for (const value of [undefined, null, 42, {}, 'not a url', '']) {
    assert.doesNotThrow(() => refused(value));
    assert.equal(refused(value), false);
  }
});

test('isRefusedHost does not know the six acceptability rules (neither predicate is defined in terms of the other)', () => {
  assert.equal(refused('http://docs.google.com/'), true, 'refused is about the host, whatever the scheme');
  assert.equal(acceptable('https://docs.google.com/'), true);
});

test('signInFlow.js: pure (no Electron import) and the refused set comes from googleLink.js / meetLink.js, never copied', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'signInFlow.js'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(/require\(['"]electron['"]\)/.test(code), false);
  assert.match(code, /require\(['"]\.\/googleLink['"]\)/);
  for (const host of [...LINK_LIST_HOSTS, ENTRY_HOP_HOST, USERCONTENT_HOST, MEET_HOST]) {
    assert.equal(code.includes(host), false, `${host} must not be a literal in signInFlow.js`);
  }
});

// ================================================================================================================
// allowNavigation: mode on, acceptable AND not refused
// ================================================================================================================

test('allowNavigation: false while the mode is off, even for an acceptable host', () => {
  const t = createFlowHarness();
  assert.equal(t.flow.isActive(), false);
  assert.equal(t.flow.allowNavigation('https://login.example.com/'), false);
});

test('allowNavigation: true for an acceptable, non-refused https url while the mode is on', () => {
  const t = createFlowHarness();
  t.enter();
  for (const url of ['https://login.example.com/x', 'https://adfs/', 'https://www.google.com/', 'https://chat.google.com.evil.example/']) {
    assert.equal(t.flow.allowNavigation(url), true, url);
  }
});

for (const host of [...LINK_LIST_HOSTS, ENTRY_HOP_HOST, USERCONTENT_HOST, MEET_HOST, 'x.googleusercontent.com', 'googleusercontent.com']) {
  test(`allowNavigation (mode on): ${host} is refused so a will-navigate there reaches the router`, () => {
    const t = createFlowHarness();
    t.enter();
    assert.equal(t.flow.allowNavigation(`https://${host}/`), false);
  });
}

test('allowNavigation (mode on): every unacceptable url is refused', () => {
  const t = createFlowHarness();
  t.enter();
  for (const url of REJECTED) assert.equal(t.flow.allowNavigation(url), false, url);
});

test('allowNavigation: non-string input is false and never throws', () => {
  const t = createFlowHarness();
  t.enter();
  for (const value of [undefined, null, 5, {}]) {
    assert.doesNotThrow(() => t.flow.allowNavigation(value));
    assert.equal(t.flow.allowNavigation(value), false);
  }
});

test('allowNavigation: honours the INJECTED refusedHosts / refusedHostSuffixes (the lists are config, not literals)', () => {
  const t = createFlowHarness({
    refusedHosts: [...H.REFUSED_HOSTS, 'blocked.example'],
    refusedHostSuffixes: ['blocked-suffix.example'],
  });
  t.enter();
  assert.equal(t.flow.allowNavigation('https://blocked.example/'), false);
  assert.equal(t.flow.allowNavigation('https://blocked-suffix.example/'), false);
  assert.equal(t.flow.allowNavigation('https://x.blocked-suffix.example/'), false);
  assert.equal(t.flow.allowNavigation('https://other.example/'), true);
});

// ================================================================================================================
// State machine: entry (a), entry (b), exit
// ================================================================================================================

test('state: the mode is off by default, not aborting, and no collaborator was called at construction', () => {
  const t = createFlowHarness();
  assert.equal(t.flow.isActive(), false);
  assert.equal(t.flow.isAborting(), false);
  assert.equal(t.rec.loads, 0);
  assert.deepEqual(t.rec.modes, []);
  assert.deepEqual(t.rec.titles, []);
});

test('entry (a): a main-frame commit on exactly accounts.google.com turns the mode on, once, and starts timers', () => {
  const t = createFlowHarness();
  t.commit(ACCOUNTS_URL);
  assert.equal(t.flow.isActive(), true);
  assert.deepEqual(t.rec.modes, [true]);
  assert.ok(t.clock.pending() >= 1, 'a timer is running');
});

test('entry (a): whatever the path on accounts.google.com', () => {
  for (const url of ['https://accounts.google.com/', 'https://accounts.google.com/o/saml2?idpid=1', 'https://accounts.google.com/ServiceLogin#x']) {
    const t = createFlowHarness();
    t.commit(url);
    assert.equal(t.flow.isActive(), true, url);
  }
});

test('entry (a): not on a will-navigate / did-start-navigation / will-redirect to accounts.google.com (only a commit)', () => {
  const t = createFlowHarness();
  t.start(ACCOUNTS_URL);
  t.redirect(ACCOUNTS_URL);
  assert.equal(t.flow.allowNavigation(ACCOUNTS_URL), false);
  assert.equal(t.flow.isActive(), false);
  assert.deepEqual(t.rec.modes, []);
});

for (const url of [
  'https://accounts.google.com.evil.example/',
  'https://evil.accounts.google.com/',
  'https://accounts.google.com:8443/',
  'http://accounts.google.com/',
  'https://user@accounts.google.com.evil.example/',
  'https://chat.google.com/',
  'https://www.google.com/',
]) {
  test(`entry (a): a commit on ${url} does not start the mode`, () => {
    const t = createFlowHarness();
    t.commit(url);
    assert.equal(t.flow.isActive(), false);
  });
}

test('entry (a): a subframe or same-document commit on accounts.google.com never starts the mode', () => {
  const t = createFlowHarness();
  t.commit(ACCOUNTS_URL, SUBFRAME);
  t.commit(ACCOUNTS_URL, SAME_DOC);
  t.flow.onCommitted(ACCOUNTS_URL, undefined); // (the harness default would substitute MAIN)
  t.flow.onCommitted(ACCOUNTS_URL, {});
  assert.equal(t.flow.isActive(), false);
});

test('details: only isMainFrame === true is required; isSameDocument undefined is treated as not same-document', () => {
  const t = createFlowHarness();
  t.commit(ACCOUNTS_URL, { isMainFrame: true });
  assert.equal(t.flow.isActive(), true);
});

// ---- entry (b): chain-via-sign-in ----

test('entry (b): did-start-navigation to accounts.google.com, then a commit on an IdP origin, turns the mode on', () => {
  const t = createFlowHarness();
  t.start(ACCOUNTS_URL);
  assert.equal(t.flow.isActive(), false, 'start alone changes nothing');
  t.commit(IDP_URL);
  assert.equal(t.flow.isActive(), true);
  assert.deepEqual(t.rec.modes, [true]);
});

test('entry (b): a will-redirect to accounts.google.com within a navigation, then an IdP commit, turns the mode on', () => {
  const t = createFlowHarness();
  t.start(CHAT_URL);
  t.redirect(ACCOUNTS_URL);
  assert.equal(t.flow.isActive(), false, 'redirect alone changes nothing');
  t.commit(IDP_URL);
  assert.equal(t.flow.isActive(), true);
});

test('entry (b): while the mode is off the redirect hops themselves are not cancelled', () => {
  const t = createFlowHarness();
  t.start(CHAT_URL);
  assert.equal(t.redirect(ACCOUNTS_URL).defaultPrevented, false);
  assert.equal(t.redirect(IDP_URL).defaultPrevented, false);
  assert.equal(t.redirect('http://anything.example/').defaultPrevented, false);
});

test('entry (b): a chain that passed through accounts.google.com and ends on Chat does not start the mode (session refresh bounce)', () => {
  const t = createFlowHarness();
  t.start(CHAT_URL);
  t.redirect(ACCOUNTS_URL);
  t.redirect(CHAT_URL);
  t.commit(CHAT_URL);
  assert.equal(t.flow.isActive(), false);
  assert.deepEqual(t.rec.modes, []);
});

test('entry (b): the flag is consumed by the commit that uses it - a later IdP commit with no new chain does not start the mode', () => {
  const t = createFlowHarness();
  t.start(ACCOUNTS_URL);
  t.commit(CHAT_URL); // consumes the flag without entry
  t.commit(IDP_URL);
  assert.equal(t.flow.isActive(), false);
});

test('entry (b): the flag is consumed even by a commit that cannot start the mode (refused / unacceptable landing)', () => {
  for (const landing of ['https://docs.google.com/', 'http://login.example.com/', 'https://login.example.com:8443/', 'https://xn--e1afmkfd.example/', 'https://localhost/']) {
    const t = createFlowHarness();
    t.start(ACCOUNTS_URL);
    t.commit(landing);
    assert.equal(t.flow.isActive(), false, landing);
    t.commit(IDP_URL);
    assert.equal(t.flow.isActive(), false, `flag was consumed by ${landing}`);
  }
});

test('entry (b): a chain through a non-Google origin does not start the mode', () => {
  const t = createFlowHarness();
  t.start(CHAT_URL);
  t.redirect('https://some.other.example/');
  t.commit(IDP_URL);
  assert.equal(t.flow.isActive(), false);
});

test('entry (b): lookalikes of accounts.google.com never set the flag', () => {
  for (const lookalike of ['https://accounts.google.com.evil.example/', 'http://accounts.google.com/', 'https://accounts.google.com:8443/', 'https://x.accounts.google.com/']) {
    const t = createFlowHarness();
    t.start(lookalike);
    t.commit(IDP_URL);
    assert.equal(t.flow.isActive(), false, lookalike);
  }
});

test('chain-flag order: did-start-navigation CLEARS then sets - a flag from an abandoned navigation does not leak into the next', () => {
  const t = createFlowHarness();
  t.start(ACCOUNTS_URL); // navigation A (abandoned: never commits)
  t.start('https://elsewhere.example/'); // navigation B, not on accounts.google.com
  t.commit(IDP_URL);
  assert.equal(t.flow.isActive(), false);
});

test('chain-flag order: did-start-navigation to accounts.google.com sets the flag again after the clear', () => {
  const t = createFlowHarness();
  t.start(ACCOUNTS_URL);
  t.start(ACCOUNTS_URL);
  t.commit(IDP_URL);
  assert.equal(t.flow.isActive(), true);
});

test('chain-flag order: a later will-redirect only SETS the flag, it never clears it', () => {
  const t = createFlowHarness();
  t.start(ACCOUNTS_URL);
  t.redirect('https://elsewhere.example/'); // not accounts: must not clear
  t.commit(IDP_URL);
  assert.equal(t.flow.isActive(), true);
});

test('chain-flag order: start(chat) -> redirect(accounts) -> redirect(idp) -> commit(idp) starts the mode', () => {
  const t = createFlowHarness();
  t.start(CHAT_URL);
  t.redirect(ACCOUNTS_URL);
  t.redirect(IDP_URL);
  t.commit(IDP_URL);
  assert.equal(t.flow.isActive(), true);
});

test('chain flag: a main-frame load failure clears it (a failed or cancelled chain does not start the mode)', () => {
  const t = createFlowHarness();
  t.start(ACCOUNTS_URL);
  t.fail();
  t.commit(IDP_URL);
  assert.equal(t.flow.isActive(), false);
});

test('chain flag: a SUBFRAME load failure does not clear it', () => {
  const t = createFlowHarness();
  t.start(ACCOUNTS_URL);
  t.fail(SUBFRAME);
  t.commit(IDP_URL);
  assert.equal(t.flow.isActive(), true);
});

test('chain flag: subframe and same-document start / redirect neither set nor clear it', () => {
  const t = createFlowHarness();
  t.start(ACCOUNTS_URL, SUBFRAME);
  t.start(ACCOUNTS_URL, SAME_DOC);
  t.redirect(ACCOUNTS_URL, SUBFRAME);
  t.redirect(ACCOUNTS_URL, SAME_DOC);
  t.commit(IDP_URL);
  assert.equal(t.flow.isActive(), false, 'nothing set it');

  const u = createFlowHarness();
  u.start(ACCOUNTS_URL);
  u.start('https://elsewhere.example/', SUBFRAME); // must not clear
  u.start('https://elsewhere.example/', SAME_DOC); // must not clear
  u.commit(IDP_URL);
  assert.equal(u.flow.isActive(), true, 'nothing cleared it');
});

test('chain flag: not consulted by a commit that is itself a subframe / same-document commit', () => {
  const t = createFlowHarness();
  t.start(ACCOUNTS_URL);
  t.commit(IDP_URL, SUBFRAME);
  t.commit(IDP_URL, SAME_DOC);
  assert.equal(t.flow.isActive(), false);
  t.commit(IDP_URL); // the real commit still finds the flag
  assert.equal(t.flow.isActive(), true);
});

test('entry (b) is on commit, never on will-redirect: a navigation that is cancelled cannot flip the mode', () => {
  const t = createFlowHarness();
  t.start(CHAT_URL);
  t.redirect(ACCOUNTS_URL);
  t.redirect(IDP_URL);
  assert.equal(t.flow.isActive(), false);
  assert.deepEqual(t.rec.modes, []);
});

test('did-redirect-navigation is not the redirect source: the factory has no handler for it', () => {
  const t = createFlowHarness();
  assert.equal(typeof t.flow.onRedirectNavigation, 'undefined');
  assert.equal(typeof t.flow.onDidRedirectNavigation, 'undefined');
});

test('session-refresh bounce that commits on accounts.google.com turns the mode on and the Chat commit turns it off', () => {
  const t = createFlowHarness();
  t.start(ACCOUNTS_URL);
  t.commit(ACCOUNTS_URL);
  assert.equal(t.flow.isActive(), true);
  t.commit(CHAT_URL);
  assert.equal(t.flow.isActive(), false);
  assert.deepEqual(t.rec.modes, [true, false]);
  assert.equal(t.rec.loads, 0, 'exit is not an abort: nothing is loaded');
});

// ---- exit ----

test('exit: a commit on the exact Chat origin ends the mode - no load, timers cleared, onModeChange(false), title restored', () => {
  const t = createFlowHarness();
  t.enter();
  t.commit(IDP_URL);
  t.commit(CHAT_URL);
  assert.equal(t.flow.isActive(), false);
  assert.equal(t.rec.loads, 0);
  assert.equal(t.flow.isAborting(), false, 'exit is not an abort');
  assert.deepEqual(t.rec.modes, [true, false]);
  assert.equal(t.lastTitle(), null);
  assert.equal(t.clock.pending(), 0, 'every timer was cleared');
});

test('exit: a lookalike or non-exact Chat origin does not exit (comparison is on the parsed origin)', () => {
  for (const url of [
    'https://chat.google.com.evil.example/',
    'https://chat.google.com@evil.example/',
    'https://chat.google.com:8443/',
    'http://chat.google.com/',
    'https://notchat.google.com/',
    'https://evil.example/https://chat.google.com/',
    'https://evil.example/?next=https://chat.google.com/',
  ]) {
    const t = createFlowHarness();
    t.enter();
    t.commit(url);
    assert.equal(t.flow.isActive(), true, url);
  }
});

test('exit: the dev loopback origin exits when it is one of the injected chatOrigins', () => {
  const t = createFlowHarness({ chatOrigins: ['https://chat.google.com', DEV_ORIGIN] });
  t.enter();
  t.commit(`${DEV_ORIGIN}/harness`);
  assert.equal(t.flow.isActive(), false);
});

test('exit: a subframe or same-document commit on Chat does not exit', () => {
  const t = createFlowHarness();
  t.enter();
  t.commit(CHAT_URL, SUBFRAME);
  t.commit(CHAT_URL, SAME_DOC);
  assert.equal(t.flow.isActive(), true);
});

test('exit: with the mode off a commit on Chat is a no-op (no mode change, no title, no load)', () => {
  const t = createFlowHarness();
  t.commit(CHAT_URL);
  assert.deepEqual(t.rec.modes, []);
  assert.deepEqual(t.rec.titles, []);
  assert.equal(t.rec.loads, 0);
});

test('re-entry after exit starts with a fresh hop counter', () => {
  const t = createFlowHarness();
  t.enter();
  for (let i = 1; i <= 30; i += 1) t.commit(idp(i));
  t.commit(CHAT_URL);
  t.enter();
  for (let i = 1; i <= MAX_HOPS; i += 1) t.commit(idp(i));
  assert.equal(t.rec.loads, 0, '30 + 40 would exceed the cap if the counter carried over');
  t.commit(idp(MAX_HOPS + 1));
  assert.equal(t.rec.loads, 1);
});

test('re-entry after exit starts with a fresh hard cap (30 minutes from ITS entry, not from the first sign-in)', () => {
  const t = createFlowHarness();
  t.enter();
  t.tick(9 * 60 * 1000);
  t.commit(idp(1));
  t.tick(9 * 60 * 1000);
  t.commit(idp(2));
  t.tick(7 * 60 * 1000); // t = 25 min
  t.commit(CHAT_URL);
  t.enter(); // new sign-in at t = 25 min
  for (let i = 0; i < 3; i += 1) {
    t.tick(9 * 60 * 1000);
    t.commit(`https://login.idp.example/step${i}`); // keeps the idle timer fresh
  }
  t.tick(CAP_MS - 27 * 60 * 1000 - 1); // 29:59.999 after the new entry
  assert.equal(t.rec.loads, 0, 'the first sign-in cap (already past) does not carry over');
  t.tick(1);
  assert.equal(t.rec.loads, 1);
});

// ================================================================================================================
// Timers: idle 10 min, cap 30 min
// ================================================================================================================

test('idle timer: no main-frame commit for 10 minutes aborts with timeout and loads START_URL once', () => {
  const t = createFlowHarness();
  t.enter();
  t.tick(IDLE_MS - 1);
  assert.equal(t.rec.loads, 0);
  assert.equal(t.flow.isActive(), true);
  t.tick(1);
  assert.equal(t.rec.loads, 1);
  assert.equal(t.flow.isActive(), false);
  assert.deepEqual(t.rec.modes, [true, false]);
  assert.equal(t.lastTitle(), null);
  assert.match(t.logged(), /timeout/, 'A1');
});

test('idle timer: every main-frame commit resets it', () => {
  const t = createFlowHarness();
  t.enter();
  t.tick(IDLE_MS - 1);
  t.commit(IDP_URL);
  t.tick(IDLE_MS - 1);
  assert.equal(t.rec.loads, 0);
  t.commit('https://login.idp.example/step2'); // same origin: still resets
  t.tick(IDLE_MS - 1);
  assert.equal(t.rec.loads, 0);
  t.tick(1);
  assert.equal(t.rec.loads, 1);
});

test('idle timer: a subframe or same-document commit does not reset it', () => {
  const t = createFlowHarness();
  t.enter();
  t.tick(IDLE_MS - 1);
  t.commit(IDP_URL, SUBFRAME);
  t.commit(IDP_URL, SAME_DOC);
  t.tick(1);
  assert.equal(t.rec.loads, 1);
});

test('hard cap: 30 minutes after entry aborts with timeout even if commits keep resetting the idle timer', () => {
  const t = createFlowHarness();
  t.enter();
  for (let i = 0; i < 3; i += 1) {
    t.tick(9 * 60 * 1000);
    t.commit('https://login.idp.example/step' + i);
  }
  t.tick(3 * 60 * 1000 - 1); // 29:59.999
  assert.equal(t.rec.loads, 0);
  t.tick(1);
  assert.equal(t.rec.loads, 1);
  assert.match(t.logged(), /timeout/, 'A1');
});

test('timers: both limits firing in sequence call loadStartUrl once (the abort is the single path)', () => {
  const t = createFlowHarness();
  t.enter();
  t.tick(CAP_MS + IDLE_MS);
  assert.equal(t.rec.loads, 1);
  assert.deepEqual(t.rec.modes, [true, false]);
});

test('timers: an exit clears them - nothing fires later', () => {
  const t = createFlowHarness();
  t.enter();
  t.commit(CHAT_URL);
  t.tick(CAP_MS * 2);
  assert.equal(t.rec.loads, 0);
});

test('timers: every timer the factory creates is unref()ed so it never delays quit (idle, cap and the abort safety timer)', () => {
  const t = createFlowHarness();
  t.enter();
  t.commit(IDP_URL);
  t.flow.abort('user');
  assert.ok(t.rec.timers.length >= 3, 'idle, cap and safety timers were created');
  for (const handle of t.rec.timers) assert.equal(handle.unrefd, true);
});

test('timers: an injected setTimer that returns a plain number (no unref) works', () => {
  const clock = createManualClock();
  const t = createFlowHarness({
    setTimer: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimer: (id) => clock.clearTimeout(id),
  });
  assert.doesNotThrow(() => t.enter());
  clock.tick(IDLE_MS);
  assert.equal(t.rec.loads, 1);
});

// ================================================================================================================
// Hop cap: more than 40 CROSS-ORIGIN commits since entry
// ================================================================================================================

test('hop cap: 40 cross-origin commits do not abort, the 41st does (loads START_URL once, reason hop-cap)', () => {
  const t = createFlowHarness();
  t.enter(); // baseline origin accounts.google.com, counter 0
  for (let i = 1; i <= MAX_HOPS; i += 1) t.commit(idp(i));
  assert.equal(t.rec.loads, 0);
  assert.equal(t.flow.isActive(), true);
  t.commit(idp(MAX_HOPS + 1));
  assert.equal(t.rec.loads, 1);
  assert.equal(t.flow.isActive(), false);
  assert.match(t.logged(), /hop-cap/, 'A1');
});

test('hop cap counts only cross-origin commits: sixty same-origin commits never abort', () => {
  const t = createFlowHarness();
  t.enter();
  t.commit(idp(1));
  for (let i = 0; i < 60; i += 1) t.commit(`https://idp1.example/step${i}`);
  assert.equal(t.rec.loads, 0);
  assert.equal(t.flow.isActive(), true);
});

test('hop cap: staying on accounts.google.com across many commits does not count (origin unchanged)', () => {
  const t = createFlowHarness();
  t.enter();
  for (let i = 0; i < 60; i += 1) t.commit(`https://accounts.google.com/v3/signin/step${i}`);
  assert.equal(t.rec.loads, 0);
});

test('hop cap: going back to a previously visited origin counts again (a hop is a change from the previous commit)', () => {
  const t = createFlowHarness();
  t.enter();
  for (let i = 0; i < MAX_HOPS; i += 1) t.commit(i % 2 === 0 ? 'https://a.example/' : 'https://b.example/');
  assert.equal(t.rec.loads, 0, '40 alternating commits = 40 hops');
  t.commit('https://a.example/'); // the 40th commit was on b: this is hop 41
  assert.equal(t.rec.loads, 1);
});

test('hop cap: the entry commit sets the baseline and does not count (entry (b), baseline is the IdP origin)', () => {
  const t = createFlowHarness();
  t.start(ACCOUNTS_URL);
  t.commit(idp(0)); // entry
  for (let i = 1; i <= MAX_HOPS; i += 1) t.commit(idp(i));
  assert.equal(t.rec.loads, 0);
  t.commit(idp(MAX_HOPS + 1));
  assert.equal(t.rec.loads, 1);
});

test('hop cap: subframe and same-document commits are never counted', () => {
  const t = createFlowHarness();
  t.enter();
  for (let i = 1; i <= 80; i += 1) {
    t.commit(idp(i), SUBFRAME);
    t.commit(idp(i), SAME_DOC);
  }
  assert.equal(t.rec.loads, 0);
});

test('hop cap: a Chat commit after 40 hops is a normal exit, not an abort', () => {
  const t = createFlowHarness();
  t.enter();
  for (let i = 1; i <= MAX_HOPS; i += 1) t.commit(idp(i));
  t.commit(CHAT_URL);
  assert.equal(t.flow.isActive(), false);
  assert.equal(t.rec.loads, 0);
});

test('hop cap: after the abort further commits neither load again nor re-enter on an IdP origin', () => {
  const t = createFlowHarness();
  t.enter();
  for (let i = 1; i <= MAX_HOPS + 1; i += 1) t.commit(idp(i));
  t.commit(idp(99));
  t.commit(idp(100));
  assert.equal(t.rec.loads, 1);
  assert.equal(t.flow.isActive(), false);
});

test('hop cap: the limit is injectable (maxHops)', () => {
  const t = createFlowHarness({ maxHops: 2 });
  t.enter();
  t.commit(idp(1));
  t.commit(idp(2));
  assert.equal(t.rec.loads, 0);
  t.commit(idp(3));
  assert.equal(t.rec.loads, 1);
});

// ================================================================================================================
// abort / dispose
// ================================================================================================================

test('abort(user): loads START_URL once, turns the mode off, notifies, restores the title, clears the limit timers', () => {
  const t = createFlowHarness();
  t.enter();
  t.commit(IDP_URL);
  t.flow.abort('user');
  assert.equal(t.rec.loads, 1);
  assert.equal(t.flow.isActive(), false);
  assert.deepEqual(t.rec.modes, [true, false]);
  assert.equal(t.lastTitle(), null);
  assert.match(t.logged(), /user/, 'A1');
  t.tick(CAP_MS * 2);
  assert.equal(t.rec.loads, 1, 'the idle and cap timers were cleared');
});

test('abort is idempotent: a second call, or a limit firing after it, loads nothing more', () => {
  const t = createFlowHarness();
  t.enter();
  t.flow.abort('user');
  t.flow.abort('user');
  t.flow.abort('timeout');
  t.flow.abort('hop-cap');
  t.tick(CAP_MS * 2);
  assert.equal(t.rec.loads, 1);
  assert.deepEqual(t.rec.modes, [true, false]);
});

test('abort with the mode off is a no-op: nothing loaded, nothing notified, not aborting, no title change', () => {
  for (const reason of ['user', 'timeout', 'hop-cap']) {
    const t = createFlowHarness();
    t.flow.abort(reason);
    assert.equal(t.rec.loads, 0, reason);
    assert.deepEqual(t.rec.modes, [], reason);
    assert.deepEqual(t.rec.titles, [], reason);
    assert.equal(t.flow.isAborting(), false, reason);
  }
});

test('abort with the mode off after an exit is a no-op too (a stale notice or tray item)', () => {
  const t = createFlowHarness();
  t.enter();
  t.commit(CHAT_URL);
  t.flow.abort('user');
  assert.equal(t.rec.loads, 0);
  assert.equal(t.flow.isAborting(), false);
});

test('abort sets isAborting() immediately BEFORE loadStartUrl() runs (for every reason)', () => {
  for (const abortIt of [
    (t) => t.flow.abort('user'),
    (t) => t.tick(IDLE_MS),
    (t) => { for (let i = 1; i <= MAX_HOPS + 1; i += 1) t.commit(idp(i)); },
  ]) {
    const t = createFlowHarness();
    t.enter();
    abortIt(t);
    assert.deepEqual(t.rec.abortingDuringLoad, [true]);
    assert.equal(t.flow.isAborting(), true);
  }
});

test('dispose: clears the timers, loads nothing, records no abort reason (a destroyed window or a quit is not an abort)', () => {
  const t = createFlowHarness();
  t.enter();
  t.flow.dispose();
  t.tick(CAP_MS * 2);
  assert.equal(t.rec.loads, 0);
  assert.equal(t.clock.pending(), 0);
  assert.doesNotMatch(t.logged(), /timeout|hop-cap|abort/i, 'A1');
  assert.equal(t.flow.isActive(), false, 'A2');
});

test('dispose: with the mode off, and called twice, is harmless', () => {
  const t = createFlowHarness();
  assert.doesNotThrow(() => t.flow.dispose());
  t.enter();
  assert.doesNotThrow(() => t.flow.dispose());
  assert.doesNotThrow(() => t.flow.dispose());
  assert.equal(t.rec.loads, 0);
});

test('dispose: a pending abort-safety timer is cleared too (no timer survives the window)', () => {
  const t = createFlowHarness();
  t.enter();
  t.flow.abort('user');
  t.flow.dispose();
  assert.equal(t.clock.pending(), 0);
});

// ================================================================================================================
// Redirect gate
// ================================================================================================================

const BAD_REDIRECTS = [
  'http://login.example.com/',
  'file:///C:/x.html',
  'data:text/html,hi',
  'javascript:alert(1)',
  'https://user@login.example.com/',
  'https://chat.google.com@evil.example/',
  'https://login.example.com:8443/',
  'https://10.0.0.1/',
  'https://0x7f.1/',
  'https://2130706433/',
  'https://[::1]/',
  'https://localhost/',
  'https://a.localhost/',
  'https://printer.local/',
  'https://host./',
  'https://xn--e1afmkfd.example/',
  'not a url',
  ...[...LINK_LIST_HOSTS, ENTRY_HOP_HOST, USERCONTENT_HOST, MEET_HOST, 'x.googleusercontent.com', 'googleusercontent.com'].map((h) => `https://${h}/x`),
];

for (const url of BAD_REDIRECTS) {
  test(`redirect gate (mode on): a main-frame will-redirect to ${JSON.stringify(url)} is cancelled and the notice is asked for`, () => {
    const t = createFlowHarness();
    t.enter();
    const event = t.redirect(url);
    assert.equal(event.defaultPrevented, true);
    assert.equal(t.rec.notices, 1);
    assert.equal(t.flow.isActive(), true, 'a cancelled redirect does not end the mode');
  });

  test(`redirect gate (mode off): a main-frame will-redirect to ${JSON.stringify(url)} is NOT checked (unchanged behaviour)`, () => {
    const t = createFlowHarness();
    const event = t.redirect(url);
    assert.equal(event.defaultPrevented, false);
    assert.equal(t.rec.notices, 0);
  });
}

for (const url of ['https://login.example.com/', 'https://adfs/', 'https://www.google.com/', 'https://chat.google.com/', 'https://accounts.google.com/x', 'https://login.idp.example/saml?x=1']) {
  test(`redirect gate (mode on): a will-redirect to the acceptable ${url} is allowed and shows no notice`, () => {
    const t = createFlowHarness();
    t.enter();
    const event = t.redirect(url);
    assert.equal(event.defaultPrevented, false);
    assert.equal(t.rec.notices, 0);
  });
}

for (const [label, details] of [['a subframe', SUBFRAME], ['a same-document navigation', SAME_DOC]]) {
  test(`redirect gate: ${label} will-redirect never cancels, allows or counts anything, mode on`, () => {
    const t = createFlowHarness();
    t.enter();
    for (const url of ['http://evil.example/', 'https://docs.google.com/', 'https://login.example.com/']) {
      assert.equal(t.redirect(url, details).defaultPrevented, false, url);
    }
    assert.equal(t.rec.notices, 0);
    assert.equal(t.flow.isActive(), true);
    for (let i = 1; i <= 80; i += 1) t.redirect(idp(i), details);
    assert.equal(t.rec.loads, 0, 'not counted as hops');
  });

  test(`redirect gate: ${label} will-redirect never cancels, mode off`, () => {
    const t = createFlowHarness();
    assert.equal(t.redirect('http://evil.example/', details).defaultPrevented, false);
    assert.equal(t.rec.notices, 0);
  });
}

test('redirect gate: a will-redirect without details is ignored (fail safe: not a main-frame event)', () => {
  const t = createFlowHarness();
  t.enter();
  const event = makeEvent();
  t.flow.onWillRedirect(event, 'http://evil.example/', undefined);
  assert.equal(event.defaultPrevented, false);
  assert.equal(t.rec.notices, 0);
});

test('refused-step notice: the first cancelled redirect of a sign-in asks for it once, a second does not', () => {
  const t = createFlowHarness();
  t.enter();
  t.redirect('http://evil.example/');
  assert.equal(t.rec.notices, 1);
  const second = t.redirect('https://docs.google.com/');
  assert.equal(second.defaultPrevented, true, 'still cancelled');
  assert.equal(t.rec.notices, 1, 'but no second notice in the same sign-in');
});

test('refused-step notice: a new sign-in (after exit, or after an abort) asks for it again', () => {
  const t = createFlowHarness();
  t.enter();
  t.redirect('http://evil.example/');
  t.commit(CHAT_URL);
  t.enter();
  t.redirect('http://evil.example/');
  assert.equal(t.rec.notices, 2);
  t.flow.abort('user');
  t.enter();
  t.redirect('http://evil.example/');
  assert.equal(t.rec.notices, 3);
});

test('refused-step notice: an acceptable redirect does not use up the once-per-sign-in notice', () => {
  const t = createFlowHarness();
  t.enter();
  t.redirect('https://login.example.com/');
  t.redirect('http://evil.example/');
  assert.equal(t.rec.notices, 1);
});

test('refused-step notice: never with the mode off, never for a subframe', () => {
  const t = createFlowHarness();
  t.redirect('http://evil.example/');
  t.enter();
  t.redirect('http://evil.example/', SUBFRAME);
  assert.equal(t.rec.notices, 0);
});

test('redirect gate (A3): the redirect is cancelled even when notifyRefusedStep throws, and nothing propagates', () => {
  const t = createFlowHarness({
    notifyRefusedStep: () => {
      throw new Error('dialog failed');
    },
  });
  t.enter();
  let event;
  assert.doesNotThrow(() => {
    event = t.redirect('http://evil.example/');
  });
  assert.equal(event.defaultPrevented, true);
});

test('logging: a cancelled redirect logs the scheme only - never a host, path, query or the whole url', () => {
  const t = createFlowHarness();
  t.enter();
  t.redirect('http://secret-host-xyz.example/secret-path-xyz?token=secret-token-xyz');
  t.redirect('https://user:secret-pass-xyz@secret-host2-xyz.example/');
  t.commit('https://secret-idp-xyz.example/secret-step-xyz');
  const logged = t.logged();
  for (const secret of ['secret-host-xyz', 'secret-path-xyz', 'secret-token-xyz', 'secret-pass-xyz', 'secret-host2-xyz', 'secret-idp-xyz', 'secret-step-xyz']) {
    assert.equal(logged.includes(secret), false, secret);
  }
  assert.match(logged, /\bhttp\b/, 'the scheme of the refused redirect is logged');
});

// ================================================================================================================
// Abort vs beforeunload: the isAborting() lifecycle (the outcome through will-prevent-unload is in signInWiring.test.js)
// ================================================================================================================

function abortedHarness(overrides) {
  const t = createFlowHarness(overrides);
  t.enter();
  t.flow.abort('user');
  return t;
}

test('isAborting: true after abort for each of the three reasons', () => {
  for (const abortIt of [
    (t) => t.flow.abort('user'),
    (t) => t.tick(IDLE_MS),
    (t) => { for (let i = 1; i <= MAX_HOPS + 1; i += 1) t.commit(idp(i)); },
  ]) {
    const t = createFlowHarness();
    t.enter();
    abortIt(t);
    assert.equal(t.flow.isAborting(), true);
  }
});

test('isAborting: cleared by a main-frame commit on the origin of START_URL', () => {
  const t = abortedHarness();
  t.commit(START_URL);
  assert.equal(t.flow.isAborting(), false);
});

test('isAborting: NOT cleared by any other commit (an unrelated page, an IdP page, accounts.google.com)', () => {
  const t = abortedHarness();
  t.commit('https://some.page.example/');
  t.commit(IDP_URL);
  t.commit(ACCOUNTS_URL);
  assert.equal(t.flow.isAborting(), true);
});

test('isAborting: a subframe or same-document commit on START_URL\'s origin does not clear it', () => {
  const t = abortedHarness();
  t.commit(START_URL, SUBFRAME);
  t.commit(START_URL, SAME_DOC);
  assert.equal(t.flow.isAborting(), true);
});

test('isAborting: cleared by a main-frame load failure, not by a subframe one', () => {
  const t = abortedHarness();
  t.fail(SUBFRAME);
  assert.equal(t.flow.isAborting(), true);
  t.fail(MAIN);
  assert.equal(t.flow.isAborting(), false);
});

test('isAborting: cleared by the 10 second safety timer, not before', () => {
  const t = abortedHarness();
  t.tick(SAFETY_MS - 1);
  assert.equal(t.flow.isAborting(), true);
  t.tick(1);
  assert.equal(t.flow.isAborting(), false);
});

test('isAborting: "the origin of START_URL" is the injected startUrl origin (dev loopback start page)', () => {
  const dev = `${DEV_ORIGIN}/harness`;
  const t = createFlowHarness({ startUrl: dev, chatOrigins: ['https://chat.google.com', DEV_ORIGIN] });
  t.enter();
  t.flow.abort('user');
  t.commit(CHAT_URL);
  assert.equal(t.flow.isAborting(), true, 'Chat is not the origin of THIS startUrl');
  t.commit(dev);
  assert.equal(t.flow.isAborting(), false);
});

test('isAborting: a stale safety timer does not end a later abort early (the first timer is cleared when the flag clears)', () => {
  const t = createFlowHarness();
  t.enter();
  t.flow.abort('user'); // t = 0, safety timer would fire at 10 s
  t.tick(1000);
  t.commit(START_URL); // flag cleared at 1 s
  t.enter();
  t.tick(4000);
  t.flow.abort('user'); // t = 5 s, safety at 15 s
  t.tick(SAFETY_MS - 4000 + 500); // t = 10.5 s: the FIRST timer would have fired
  assert.equal(t.flow.isAborting(), true);
  t.tick(5000);
  assert.equal(t.flow.isAborting(), false);
});

test('isAborting: a second abort() while aborting does not restart the safety timer', () => {
  const t = abortedHarness();
  t.tick(5000);
  t.flow.abort('user');
  t.tick(5000);
  assert.equal(t.flow.isAborting(), false, 'still 10 s from the FIRST abort');
});

test('isAborting: stays false for an exit (signed in) and when nothing was aborted', () => {
  const t = createFlowHarness();
  assert.equal(t.flow.isAborting(), false);
  t.enter();
  assert.equal(t.flow.isAborting(), false);
  t.commit(CHAT_URL);
  assert.equal(t.flow.isAborting(), false);
});

// ================================================================================================================
// Native title: "Sign-in · <registrable domain> — <full host>"
// ================================================================================================================

const TITLE_CASES = [
  ['https://signin-verify.evil.example/', titleFor('evil.example', 'signin-verify.evil.example')],
  ['https://login.example/', titleFor('login.example')],
  ['https://a.b.example.co.uk/', titleFor('example.co.uk', 'a.b.example.co.uk')],
  ['https://adfs/', titleFor('adfs')],
  ['https://co.uk/', titleFor('co.uk')], // a public suffix has no registrable domain: full host
  ['https://LOGIN.Example/x?y=1#z', titleFor('login.example')],
  ['https://login.microsoftonline.com/common/oauth2', titleFor('microsoftonline.com', 'login.microsoftonline.com')],
  ['https://dev-123456.okta.com/app/x', titleFor('okta.com', 'dev-123456.okta.com')],
  ['https://sso.corp.example.com/', titleFor('example.com', 'sso.corp.example.com')],
];

for (const [url, expected] of TITLE_CASES) {
  test(`title (A4): a commit on ${url} sets "${expected}"`, () => {
    const t = createFlowHarness();
    t.enter();
    t.commit(url);
    assert.equal(t.lastTitle(), expected);
  });
}

test('title: entry commit on accounts.google.com sets the title too', () => {
  const t = createFlowHarness();
  t.enter();
  assert.equal(t.rec.titles[0], titleFor('google.com', 'accounts.google.com'));
});

test('title: entry (b) - the landing IdP page gets its title on the entry commit', () => {
  const t = createFlowHarness();
  t.start(ACCOUNTS_URL);
  t.commit('https://signin-verify.evil.example/');
  assert.equal(t.rec.titles[0], titleFor('evil.example', 'signin-verify.evil.example'));
});

test('title: set on EACH main-frame commit while the mode is on, in order; same-document and subframe commits do not set it', () => {
  const t = createFlowHarness();
  t.enter();
  t.commit('https://login.example/');
  t.commit('https://a.b.example.co.uk/');
  t.commit('https://x.example/', SUBFRAME);
  t.commit('https://y.example/', SAME_DOC);
  assert.deepEqual(t.rec.titles, [
    titleFor('google.com', 'accounts.google.com'),
    titleFor('login.example'),
    titleFor('example.co.uk', 'a.b.example.co.uk'),
  ]);
});

test('title: the registrable domain is the FIRST host-derived text, so a deceptive subdomain cannot lead', () => {
  const t = createFlowHarness();
  t.enter();
  t.commit('https://accounts-google-com.signin.attacker.example/');
  const title = t.lastTitle();
  assert.ok(title.startsWith(`Sign-in ${H.SEP_DOT} attacker.example`), title);
  assert.ok(title.indexOf('attacker.example') < title.indexOf('accounts-google-com'), title);
  const long = `${'a'.repeat(60)}.${'b'.repeat(60)}.attacker.example`;
  t.commit(`https://${long}/`);
  assert.ok(t.lastTitle().startsWith(`Sign-in ${H.SEP_DOT} attacker.example`));
});

test('title: the host is not repeated when it is itself the registrable domain', () => {
  const t = createFlowHarness();
  t.enter();
  t.commit('https://login.example/');
  assert.equal(t.lastTitle().split('login.example').length - 1, 1);
});

test('title: not the page title - the factory never reads one and the exit restores with null', () => {
  const t = createFlowHarness();
  t.enter();
  t.commit(IDP_URL);
  t.commit(CHAT_URL);
  assert.equal(t.lastTitle(), null);
  assert.equal(t.rec.titles.filter((x) => x === null).length, 1);
});

test('title: restored (null) on abort for each reason, and never set again afterwards', () => {
  for (const abortIt of [
    (t) => t.flow.abort('user'),
    (t) => t.tick(IDLE_MS),
    (t) => { for (let i = 1; i <= MAX_HOPS + 1; i += 1) t.commit(idp(i)); },
  ]) {
    const t = createFlowHarness();
    t.enter();
    abortIt(t);
    assert.equal(t.lastTitle(), null);
    const count = t.rec.titles.length;
    t.commit('https://after.example/');
    assert.equal(t.rec.titles.length, count, 'mode off: commits never touch the title');
  }
});

test('title: with the mode off the title is never touched, whatever commits', () => {
  const t = createFlowHarness();
  t.commit('https://login.example/');
  t.commit(CHAT_URL);
  t.commit('https://x.example/');
  assert.deepEqual(t.rec.titles, []);
});
