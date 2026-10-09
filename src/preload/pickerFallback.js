'use strict';

// BUG-08: make Google's pages use the plain `<input type="file">` chooser instead of the File System Access pickers.
//
// Registered for the shared session (session.js, `registerPreloadScript`, type 'frame'), so it runs before the page's
// own scripts in the main Chat window, the Google app windows and the Meet call window. It exposes NOTHING (no
// contextBridge call, no IPC); it only removes three globals from the PAGE's own world:
//
//   showOpenFilePicker, showSaveFilePicker, showDirectoryPicker
//
// Why: Chromium shows these pickers through a chooser that is cancelled the moment the page's contents stop being
// "visible" (content/browser/web_contents_based_canceller.cc: "Visibility changed" -> "Cancelling chooser" -> the
// page gets AbortError with no dialog). Observed in Docker/Linux on Electron 44.4.3: a call window smaller than
// the dialog is occluded by it, the picker is cancelled within ~35 ms, while the `<input type="file">` chooser
// (Electron's own dialog, no canceller) opened and returned the file in every window. Without these globals a page
// takes the same code path Firefox and Safari users get, which is the input chooser. Dropping files is unaffected:
// `DataTransfer.files` and `getAsFileSystemHandle()` stay (the read grant is in fileAccess.js).
//
// docs/architecture/file-access.md.

const { webFrame } = require('electron');

/** The script run in the page's main world. Exported through module.exports for the unit test. */
const REMOVE_PICKERS_SCRIPT =
  "(function () { ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker'].forEach(function (name) {" +
  ' try { delete window[name]; } catch (e) {}' +
  ' }); })();';

try {
  const pending = webFrame.executeJavaScript(REMOVE_PICKERS_SCRIPT);
  if (pending && typeof pending.catch === 'function') pending.catch(() => {});
} catch {
  // never disturb the page
}

module.exports = { REMOVE_PICKERS_SCRIPT };
