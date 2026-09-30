'use strict';

// Origin lists, extracted from index.js so they are testable.
//
//   navigationOrigins    will-navigate allowlist and the origins the app IPC channels accept
//                        (chat + the Google sign-in origin, provisional per overview.md).
//   notificationOrigins  origins allowed to raise notifications: the service-worker IPC channel and
//                        the `notifications` permission (session.js). Chat only - the sign-in
//                        origin has no business notifying (review S1).

const CHAT_ORIGIN = 'https://chat.google.com';
const SIGN_IN_ORIGIN = 'https://accounts.google.com';

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

module.exports = { CHAT_ORIGIN, SIGN_IN_ORIGIN, buildOrigins, parseDevStartUrl };
