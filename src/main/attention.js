'use strict';

// FR-14 / FR-15 (docs/business/requirements.md): the attention indicators - tray-icon blink AND
// taskbar flash - driven by ONE small state machine so the two can never disagree.
//
// Inputs are deliberately few:
//   - a new-message ARRIVAL (preferred trigger) or an unread-count INCREASE (the documented
//     degraded trigger; the caller feeds both, they are idempotent together);
//   - the main window gaining OS input focus (the ONLY window input - show/restore/hide/minimize
//     are not inputs: FR-14 reverses the old "becomes visible stops blinking" rule);
//   - the unread count returning to 0;
//   - a settings change (Icon blinking off / Mute on stops immediately; turning them back on does
//     NOT start anything retroactively - the next arrival does).
//
// Everything Electron-shaped is injected, so this is unit-testable without an Electron process
// (test/attention.test.js). Dependencies are read at event time, never captured at construction.

/**
 * @param {object} deps
 * @param {() => boolean} deps.isWindowFocused OS input focus of the MAIN Chat window.
 * @param {() => boolean} deps.getBlinkOnUnread FR-15 "Icon blinking" - governs blink AND flash.
 * @param {() => boolean} deps.getNotificationsMuted FR-12; also silences the flash (working
 *   assumption recorded in FR-14, pending maintainer confirmation).
 * @param {() => void} deps.startBlinking Tray blink start (trayBlink.startBlinking, idempotent).
 * @param {() => void} deps.stopBlinking Tray blink stop (trayBlink.stopBlinking, idempotent).
 * @param {(flag: boolean) => void} deps.flashFrame Taskbar flash request.
 */
function createAttentionController({
  isWindowFocused,
  getBlinkOnUnread,
  getNotificationsMuted,
  startBlinking,
  stopBlinking,
  flashFrame,
}) {
  let active = false;
  let lastUnreadCount = 0;

  const allowed = () => !isWindowFocused() && getBlinkOnUnread() && !getNotificationsMuted();

  function start() {
    // Both calls are idempotent by contract (trayBlink guards its single timer; a repeated
    // flashFrame(true) is one OS request that does not stack), so "already active" needs no
    // special case - and re-issuing them self-heals if something outside stopped one of the two.
    active = true;
    startBlinking();
    flashFrame(true);
  }

  function stop() {
    active = false;
    stopBlinking();
    flashFrame(false);
  }

  return {
    /** A new message arrived. */
    onArrival() {
      if (allowed()) start();
    },

    /**
     * The global unread count was observed (title change). 0 stops; an increase is treated as an
     * arrival (FR-14's acceptable degraded trigger); an unchanged or decreasing non-zero count
     * changes nothing.
     */
    onUnreadCount(n) {
      const count = Number.isFinite(n) && n > 0 ? n : 0;
      const previous = lastUnreadCount;
      lastUnreadCount = count;
      if (count === 0) {
        if (active) stop();
        return;
      }
      if (count > previous && allowed()) start();
    },

    /**
     * A settled count observation that must NEVER start anything: the post-load baseline, a
     * decrease, a confirmed zero (see unreadTracker.js). Keeps the tracked count in sync so the
     * next real increase (onUnreadCount) is measured against it; zero stops an active indicator.
     */
    observeUnreadCount(n) {
      lastUnreadCount = Number.isFinite(n) && n > 0 ? n : 0;
      if (lastUnreadCount === 0 && active) stop();
    },

    /** The main window gained OS input focus. */
    onFocus() {
      if (active) stop();
    },

    /** blinkOnUnread / notificationsMuted changed: stop if an indicator is now disallowed. */
    onSettingsChanged() {
      if (active && (!getBlinkOnUnread() || getNotificationsMuted())) stop();
    },

    /** Unconditional stop of both; safe when nothing is active. */
    stop,
  };
}

/**
 * bindWindowFocus(win, controller) - the window-event wiring, extracted from index.js's
 * unexported bootstrap() so it is testable. ONLY 'focus' is bound: 'show'/'restore' must not stop
 * the indicators (FR-14 stop trigger 1 is focus, not visibility).
 *
 * @param {{on: (event: string, listener: () => void) => unknown}} win A BrowserWindow (or stand-in).
 * @param {{onFocus: () => void}} controller
 */
function bindWindowFocus(win, controller) {
  win.on('focus', () => controller.onFocus());
}

module.exports = { createAttentionController, bindWindowFocus };
