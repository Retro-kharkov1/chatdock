'use strict';

// BUG-07 / BUG-08: the `fileSystem` permission (the File System Access API).
//
// Google's web apps read a dropped or picked file through File System Access handles
// (`DataTransferItem.getAsFileSystemHandle()`, `showOpenFilePicker()` -> `handle.getFile()`). In Chromium
// the browser grants the read implicitly because the user just chose the file; in Electron the same read
// goes through the session's permission handlers as the `fileSystem` permission, and with no grant
// `getFile()` rejects with NotAllowedError, so the page never gets the bytes: a drop attaches nothing and a
// picked file never uploads. Everything else in session.js already denies by default, which is why this
// permission was denied.
//
// The grant is deliberately narrow:
//   - READ only (`fileAccessType === 'readable'`); a writable grant (save-to-disk by the page) stays denied,
//     downloads go through downloads.js.
//   - the REQUESTING frame's origin must be on FILE_ACCESS_ORIGINS: Chat, Meet and the Google app windows'
//     link list. accounts.google.com, foreign origins and the loopback dev origin get nothing. Electron passes
//     the check handler NO webContents for `fileSystem` (observed on Electron 44: webContents is null, no
//     embeddingOrigin, details carry only filePath/isDirectory/fileAccessType/isMainFrame), so the top-level
//     page cannot be required; when a top-level signal IS present, it must be listed too (fail closed).
//   - the user's choice is the consent: Chromium only creates a handle for a file the user dropped or picked.
//
// Pure and Electron-free, so it is unit-tested (test/fileAccess.test.js).

const { CHAT_ORIGIN } = require('./origins');
const { MEET_ORIGIN } = require('./meetLink');
const { LINK_LIST_HOSTS } = require('./googleLink');

/** Origins that may read a file the user dropped or picked: Chat, Meet, and the app-window link list. */
const FILE_ACCESS_ORIGINS = Object.freeze([
  CHAT_ORIGIN,
  MEET_ORIGIN,
  ...LINK_LIST_HOSTS.map((host) => `https://${host}`),
]);

function strictOriginOf(value) {
  if (typeof value !== 'string' || value === '') return undefined;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
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
 * decideFileSystem({ requesting, topLevelSignals, fileAccessType, origins }) -> boolean
 * The requesting origin must be listed. Top-level signals are optional (see above), but each one that is
 * present must be listed, and an unparseable one denies.
 */
function decideFileSystem({ requesting, topLevelSignals, fileAccessType, origins = FILE_ACCESS_ORIGINS }) {
  if (fileAccessType !== 'readable') return false;
  const req = strictOriginOf(requesting);
  if (req === undefined || !origins.includes(req)) return false;
  const signals = (Array.isArray(topLevelSignals) ? topLevelSignals : []).filter((x) => x !== undefined && x !== null);
  return signals.every((signal) => {
    const o = strictOriginOf(signal);
    return o !== undefined && origins.includes(o);
  });
}

/** Permission REQUEST handler decision. */
function decideFileSystemRequest(webContents, details, origins) {
  return decideFileSystem({
    requesting: details && details.requestingUrl,
    topLevelSignals: [topLevelUrlOf(webContents)],
    fileAccessType: details && details.fileAccessType,
    origins,
  });
}

/** Permission CHECK handler decision (details.embeddingOrigin is set only for cross-origin subframes). */
function decideFileSystemCheck(webContents, requestingOrigin, details, origins) {
  const signals = [topLevelUrlOf(webContents)];
  const embedding = details && details.embeddingOrigin;
  if (embedding !== undefined && embedding !== null) signals.push(embedding);
  return decideFileSystem({
    requesting: requestingOrigin || (details && details.requestingUrl),
    topLevelSignals: signals,
    fileAccessType: details && details.fileAccessType,
    origins,
  });
}

module.exports = { FILE_ACCESS_ORIGINS, decideFileSystem, decideFileSystemRequest, decideFileSystemCheck };
