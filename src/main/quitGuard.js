'use strict';

// docs/architecture/meet-call-window.md section 8 rules 1-3 and tray-lifecycle.md "Close-to-tray".
//
// Spike B (ADR-0004): a page's `beforeunload` objection silently blocks app.quit() unless a
// `will-prevent-unload` listener calls event.preventDefault(). So:
//   * every contents the app owns gets a listener, ALWAYS, at registration time;
//   * while a quit is in progress the listener overrides synchronously (no dialog, no async step);
//   * `before-quit` starts a one-shot timer that `will-quit` clears; if it fires the quit did not
//     happen and `isQuitting` is reset, so the main window's X hides again instead of destroying.
// before-quit itself never prevents the quit and never shows anything.

function createQuitGuard({ timers = { setTimeout, clearTimeout }, resetMs = 5000 } = {}) {
  let quitting = false;
  let timer = null;

  function clearTimer() {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  }

  return {
    isQuitting: () => quitting,

    /** `before-quit`: never calls event.preventDefault(). */
    onBeforeQuit() {
      quitting = true;
      clearTimer();
      timer = timers.setTimeout(() => {
        timer = null;
        quitting = false; // the quit did not happen
      }, resetMs);
    },

    /** `will-quit`: the quit really happens; isQuitting stays true. */
    onWillQuit() {
      clearTimer();
    },

    /** Always register; override synchronously while quitting, otherwise leave the page's objection alone. */
    guardContents(webContents) {
      webContents.on('will-prevent-unload', (event) => {
        if (quitting) event.preventDefault();
      });
    },
  };
}

module.exports = { createQuitGuard };
