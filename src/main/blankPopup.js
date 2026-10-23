'use strict';

// BUG-09 EXPERIMENT B (branch wip/BUG-09-exp, never merged): the one about:blank popup Chat opens during a Meet call.
//
// Allowed only when ALL hold: the experiment flag is on, the opener is exactly https://chat.google.com, the URL is
// exactly about:blank, the features string is empty, and no such window is open. The window is sandboxed with no
// preload, gets no permissions of its own (isPopupContents() lets session.js deny everything for it), cannot open
// popups, and navigates only to exact https://meet.google.com / https://accounts.google.com; any other navigation
// goes to the system browser under the existing scheme allow-list. The opener link is kept (no noopener).
// No Electron import: BrowserWindow events are wired by index.js; unit-testable with fakes.

const CHAT_ORIGIN = 'https://chat.google.com';
const POPUP_NAV_ORIGINS = Object.freeze(['https://meet.google.com', 'https://accounts.google.com']);
const PENDING_TTL_MS = 5000;

function strictOrigin(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const u = new URL(value);
    if (u.username !== '' || u.password !== '') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** isBlankPopupRequest(details) - the shape test only (opener, URL, features), no state. */
function isBlankPopupRequest(details) {
  if (!details || details.url !== 'about:blank') return false;
  if (typeof details.features !== 'string' || details.features !== '') return false;
  return strictOrigin(details.referrer && details.referrer.url) === CHAT_ORIGIN;
}

const POPUP_WEB_PREFERENCES = Object.freeze({
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  webviewTag: false,
  webSecurity: true,
});

function createBlankPopup({ enabled, openExternal, isOpenableExternalScheme, diag = () => {}, now = Date.now }) {
  let pendingAt = null; // approved by the handler, window not yet created
  let current = null; // the live popup { win, contents }

  const busy = () => current !== null || (pendingAt !== null && now() - pendingAt < PENDING_TTL_MS);

  /** decide(details) -> a setWindowOpenHandler result, or null (the caller then uses its normal router). */
  function decide(details) {
    if (enabled !== true || !isBlankPopupRequest(details)) return null;
    if (busy()) {
      diag('exp-blank-popup', { decision: 'deny', reason: 'another popup is open' });
      return null;
    }
    pendingAt = now();
    diag('exp-blank-popup', { decision: 'allow', opener: CHAT_ORIGIN, url: 'about:blank', disposition: details.disposition });
    return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { ...POPUP_WEB_PREFERENCES } } };
  }

  /** onCreated(win, details) - wire the window the handler approved. Anything not approved is destroyed. */
  function onCreated(win, details) {
    if (pendingAt === null || !details || details.url !== 'about:blank') {
      diag('exp-blank-popup', { decision: 'destroy', reason: 'unapproved window' });
      try {
        win.destroy();
      } catch {
        // already gone
      }
      return;
    }
    pendingAt = null;
    const contents = win.webContents;
    current = { win, contents };

    // Verify what Electron really applied; fail closed.
    try {
      const wp = typeof contents.getLastWebPreferences === 'function' ? contents.getLastWebPreferences() : null;
      if (wp && (wp.sandbox !== true || wp.contextIsolation !== true || wp.nodeIntegration === true || wp.preload)) {
        diag('exp-blank-popup', { decision: 'destroy', reason: 'web preferences not as required' });
        win.destroy();
        current = null;
        return;
      }
    } catch {
      // preferences not readable: the handler's options stand
    }

    contents.setWindowOpenHandler(() => {
      diag('exp-blank-popup', { decision: 'popup-denied' });
      return { action: 'deny' };
    });
    const onNavigate = (event, url) => {
      const target = event && typeof event.url === 'string' ? event.url : url;
      const origin = strictOrigin(target);
      if (origin !== null && POPUP_NAV_ORIGINS.includes(origin)) {
        diag('exp-blank-popup', { decision: 'nav-allowed', origin });
        return;
      }
      event.preventDefault();
      let routed = 'dropped';
      try {
        if (isOpenableExternalScheme(target)) {
          openExternal(target);
          routed = 'external';
        }
      } catch {
        routed = 'error';
      }
      diag('exp-blank-popup', { decision: 'nav-blocked', origin: origin === null ? '<unparseable>' : origin, routed });
    };
    contents.on('will-navigate', onNavigate);
    contents.on('will-redirect', onNavigate);
    win.on('closed', () => {
      current = null;
      diag('exp-blank-popup', { decision: 'closed' });
    });
    diag('exp-blank-popup', { decision: 'created' });
  }

  /** isPopupContents(webContents) - true for the live popup's contents (session.js denies every permission for it). */
  function isPopupContents(webContents) {
    return current !== null && webContents === current.contents;
  }

  return { decide, onCreated, isPopupContents };
}

module.exports = { createBlankPopup, isBlankPopupRequest, POPUP_NAV_ORIGINS, POPUP_WEB_PREFERENCES };
