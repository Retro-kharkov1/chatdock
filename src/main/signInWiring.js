'use strict';

// FR-19 sign-in mode: the glue between the pure state machine (signInFlow.js) and the main window
// (docs/architecture/sign-in-flow.md sections 3a and 7). A module of its own, with every collaborator injected and no
// Electron import, so the outcomes (an abort overrides a page's beforeunload, the page title is not touched while the
// mode is on, `closed` disposes) are unit-testable; index.js only calls it.

/**
 * Registers the sign-in listeners on the MAIN window's contents (and the window's `page-title-updated` and `closed`). This is the ONLY registration of
 * the main window's `will-navigate` (the fixed list, the mode's predicate and the router are one decision; a second
 * listener would route every link twice). `will-redirect` is the redirect source; `did-redirect-navigation` is not used.
 * Event details (url, isMainFrame, isSameDocument) are read from the event object (Electron 44).
 */
function bindSignInFlow({ window, webContents, flow, router, allowedOrigins }) {
  webContents.on('will-navigate', (event, url) => {
    router.onWillNavigate(event, typeof event.url === 'string' ? event.url : url, {
      allowedOrigins,
      allow: (target) => flow.allowNavigation(target),
    });
  });

  webContents.on('did-start-navigation', (event) => {
    flow.onStartNavigation(event.url, { isMainFrame: event.isMainFrame, isSameDocument: event.isSameDocument });
  });

  webContents.on('will-redirect', (event) => {
    flow.onWillRedirect(event, event.url, { isMainFrame: event.isMainFrame, isSameDocument: event.isSameDocument });
  });

  // did-navigate is main-frame and not same-document by definition.
  webContents.on('did-navigate', (_event, url) => {
    flow.onCommitted(url, { isMainFrame: true, isSameDocument: false });
  });

  webContents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => {
    flow.onLoadFailed({ isMainFrame, isSameDocument: false });
  });

  // While the mode is on the window title is the site and host (set by the flow), not the page's own title. The event
  // that stops the NATIVE title from following the page is the BrowserWindow's `page-title-updated` ("calling
  // event.preventDefault() will prevent the native window's title from changing"); the webContents event of the same
  // name is only a notification (preventDefault there changes nothing - observed in a real run).
  window.on('page-title-updated', (event) => {
    if (flow.isActive()) event.preventDefault();
  });

  // An abort must not be held on the page by a beforeunload prompt: preventDefault() ignores the handler and lets the
  // page unload. With no abort in progress nothing is touched (the quit guard keeps its own behaviour).
  webContents.on('will-prevent-unload', (event) => {
    if (flow.isAborting()) event.preventDefault();
  });

  // Hide and close (X) do not end the mode; only a destroyed window clears its timers.
  window.on('closed', () => flow.dispose());
}

/** The tray entry / notice button action: abort('user') (a no-op while the mode is off), THEN always show the window. */
function createBackToChat({ flow, showMainWindow }) {
  return function backToChat() {
    try {
      flow.abort('user');
    } finally {
      showMainWindow();
    }
  };
}

const NOTICE = Object.freeze({
  message: "This sign-in step can't open in the app",
  detail:
    'The page asked to continue somewhere the app does not open. You can go back to Chat and start the sign-in again, or close this message and keep using this page.',
  backToChat: 'Back to Chat',
  close: 'Close',
});

/**
 * The refused-step notice (section 3a): ONE non-blocking native message box, attached to the main window only while it
 * is visible and not minimized. No URL or host is ever shown. Answer 0 ("Back to Chat") runs `onBackToChat`; anything
 * else (Close, Escape, a closed or rejected box) does nothing.
 */
function createRefusedStepNotice({ showMessageBox, getMainWindow, onBackToChat, log = () => {} }) {
  function usableParent() {
    try {
      const win = getMainWindow();
      if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return undefined;
      return win;
    } catch {
      return undefined;
    }
  }

  return function notifyRefusedStep() {
    let shown;
    try {
      shown = Promise.resolve(
        showMessageBox(usableParent(), {
          type: 'info',
          title: NOTICE.message,
          message: NOTICE.message,
          detail: NOTICE.detail,
          buttons: [NOTICE.backToChat, NOTICE.close],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        })
      );
    } catch (err) {
      log('[gcd] sign-in notice failed', err && err.name);
      return;
    }
    shown.then(
      (result) => {
        if (result && result.response === 0) {
          try {
            onBackToChat();
          } catch (err) {
            log('[gcd] sign-in back to chat failed', err && err.name);
          }
        }
      },
      (err) => log('[gcd] sign-in notice failed', err && err.name)
    );
  };
}

/** Native title setter: a string sets it, null restores the title from the contents' own (Chat's) title. */
function createTitleSetter({ window, webContents }) {
  return function setWindowTitle(title) {
    try {
      if (window.isDestroyed()) return;
      window.setTitle(typeof title === 'string' ? title : webContents.getTitle());
    } catch {
      // the window went away between the check and the call
    }
  };
}

module.exports = { bindSignInFlow, createBackToChat, createRefusedStepNotice, createTitleSetter, NOTICE };
