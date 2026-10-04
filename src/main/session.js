'use strict';

// FR-03/FR-04 (docs/architecture/overview.md "Session persistence") + ADR-0001 (primary sign-in
// path). This module configures the one persistent session partition the app's single
// BrowserWindow uses, and nothing else — it has no Electron-app-lifecycle concerns of its own.

/**
 * The partition name is exported as a constant, not inlined at each call site, precisely because
 * overview.md flags renaming this string between releases as the single most common way to
 * silently break FR-04 (a renamed partition is a *new*, empty, persistent partition — the user
 * appears logged out with no error). Keeping one canonical definition makes that mistake a
 * one-place-to-check instead of a grep across the codebase.
 */
const { CHAT_ORIGIN } = require('./origins');
const { decideMeetRequest, decideMeetCheck } = require('./meetPermissions');

const PARTITION = 'persist:google-chat';

/** Origins granted `clipboard-sanitized-write` (BUG-02): Chat only. */
const CLIPBOARD_WRITE_ORIGINS = Object.freeze([CHAT_ORIGIN]);

/**
 * UI-04 (google-app-windows.md section 6): `clipboard-sanitized-write` and `fullscreen` are granted to a Google app
 * window only when the requesting origin AND the top-level origin are both in this set. A separate constant on
 * purpose (like BUG-02's list): it is NOT derived from the app windows' navigation list. This is what keeps a
 * docs/drive frame embedded under Chat (top-level chat.google.com) at no new grant.
 */
const GOOGLE_APP_CLIPBOARD_FULLSCREEN_ORIGINS = Object.freeze([
  'https://docs.google.com',
  'https://drive.google.com',
]);
const GOOGLE_APP_PERMISSIONS = Object.freeze(['clipboard-sanitized-write', 'fullscreen']);

/**
 * buildDesktopUserAgent()
 *
 * Builds a standard desktop Chrome user-agent string using the Chromium version Electron
 * actually bundles (`process.versions.chrome`), rather than a hardcoded version string that
 * would silently go stale on the next Electron bump. Per ADR-0001, this is the primary sign-in
 * path's configuration (mirroring GogChat's working setup) — not a guaranteed bypass of Google's
 * embedded-browser detection, just the documented best-effort primary tier.
 *
 * @returns {string} A desktop Chrome UA string for the current OS.
 */
