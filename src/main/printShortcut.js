'use strict';

// UI-14 / gap row 14: Ctrl+P (Cmd+P) in the Google app windows (Docs, Sheets, Drive, ...) opens the SYSTEM print dialog
// through webContents.print(). The application menu is null (index.js), so Chromium's own Ctrl+P accelerator does not
// exist. Never silent (silent is not passed, Electron's default is false), never printToPDF, no new UI control, nothing
// logged (no URL, title or printer name; the failure reason is not read). The main Chat window, the call window and
// the other windows are never bound. Kept out of zoom.js, historyNav.js and editShortcuts.js on purpose.
// No Electron import: the contents is passed in.

/** True for a Ctrl+P / Cmd+P key-down: no Alt, no Shift (Ctrl+Shift+P is not print). */
function isPrintKey(input) {
  if (!input || input.type !== 'keyDown' || !(input.control || input.meta) || input.alt || input.shift) return false;
  return String(input.key).toLowerCase() === 'p';
}

/** createPrintShortcut() -> { bind(contents), print(contents) -> boolean (true = the dialog was requested) } */
function createPrintShortcut() {
  function print(contents) {
    if (!contents || typeof contents.print !== 'function') return false;
    if (typeof contents.isDestroyed === 'function' && contents.isDestroyed()) return false;
    contents.print(); // no options: the system dialog is shown (silent defaults to false)
    return true;
  }

  function bind(contents) {
    contents.on('before-input-event', (event, input) => {
      if (!isPrintKey(input)) return;
      event.preventDefault();
      print(contents);
    });
    return contents;
  }

  return { bind, print };
}

module.exports = { createPrintShortcut, isPrintKey };
