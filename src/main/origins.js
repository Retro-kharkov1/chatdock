'use strict';

// Origin lists, extracted from index.js so they are testable.
//
//   navigationOrigins    the FIXED will-navigate allowlist (chat + the Google sign-in origin). While the FR-19 sign-in
//                        mode is on (signInFlow.js) the main window may additionally follow an acceptable https
//                        origin; that widening is a state, not an edit of this list (sign-in-flow.md).
//   notificationOrigins  origins allowed to raise notifications: the service-worker IPC channel and
//                        the `notifications` permission (session.js). Chat only - the sign-in
//                        origin has no business notifying (review S1).

const CHAT_ORIGIN = 'https://chat.google.com';
const SIGN_IN_ORIGIN = 'https://accounts.google.com';

// Generic Chat root - never a private space/DM ID. Same origin as CHAT_ORIGIN, so it is covered by
// every allowlist above (navigation, notifications, clipboard).
const START_URL = CHAT_ORIGIN + '/';

/**
 * @param {string|null} devOrigin An extra loopback origin for the dev harness, or null.
 * @returns {{navigationOrigins: string[], notificationOrigins: string[]}} fresh arrays per call.
 */
function buildOrigins(devOrigin) {
  const navigationOrigins = [CHAT_ORIGIN, SIGN_IN_ORIGIN];
  const notificationOrigins = [CHAT_ORIGIN];
  if (devOrigin) {
    navigationOrigins.push(devOrigin);
    notificationOrigins.push(devOrigin);
  }
  return { navigationOrigins, notificationOrigins };
}

/**
 * Dev-only test seam (never active in a packaged build): a local harness page can stand in for
 * Chat so notification/attention behaviour can be exercised without a signed-in session.
 * Loopback http only; URLs carrying userinfo are refused.
 * @param {string|undefined} value GCD_DEV_START_URL
 * @param {boolean} isPackaged app.isPackaged
 * @returns {{url: string, origin: string}|null}
 */
function parseDevStartUrl(value, isPackaged) {
  if (isPackaged || typeof value !== 'string' || value === '') return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' || u.username || u.password) return null;
    if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return null;
    return { url: u.href, origin: u.origin };
  } catch {
    return null;
  }
}

module.exports = { CHAT_ORIGIN, SIGN_IN_ORIGIN, START_URL, buildOrigins, parseDevStartUrl };
