'use strict';

// BUG-01-G: Windows toast identity (AppUserModelID). A packaged build must use exactly the id
// electron-builder registers for the installed NSIS app (package.json build.appId) - Windows then
// shows the productName in the toast header and the Start Menu shortcut matches. An unpackaged
// (dev) run must NOT reuse that id: it would impersonate the installed app (shared Action Center
// grouping, header text "Electron" because no shortcut carries the id). Dev gets a different but
// stable id that keeps the app id as a prefix.
//
// The id is a literal here, NOT read from package.json at runtime: electron-builder strips the
// `build` block from the package.json it ships inside app.asar, so `require('../../package.json')
// .build.appId` throws in a packaged build (found by running the packaged app). The single source
// of truth stays package.json build.appId; test/appIdentity.test.js fails if the two ever differ.
// Do not change this value for the packaged build: renaming an AUMID orphans the per-app
// notification settings of installed users.

const APP_ID = 'dev.retro-kharkov1.google-chat-desktop';
const DEV_SUFFIX = '.dev';

/**
 * @param {{isPackaged: boolean}} opts `app.isPackaged`.
 * @returns {string}
 */
function resolveAppUserModelId({ isPackaged }) {
  return isPackaged ? APP_ID : `${APP_ID}${DEV_SUFFIX}`;
}

// BUG-05 attempt 2: the URL scheme a toast's protocol activation launches (toastActivation.js). A dev run
// gets its own scheme so it never takes over the installed app's registration.
const PROTOCOL_SCHEME = 'gcd-chat';

/**
 * @param {{isPackaged: boolean}} opts `app.isPackaged`.
 * @returns {string}
 */
function resolveProtocolScheme({ isPackaged }) {
  return isPackaged ? PROTOCOL_SCHEME : `${PROTOCOL_SCHEME}-dev`;
}

module.exports = { resolveAppUserModelId, resolveProtocolScheme };
