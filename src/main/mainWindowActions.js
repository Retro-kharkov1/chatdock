'use strict';

// UI-04 / docs/architecture/google-app-windows.md section 3: what a Chat link does to the MAIN window.
// Extracted from index.js so the behaviour is unit-testable; deps injected, no Electron import.
//
//   openMainWindow(url)       'main-window' outcome (a link from a Google app window): the same page (fragment
//                             ignored) only shows and focuses the window (no reload: an unsent draft survives);
//                             otherwise loadURL, then restore/show/focus (like tray Show).
//   focusMainWindow()         'focus-main' outcome (a conversation link from a main-window popup): restore, show
//                             and focus ONLY; never loadURL or reload.
//   downloadInMainWindow(url) 'download' outcome (a Chat attachment): webContents.downloadURL; the view is
//                             untouched and the window is neither loaded, shown nor focused. The URL is never logged.
//
// A null or destroyed main window is a no-op everywhere.

function withoutFragment(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return typeof url === 'string' ? url : '';
  }
}

function createMainWindowActions({ getMainWindow, log = () => {} }) {
  function alive() {
    const win = getMainWindow();
    return win && !win.isDestroyed() ? win : null;
  }

  function raise(win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  function guarded(what, fn) {
    try {
      fn();
    } catch (err) {
      log('[gcd] main window action failed:', what, err && err.name);
    }
  }

  function openMainWindow(url) {
    guarded('open', () => {
      const win = alive();
      if (!win) return;
      const current = win.webContents.getURL();
      if (withoutFragment(current) !== withoutFragment(url)) {
        Promise.resolve(win.webContents.loadURL(url)).catch((err) =>
          log('[gcd] main window load failed', err && err.name)
        );
      }
      raise(win);
    });
  }

  function focusMainWindow() {
    guarded('focus', () => {
      const win = alive();
      if (win) raise(win);
    });
  }

  function downloadInMainWindow(url) {
    guarded('download', () => {
      const win = alive();
      if (win) win.webContents.downloadURL(url);
    });
  }

  return { openMainWindow, focusMainWindow, downloadInMainWindow };
}

module.exports = { createMainWindowActions };
