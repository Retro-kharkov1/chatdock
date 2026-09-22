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
const PARTITION = 'persist:google-chat';

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

/**
 * configurePersistentSession(ses)
 *
 * Applies the two session-wide settings FR-03/FR-04/FR-05 depend on:
 * - the desktop UA (see buildDesktopUserAgent above)
 * - a permission-request handler that grants only `notifications` and denies everything else by
 *   default (notifications.md piece 1: "deny everything else by default").
 *
 * @param {Electron.Session} ses The session obtained via `session.fromPartition(PARTITION)`.
 */
function configurePersistentSession(ses) {
  ses.setUserAgent(buildDesktopUserAgent());
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'notifications');
  });
}

module.exports = { PARTITION, buildDesktopUserAgent, configurePersistentSession };
