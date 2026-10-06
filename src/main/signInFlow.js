'use strict';

// FR-19 sign-in mode (docs/architecture/sign-in-flow.md). A small state machine, one per main window, that lets the
// MAIN frame follow a Google sign-in through the organisation's own identity provider (an origin that differs per
// organisation and so cannot be on the fixed navigation list), and puts the window back on the fixed list when Chat
// loads again, the user chooses "Back to Chat", or a limit fires.
//
// Pure: no Electron import, every collaborator injected (like linkRouter.js). It answers "may the main frame go to
// this URL right now" and nothing else; permissions, bridges, notifications and downloads are not its business.
//
// Logging: the scheme only, never a URL, host, path or query.
// Registrable domain (window title): a bundled subset of the Public Suffix List, see MULTI_LABEL_SUFFIXES.

const { LINK_LIST_HOSTS, ENTRY_HOP_HOST, USERCONTENT_HOST } = require('./googleLink');
const { MEET_ORIGIN } = require('./meetLink');
const { urlOrigin } = require('./mainFrameGate');

const DEFAULT_REFUSED_HOSTS = Object.freeze([
  ...LINK_LIST_HOSTS,
  ENTRY_HOP_HOST,
  USERCONTENT_HOST,
  new URL(MEET_ORIGIN).hostname,
]);
const DEFAULT_REFUSED_SUFFIXES = Object.freeze(['googleusercontent.com']);

const MIN = 60 * 1000;
const DEFAULT_IDLE_MS = 10 * MIN;
const DEFAULT_CAP_MS = 30 * MIN;
const DEFAULT_MAX_HOPS = 40;
const ABORT_SAFETY_MS = 10 * 1000;

const SEP_DOT = '·'; // middle dot
const SEP_DASH = '—'; // em dash

/**
 * Public suffixes of more than one label, so the registrable domain of `a.b.example.co.uk` is `example.co.uk`.
 * A BUNDLED SUBSET of the Public Suffix List (the full list is ~9000 entries and changes weekly; no PSL library is
 * a dependency of this app): the common country-code second-level suffixes plus widely used multi-tenant hosting
 * suffixes. A suffix missing here only makes the shown "site" one label shorter than the PSL would (the full host
 * is always shown after it), so the failure is a less specific cue, never a missing or wrong host.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  // United Kingdom, Ireland-adjacent, Australia, New Zealand, South Africa, India, Japan, Korea, Israel
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk', 'me.uk', 'net.uk', 'sch.uk', 'nhs.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.nz', 'org.nz', 'net.nz', 'govt.nz', 'ac.nz', 'school.nz',
  'co.za', 'org.za', 'gov.za', 'ac.za', 'net.za',
  'co.in', 'net.in', 'org.in', 'ac.in', 'gov.in', 'edu.in', 'firm.in', 'gen.in', 'ind.in',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'ad.jp', 'ed.jp', 'gr.jp',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr', 're.kr',
  'co.il', 'org.il', 'ac.il', 'gov.il', 'net.il',
  // Americas, Asia, Europe: commercial / organisation / government / education second levels
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.ar', 'net.ar', 'org.ar', 'gob.ar', 'edu.ar',
  'com.mx', 'org.mx', 'gob.mx', 'edu.mx', 'net.mx',
  'com.co', 'net.co', 'org.co', 'edu.co', 'gov.co',
  'com.pe', 'com.ve', 'com.uy', 'com.ec', 'com.py', 'com.bo',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.hk', 'org.hk', 'edu.hk', 'gov.hk', 'net.hk',
  'com.tw', 'org.tw', 'edu.tw', 'gov.tw', 'net.tw',
  'com.sg', 'org.sg', 'edu.sg', 'gov.sg', 'net.sg',
  'com.my', 'org.my', 'edu.my', 'gov.my', 'net.my',
  'com.ph', 'org.ph', 'edu.ph', 'gov.ph', 'net.ph',
  'co.id', 'or.id', 'ac.id', 'go.id', 'web.id',
  'co.th', 'or.th', 'ac.th', 'go.th', 'in.th',
  'com.vn', 'net.vn', 'org.vn', 'edu.vn', 'gov.vn',
  'com.pk', 'org.pk', 'edu.pk', 'gov.pk', 'net.pk',
  'com.bd', 'org.bd', 'edu.bd', 'gov.bd', 'net.bd',
  'com.tr', 'org.tr', 'edu.tr', 'gov.tr', 'net.tr', 'gen.tr', 'k12.tr',
  'com.ua', 'org.ua', 'net.ua', 'edu.ua', 'gov.ua', 'in.ua', 'kh.ua', 'kiev.ua', 'kharkov.ua', 'lviv.ua', 'od.ua',
  'com.pl', 'org.pl', 'net.pl', 'edu.pl', 'gov.pl',
  'com.ru', 'org.ru', 'net.ru', 'pp.ru',
  'com.es', 'org.es', 'nom.es', 'gob.es', 'edu.es',
  'com.pt', 'org.pt', 'edu.pt', 'gov.pt',
  'co.at', 'or.at', 'ac.at', 'gv.at',
  'com.gr', 'org.gr', 'edu.gr', 'gov.gr', 'net.gr',
  'com.eg', 'org.eg', 'edu.eg', 'gov.eg', 'net.eg',
  'com.sa', 'org.sa', 'edu.sa', 'gov.sa', 'net.sa',
  'com.ng', 'org.ng', 'edu.ng', 'gov.ng', 'net.ng',
  'co.ke', 'or.ke', 'ac.ke', 'go.ke', 'ne.ke',
  'co.tz', 'or.tz', 'ac.tz', 'go.tz',
  'co.ug', 'or.ug', 'ac.ug', 'go.ug',
  'co.zw', 'org.zw', 'ac.zw', 'gov.zw',
  // Multi-tenant hosting: the tenant, not the platform, is the "site" the user must recognise.
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'netlify.app', 'vercel.app', 'web.app', 'firebaseapp.com',
  'herokuapp.com', 'appspot.com', 'azurewebsites.net', 'azurestaticapps.net', 'cloudfront.net', 'blogspot.com',
  'wordpress.com', 'weebly.com', 'wixsite.com', 'myshopify.com', 'repl.co', 'glitch.me', 'ngrok.io', 'ngrok-free.app',
  'fly.dev', 'onrender.com', 'surge.sh', 'trycloudflare.com',
]);

function parse(url) {
  if (typeof url !== 'string' || url === '') return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Scheme only, for logging. */
