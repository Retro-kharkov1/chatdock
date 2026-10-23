'use strict';

// UI-13 / gap row 12: back and forward in the Google app windows (Docs, Drive, ...). Alt+Left / Alt+Right and the
// mouse back / forward buttons (Windows and Linux both arrive as the window's `app-command` event:
// browser-backward / browser-forward). The main Chat window, the call window and the other windows are never bound.
// Kept out of zoom.js and editShortcuts.js on purpose. No Electron import: the window is passed in.
//
// Electron does NOT emit will-navigate for a programmatic back / forward (webContents docs, will-navigate), so the
// window's navigation guard never sees it. The target entry is therefore checked here with the SAME predicate the guard
// uses (isAllowed = isGoogleNavigationUrl, injected, not copied); a refused target is simply not taken. A redirect on
// the way still raises will-redirect, which the guard handles as before. Nothing is logged: URLs are never written.
// Uses contents.navigationHistory (webContents.goBack is deprecated since Electron 32; the app pins 44).

/** 'back' | 'forward' | null for a key event: Alt+Left / Alt+Right, no Ctrl, Meta or Shift. */
function historyActionForKey(input) {
  if (!input || input.type !== 'keyDown' || !input.alt || input.control || input.meta || input.shift) return null;
  if (input.key === 'ArrowLeft') return 'back';
  if (input.key === 'ArrowRight') return 'forward';
  return null;
}

/** 'back' | 'forward' | null for an app-command name. */
function historyActionForCommand(command) {
  if (command === 'browser-backward') return 'back';
  if (command === 'browser-forward') return 'forward';
  return null;
}

/** createHistoryNav({ isAllowed }) -> { bind(win), go(contents, action) -> boolean (true = a navigation was started) } */
function createHistoryNav({ isAllowed }) {
  function go(contents, action) {
    if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) return false;
    const history = contents.navigationHistory;
    if (!history) return false;
    const step = action === 'back' ? -1 : action === 'forward' ? 1 : 0;
    if (step === 0) return false;
    if (step < 0 ? !history.canGoBack() : !history.canGoForward()) return false;
    const target = history.getEntryAtIndex(history.getActiveIndex() + step);
    if (!target || typeof target.url !== 'string' || !isAllowed(target.url)) return false; // the guard would refuse it
    if (step < 0) history.goBack();
    else history.goForward();
    return true;
  }

  function bind(win) {
    const contents = win.webContents;
    contents.on('before-input-event', (event, input) => {
      const action = historyActionForKey(input);
      if (!action) return;
      event.preventDefault(); // consumed even at the end of the history: the key never reaches the page
      go(contents, action);
    });
    win.on('app-command', (_event, command) => {
      const action = historyActionForCommand(command);
      if (action) go(contents, action);
    });
    return win;
  }

  return { bind, go };
}

module.exports = { createHistoryNav, historyActionForKey, historyActionForCommand };
