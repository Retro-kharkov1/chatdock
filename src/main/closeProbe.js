'use strict';

// The one-shot close probe shared by the Meet call window and the Google app windows
// (meet-call-window.md section 8 rules 4-6, google-app-windows.md section 4). An app-initiated close is
// allowed to proceed so the page's `beforeunload` runs; while the probe is active the FIRST
// `will-prevent-unload` objection belongs to the app (it asks the user), a later one is the page's own.
// If the page never answers within `probeMs` the page is treated as having nothing unsaved and
// `onTimeout` runs (the owner destroys the window). A missing signal always means no dialog.
// Pure timer bookkeeping: no Electron import.

function createCloseProbe({ timers = { setTimeout, clearTimeout }, probeMs = 3000, onTimeout }) {
  let timer = null;
  let active = false;

  function clear() {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    active = false;
  }

  return {
    /** Begin (or restart) the probe. */
    start() {
      active = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = timers.setTimeout(() => {
        timer = null;
        active = false;
        onTimeout();
      }, probeMs);
    },
    /** End the probe (objection consumed, window gone, ...): no timer is left behind. */
    clear,
    /** True between start() and clear()/timeout. */
    isActive: () => active,
  };
}

module.exports = { createCloseProbe };