function schemeOf(url) {
  if (typeof url !== 'string') return 'unparseable';
  const m = /^\s*([a-z][a-z0-9+.-]*):/i.exec(url);
  return m ? m[1].toLowerCase() : 'unparseable';
}

function originOf(url) {
  const u = parse(url);
  return u === null ? null : u.origin;
}

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Section 2: the six rules, and nothing else (the refused set is a separate predicate). Validates the PARSED
 * hostname, never the raw string. Never throws.
 */
function isAcceptableIdpUrl(url) {
  const u = parse(url);
  if (u === null) return false;
  if (u.protocol !== 'https:') return false;
  if (u.username !== '' || u.password !== '') return false;
  if (u.port !== '') return false;
  const host = u.hostname;
  if (host === '') return false;
  if (host.startsWith('[') || host.includes(':')) return false; // IPv6 literal
  if (IPV4_LITERAL.test(host)) return false; // dotted quad after normalisation (0x7f.1, 2130706433, 127.1, ...)
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.')) return false;
  if (host.split('.').some((label) => label.startsWith('xn--'))) return false;
  return true;
}

function hostIsRefused(host, hosts, suffixes) {
  if (hosts.includes(host)) return true;
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** Section 2: the refused set only (default lists, imported from googleLink.js / meetLink.js). Never throws. */
function isRefusedHost(url) {
  const u = parse(url);
  if (u === null) return false;
  return hostIsRefused(u.hostname, DEFAULT_REFUSED_HOSTS, DEFAULT_REFUSED_SUFFIXES);
}

/** registrable domain (eTLD+1) of a hostname, or null when it cannot be determined (single label, a bare suffix). */
function registrableDomain(host) {
  const labels = host.split('.');
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join('.');
  const suffixLength = MULTI_LABEL_SUFFIXES.has(lastTwo) ? 2 : 1;
  if (labels.length <= suffixLength) return null;
  return labels.slice(-(suffixLength + 1)).join('.');
}

/** Section 3a: "Sign-in · <registrable domain> — <full host>", registrable domain FIRST. */
function titleForUrl(url) {
  const u = parse(url);
  if (u === null || u.hostname === '') return null;
  const host = u.hostname;
  const site = registrableDomain(host);
  if (site === null || site === host) return `Sign-in ${SEP_DOT} ${host}`;
  return `Sign-in ${SEP_DOT} ${site} ${SEP_DASH} ${host}`;
}

const isMainFrameNav = (details) =>
  Boolean(details) && details.isMainFrame === true && details.isSameDocument !== true;

function createSignInFlow({
  chatOrigins = [],
  signInOrigin,
  refusedHosts = DEFAULT_REFUSED_HOSTS,
  refusedHostSuffixes = DEFAULT_REFUSED_SUFFIXES,
  startUrl,
  loadStartUrl = () => {},
  setWindowTitle = () => {},
  notifyRefusedStep = () => {},
  onModeChange = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  log = () => {},
  idleMs = DEFAULT_IDLE_MS,
  capMs = DEFAULT_CAP_MS,
  maxHops = DEFAULT_MAX_HOPS,
}) {
  const startOrigin = originOf(startUrl);

  let active = false;
  let aborting = false;
  let chainViaSignIn = false; // the navigation chain passed through the sign-in origin
  let hops = 0;
  let lastOrigin = null;
  let noticeShown = false;
  let idleTimer = null;
  let capTimer = null;
  let safetyTimer = null;

  const isChatOrigin = (origin) => origin !== undefined && origin !== null && chatOrigins.includes(origin);
  const refused = (url) => {
    const u = parse(url);
    return u !== null && hostIsRefused(u.hostname, refusedHosts, refusedHostSuffixes);
  };
  const permitted = (url) => isAcceptableIdpUrl(url) && !refused(url);

  /** Timers never keep the process alive: unref'd when the handle supports it. */
  function startTimer(fn, ms) {
    const handle = setTimer(fn, ms);
    if (handle && typeof handle.unref === 'function') handle.unref();
    return handle;
  }

  function stopTimer(handle) {
    if (handle !== null && handle !== undefined) clearTimer(handle);
  }

  function clearLimitTimers() {
    stopTimer(idleTimer);
    stopTimer(capTimer);
    idleTimer = null;
    capTimer = null;
  }

  function clearAborting() {
    aborting = false;
    stopTimer(safetyTimer);
    safetyTimer = null;
  }

  function safe(fn, what) {
    try {
      fn();
    } catch (err) {
      log(`[gcd] sign-in ${what} failed`, err && err.name);
    }
  }

  function restartIdle() {
    stopTimer(idleTimer);
    idleTimer = startTimer(() => {
      idleTimer = null;
      abort('timeout');
    }, idleMs);
  }

  function activate(origin) {
    active = true;
    hops = 0;
    lastOrigin = origin;
    noticeShown = false;
    restartIdle();
    stopTimer(capTimer);
    capTimer = startTimer(() => {
      capTimer = null;
      abort('timeout');
    }, capMs);
    log('[gcd] sign-in mode on');
    safe(() => onModeChange(true), 'mode notification');
  }

  /** Mode off: timers cleared, title restored, listeners told. Shared by exit and abort. */
  function deactivate() {
    clearLimitTimers();
    active = false;
    safe(() => setWindowTitle(null), 'title restore');
    safe(() => onModeChange(false), 'mode notification');
  }

  function abort(reason) {
    if (!active) return; // idempotent, and a no-op for a stale tray item or notice
    log('[gcd] sign-in returned to Chat:', reason);
    aborting = true;
    stopTimer(safetyTimer);
    safetyTimer = startTimer(() => {
      safetyTimer = null;
      aborting = false;
    }, ABORT_SAFETY_MS);
    deactivate();
    safe(() => loadStartUrl(), 'start page load');
  }

  function onStartNavigation(url, details) {
    if (!isMainFrameNav(details)) return;
    chainViaSignIn = false; // clear first ...
    if (originOf(url) === signInOrigin) chainViaSignIn = true; // ... then set
  }

  function onWillRedirect(event, url, details) {
    if (!isMainFrameNav(details)) return;
    if (originOf(url) === signInOrigin) chainViaSignIn = true; // only ever sets
    if (!active) return; // unchanged behaviour with the mode off
    if (permitted(url)) return;
    event.preventDefault(); // cancels the WHOLE navigation (Electron), nothing opens in the browser
    log('[gcd] sign-in redirect refused', schemeOf(url));
    if (!noticeShown) {
      noticeShown = true;
      safe(() => notifyRefusedStep(), 'refused-step notice');
    }
  }

  function onCommitted(url, details) {
    if (!isMainFrameNav(details)) return;
    const viaSignIn = chainViaSignIn;
    chainViaSignIn = false; // a commit consumes the flag
    const origin = originOf(url);

    if (aborting && origin !== null && origin === startOrigin) clearAborting();

    if (active) {
      if (isChatOrigin(urlOrigin(url))) {
        deactivate(); // exit: signed in (or returned); no load, no reason
        return;
      }
      restartIdle();
      if (origin !== lastOrigin) {
        hops += 1;
        lastOrigin = origin;
        if (hops > maxHops) {
          abort('hop-cap');
          return;
        }
      }
      const title = titleForUrl(url);
      if (title !== null) safe(() => setWindowTitle(title), 'title');
      return;
    }

    const entryA = origin !== null && origin === signInOrigin;
    const entryB = viaSignIn && !isChatOrigin(urlOrigin(url)) && permitted(url);
    if (!entryA && !entryB) return;
    activate(origin);
    const title = titleForUrl(url);
    if (title !== null) safe(() => setWindowTitle(title), 'title');
  }

  function onLoadFailed(details) {
    if (!isMainFrameNav(details)) return;
    chainViaSignIn = false;
    clearAborting();
  }

  function dispose() {
    const wasActive = active;
    clearLimitTimers();
    clearAborting();
    chainViaSignIn = false;
    active = false;
    if (wasActive) safe(() => onModeChange(false), 'mode notification');
  }

  return {
    isActive: () => active,
    isAborting: () => aborting,
    allowNavigation: (url) => active && permitted(url),
    onStartNavigation,
    onWillRedirect,
    onCommitted,
    onLoadFailed,
    abort,
    dispose,
  };
}

module.exports = { createSignInFlow, isAcceptableIdpUrl, isRefusedHost };
