'use strict';

// FR-19 sign-in mode (docs/architecture/sign-in-flow.md) shared test harness. Not a test file.
//
// createFlowHarness(overrides) builds the REAL createSignInFlow (loaded lazily, so a missing
// src/main/signInFlow.js fails only the test that uses it) with every collaborator replaced by a recorder and
// a manual clock (test/helpers/electronFakes.js createManualClock) behind the injected setTimer/clearTimer.
//
// Timer handles returned by the injected setTimer are objects with unref(), so the "timers are unref'd" rule
// is observable (`rec.timers`, each `.unrefd`).

const { createManualClock, makeEvent } = require('./electronFakes');
const { load } = require('./pending');
const { LINK_LIST_HOSTS, ENTRY_HOP_HOST, USERCONTENT_HOST } = require('../../src/main/googleLink');
const { CHAT_ORIGIN, SIGN_IN_ORIGIN, START_URL } = require('../../src/main/origins');
const { MEET_ORIGIN } = require('../../src/main/meetLink');

const MEET_HOST = new URL(MEET_ORIGIN).hostname;

/** The refused set exactly as index.js is specified to build it (section 7): imported lists, never literals. */
const REFUSED_HOSTS = Object.freeze([...LINK_LIST_HOSTS, ENTRY_HOP_HOST, USERCONTENT_HOST, MEET_HOST]);
const REFUSED_SUFFIXES = Object.freeze(['googleusercontent.com']);

const MAIN = Object.freeze({ isMainFrame: true, isSameDocument: false });
const SUBFRAME = Object.freeze({ isMainFrame: false, isSameDocument: false });
const SAME_DOC = Object.freeze({ isMainFrame: true, isSameDocument: true });

const MIN = 60 * 1000;
const IDLE_MS = 10 * MIN;
const CAP_MS = 30 * MIN;
const SAFETY_MS = 10 * 1000;
const MAX_HOPS = 40;

const ACCOUNTS_URL = `${SIGN_IN_ORIGIN}/v3/signin/identifier`;
const IDP_URL = 'https://login.idp.example/sso/saml';
const SEP_DOT = '·';
const SEP_DASH = '—';

/** i-th distinct acceptable origin. */
const idp = (i) => `https://idp${i}.example/`;

/** The native title the spec prescribes (section 3a). */
const titleFor = (site, host) => (host === undefined || host === site ? `Sign-in ${SEP_DOT} ${site}` : `Sign-in ${SEP_DOT} ${site} ${SEP_DASH} ${host}`);

function createFlowHarness(overrides = {}) {
  const clock = createManualClock();
  const rec = { loads: 0, titles: [], modes: [], notices: 0, logs: [], timers: [], abortingDuringLoad: [] };
  let flow = null;
  const deps = {
    chatOrigins: [CHAT_ORIGIN],
    signInOrigin: SIGN_IN_ORIGIN,
    refusedHosts: REFUSED_HOSTS,
    refusedHostSuffixes: REFUSED_SUFFIXES,
    startUrl: START_URL,
    loadStartUrl: () => {
      rec.loads += 1;
      rec.abortingDuringLoad.push(flow.isAborting());
    },
    setWindowTitle: (title) => rec.titles.push(title),
    notifyRefusedStep: () => {
      rec.notices += 1;
    },
    onModeChange: (active) => rec.modes.push(active),
    setTimer: (fn, ms) => {
      const handle = {
        id: clock.setTimeout(fn, ms),
        unrefd: false,
        unref() {
          handle.unrefd = true;
          return handle;
        },
      };
      rec.timers.push(handle);
      return handle;
    },
    clearTimer: (handle) => clock.clearTimeout(handle.id),
    log: (...args) => rec.logs.push(args),
    ...overrides,
  };
  flow = load('signInFlow.js').createSignInFlow(deps);

  const h = {
    flow,
    rec,
    clock,
    deps,
    tick: (ms) => clock.tick(ms),
    start: (url, details = MAIN) => flow.onStartNavigation(url, details),
    commit: (url, details = MAIN) => flow.onCommitted(url, details),
    /** will-redirect: returns the event so a test can read defaultPrevented. */
    redirect: (url, details = MAIN) => {
      const event = makeEvent();
      flow.onWillRedirect(event, url, details);
      return event;
    },
    fail: (details = MAIN) => flow.onLoadFailed(details),
    /** Entry (a): a main-frame commit on accounts.google.com. */
    enter: () => h.commit(ACCOUNTS_URL),
    logged: () => JSON.stringify(rec.logs),
    lastTitle: () => rec.titles[rec.titles.length - 1],
  };
  return h;
}

module.exports = {
  createFlowHarness,
  REFUSED_HOSTS,
  REFUSED_SUFFIXES,
  MAIN,
  SUBFRAME,
  SAME_DOC,
  MIN,
  IDLE_MS,
  CAP_MS,
  SAFETY_MS,
  MAX_HOPS,
  ACCOUNTS_URL,
  IDP_URL,
  CHAT_ORIGIN,
  SIGN_IN_ORIGIN,
  START_URL,
  LINK_LIST_HOSTS,
  ENTRY_HOP_HOST,
  USERCONTENT_HOST,
  MEET_HOST,
  idp,
  titleFor,
  SEP_DOT,
  SEP_DASH,
};
