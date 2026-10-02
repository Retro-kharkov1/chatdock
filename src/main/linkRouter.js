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

function createLinkRouter({ classifyLink, isOpenableExternalScheme, openCallWindow, openExternal, log }) {
  /** route(url) -> 'call-window' | 'external' | 'dropped' */
  function route(url) {
    const result = classifyLink(url);
    if (result && result.outcome === 'call-window') {
      openCallWindow(result.url);
      return 'call-window';
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
    try {
      route(details && details.url);
    } catch (err) {
      log('[gcd] link routing failed', err && err.name);
    }
    return { action: 'deny' };
  }

  /** In-app origins pass untouched; anything else is prevented and routed. Fails closed. */
  function onWillNavigate(event, url, opts) {
    const allowedOrigins = opts && opts.allowedOrigins;
    const origin = originOf(url);
    if (Array.isArray(allowedOrigins) && origin !== null && allowedOrigins.includes(origin)) return;
    event.preventDefault();
    try {
      route(url);
    } catch (err) {
      log('[gcd] link routing failed', err && err.name);
    }
  }

  return { route, onWindowOpen, onWillNavigate };
}

module.exports = { createLinkRouter };
