'use strict';

// docs/architecture/meet-call-window.md section 3. Pure factory, every collaborator injected, no
// Electron import. One shared decision (`route`) used by the main window's setWindowOpenHandler /
// will-navigate and by the call window's popup / navigation handlers.

/** The URL scheme for logging only; the URL itself (host, path, query) is never logged. */
function schemeOf(url) {
  if (typeof url !== 'string') return 'unparseable';
  const m = /^\s*([a-z][a-z0-9+.-]*):/i.exec(url);
  return m ? m[1].toLowerCase() : 'unparseable';
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const { diag, redactUrl } = require('./diagLog');
const { describeDeniedBlankOpen } = require('./callDiagnostics');

function createLinkRouter({
  name = 'router', // BUG-09: which window owns this router (main / call), for the diagnostics log only
  classifyLink,
  isOpenableExternalScheme,
  openCallWindow,
  openExternal,
  log,
  // UI-04 (google-app-windows.md sections 1, 3, 5): ALL OPTIONAL. When any is absent the router behaves
  // exactly as before (Chat and other Google links go to the system browser).
  classifyGoogleLink,
  classifyChatTarget,
  openMainWindow,
  focusMainWindow,
  downloadInMainWindow,
  openGoogleAppWindow,
}) {
  const googleEnabled = [
    classifyGoogleLink,
    classifyChatTarget,
    openMainWindow,
    focusMainWindow,
    downloadInMainWindow,
    openGoogleAppWindow,
  ].every((fn) => typeof fn === 'function');

  /** 'main' (default; a main-window popup / navigation) or 'app' (a Google app window; 'app-window' accepted). */
  function normaliseSource(source) {
    if (source === 'app' || source === 'app-window') return 'app';
    return source === undefined || source === 'main' ? 'main' : source;
  }

  /**
   * route(url, { source }) -> 'call-window' | 'main-window' | 'focus-main' | 'download' | 'app-window'
   *                           | 'external' | 'dropped'
   * Order: Meet > Chat > Google app window (incl. the forms.gle hop) > http/https/mailto > dropped.
   */
  function route(url, opts) {
    const result = classifyLink(url);
    if (result && result.outcome === 'call-window') {
      openCallWindow(result.url);
      return 'call-window';
    }
    if (googleEnabled) {
      const google = classifyGoogleLink(url);
      if (google && google.outcome === 'main-window') {
        const target = classifyChatTarget(google.url, normaliseSource(opts && opts.source));
        if (target === 'main-window') {
          openMainWindow(google.url);
          return 'main-window';
        }
        if (target === 'focus-main') {
          focusMainWindow();
          return 'focus-main';
        }
        if (target === 'download') {
          downloadInMainWindow(google.url);
          return 'download';
        }
        // 'browser': falls through to the external rule below (today's behaviour for Chat pop-outs).
      } else if (google && google.outcome === 'app-window') {
        openGoogleAppWindow(google.url, { hop: Boolean(google.hop) });
        return 'app-window';
      }
    }
    if (isOpenableExternalScheme(url)) {
      openExternal(url);
      return 'external';
    }
    log('[gcd] link not opened: disallowed scheme', schemeOf(url));
    return 'dropped';
  }

  /** Always deny; the target is routed as a side effect. Never throws. */
  function onWindowOpen(details) {
    let decision = 'error';
    try {
      decision = route(details && details.url);
    } catch (err) {
      log('[gcd] link routing failed', err && err.name);
    }
    // BUG-09: the handler always denies, so no window is ever created here (window.open() returns null in the page).
    diag('window-open', {
      owner: name,
      url: redactUrl(details && details.url),
      disposition: details && details.disposition,
      frameName: details && typeof details.frameName === 'string' ? details.frameName.slice(0, 60) : undefined,
      routed: decision,
      result: 'deny',
    });
    // BUG-09: a denied about:blank (the page's call popup) - origin of the opener, disposition and features only.
    const blank = describeDeniedBlankOpen(details);
    if (blank) diag('window-open-blank', { owner: name, ...blank });
    return { action: 'deny' };
  }

  /**
   * In-app origins pass untouched; anything else is prevented and routed. Fails closed.
   * FR-19 (sign-in-flow.md section 7): the optional `opts.allow(url)` is consulted only AFTER the fixed list and lets
   * the navigation pass untouched when it returns exactly `true` (the sign-in mode's predicate). Absent: unchanged.
   * A throwing `allow` fails closed to the router.
   */
  function onWillNavigate(event, url, opts) {
    const allowedOrigins = opts && opts.allowedOrigins;
    const origin = originOf(url);
    if (Array.isArray(allowedOrigins) && origin !== null && allowedOrigins.includes(origin)) return;
    const allow = opts && opts.allow;
    if (typeof allow === 'function') {
      try {
        if (allow(url) === true) return;
      } catch (err) {
        log('[gcd] navigation predicate failed', err && err.name);
      }
    }
    event.preventDefault();
    let decision = 'error';
    try {
      decision = route(url, { source: opts && opts.source });
    } catch (err) {
      log('[gcd] link routing failed', err && err.name);
    }
    diag('navigate-routed', { owner: name, url: redactUrl(url), routed: decision });
  }

  return { route, onWindowOpen, onWillNavigate };
}

module.exports = { createLinkRouter };