function buildDesktopUserAgent() {
  const chromeVersion = process.versions.chrome || '128.0.0.0';
  const platformToken =
    process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

/** originOf(value) - the origin of a URL or origin string (trailing slash tolerated), or undefined. */
function originOf(value) {
  if (typeof value !== 'string') return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/** originOf() that also refuses userinfo and the empty string (a top-level origin must be unambiguous). */
function strictOriginOf(value) {
  if (typeof value !== 'string' || value === '') return undefined;
  try {
    const u = new URL(value);
    return u.username === '' && u.password === '' ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

function topLevelUrlOf(webContents) {
  if (!webContents || typeof webContents.getURL !== 'function') return undefined;
  try {
    return webContents.getURL();
  } catch {
    return undefined;
  }
}

/**
 * The UI-04 grant: requesting origin AND every available top-level signal must be in the Google set.
 * `topLevelSignals` are raw URL/origin strings; an empty list (no top-level information at all), or any signal that
 * is missing, empty or unparseable, denies.
 */
function googleAppGrant(requesting, topLevelSignals) {
  if (requesting === undefined || !GOOGLE_APP_CLIPBOARD_FULLSCREEN_ORIGINS.includes(requesting)) return false;
  if (topLevelSignals.length === 0) return false;
  return topLevelSignals.every((signal) => {
    const origin = strictOriginOf(signal);
    return origin !== undefined && GOOGLE_APP_CLIPBOARD_FULLSCREEN_ORIGINS.includes(origin);
  });
}

/**
 * configurePersistentSession(ses, { notificationOrigins })
 *
 * Applies the session-wide settings FR-03/FR-04/FR-05 depend on:
 * - the desktop UA (see buildDesktopUserAgent above)
 * - permission handlers (request AND check) that grant only `notifications` (allowlisted
 *   notification origins) and `clipboard-sanitized-write` (Chat origin only, BUG-02) - never to
 *   whatever origin happens to be loaded - and deny everything else (notifications.md piece 1:
 *   "deny everything else by default").
 *
 * @param {Electron.Session} ses The session obtained via `session.fromPartition(PARTITION)`.
 * UI-01 (Meet): the same two handlers are EXTENDED with the Meet decisions (meetPermissions.js:
 * camera / microphone / speaker-selection / display-capture, granted only when the requesting AND
 * top-level origin are https://meet.google.com). The notification and clipboard grants above are
 * untouched. `displayMediaHandler`, when given, becomes the session-wide screen-share gate.
 *
 * @param {{notificationOrigins: string[], clipboardOrigins?: string[], displayMediaHandler?: Function}} opts
 *   See origins.js.
 */
function configurePersistentSession(
  ses,
  { notificationOrigins, clipboardOrigins = CLIPBOARD_WRITE_ORIGINS, displayMediaHandler }
) {
  ses.setUserAgent(buildDesktopUserAgent());

  // BUG-02: `navigator.clipboard.writeText` needs `clipboard-sanitized-write`. It is granted from
  // its own allowlist (Chat only by default), deliberately NOT derived from notificationOrigins so
  // the dev loopback origin never gains clipboard write through the notifications list. Every other
  // clipboard permission (read, raw write, sanitized-read) stays denied.
  const allowed = (permission, origin) => {
    if (origin === undefined) return false;
    if (permission === 'notifications') {
      return Array.isArray(notificationOrigins) && notificationOrigins.includes(origin);
    }
    if (permission === 'clipboard-sanitized-write') {
      return Array.isArray(clipboardOrigins) && clipboardOrigins.includes(origin);
    }
    return false;
  };

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (GOOGLE_APP_PERMISSIONS.includes(permission)) {
      // Top-level origin of the asking contents (the request details carry no such field).
      const requesting = strictOriginOf(details && details.requestingUrl);
      if (googleAppGrant(requesting, [topLevelUrlOf(webContents)])) {
        callback(true);
        return;
      }
      // Not a docs/drive page: fall through to the existing decisions (Chat keeps its clipboard grant).
    }
    const meet = decideMeetRequest(webContents, permission, details);
    if (meet !== undefined) {
      callback(meet);
      return;
    }
    let origin = originOf(details && details.requestingUrl);
    if (origin === undefined && webContents && typeof webContents.getURL === 'function') {
      origin = originOf(webContents.getURL());
    }
    callback(allowed(permission, origin));
  });

  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (GOOGLE_APP_PERMISSIONS.includes(permission)) {
      // `details.embeddingOrigin` is documented as "only set for cross-origin sub frames" and names the frame
      // EMBEDDING the asker (not necessarily the top level), so it is combined with the asking contents' own URL
      // (the real top level; for a top-level page this is the only signal). Every signal present must be listed.
      const signals = [];
      const embedding = details && details.embeddingOrigin;
      if (embedding !== undefined && embedding !== null) signals.push(embedding);
      const topUrl = topLevelUrlOf(webContents);
      if (topUrl !== undefined) signals.push(topUrl);
      const requesting = strictOriginOf(requestingOrigin) ?? strictOriginOf(details && details.requestingUrl);
      if (googleAppGrant(requesting, signals)) return true;
      // Not a docs/drive page: fall through to the existing decisions (Chat keeps its clipboard grant).
    }
    const meet = decideMeetCheck(webContents, permission, requestingOrigin, details);
    if (meet !== undefined) return meet;
    return allowed(
      permission,
      originOf(requestingOrigin) ?? originOf(details && details.requestingUrl)
    );
  });

  if (typeof displayMediaHandler === 'function') {
    ses.setDisplayMediaRequestHandler(displayMediaHandler);
  }
}

module.exports = {
  PARTITION,
  GOOGLE_APP_CLIPBOARD_FULLSCREEN_ORIGINS,
  buildDesktopUserAgent,
  configurePersistentSession,
};
