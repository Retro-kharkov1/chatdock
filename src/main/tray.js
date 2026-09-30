'use strict';

const path = require('path');
const { Tray, Menu, nativeImage } = require('electron');

// FR-06/07/08/10/11/12 (docs/architecture/tray-lifecycle.md) + the three tray icon states from
// assets/README.md ("What consumes what"). This module owns the Tray instance, its context menu,
// and the icon-state swap — the callbacks it invokes (show/hide, toggle start-at-login, toggle
// sound, toggle mute, exit) are supplied by index.js, which owns the actual app/window state.

const TRAY_DIR = path.join(__dirname, '../../assets/tray');

/**
 * trayIconPath(state) — resolves the tray glyph for a given state ('normal'|'unread'|'muted') per
 * assets/README.md: Windows gets the multi-res `.ico`; Linux (and anything else) gets the 24px
 * PNG, a common panel-tray size across GNOME/KDE. Windows does NOT use the unread tray glyph at
 * all — notifications.md's "Tray unread indicator" section reserves that signal for the taskbar
 * overlay badge on Windows instead (see `overlayIconPath` below); this function still resolves an
 * 'unread' path for Windows for completeness/symmetry, but index.js only requests it on Linux.
 */
function trayIconPath(state) {
  if (process.platform === 'win32') {
    return path.join(TRAY_DIR, `tray-${state}.ico`);
  }
  return path.join(TRAY_DIR, `tray-${state}-24.png`);
}

/** overlayIconPath(size) — Windows taskbar overlay badge assets (16/32px variants exist). */
function overlayIconPath(size) {
  return path.join(TRAY_DIR, `overlay-unread-${size}.png`);
}

/**
 * resolveIconState(unreadCount, muted) - which single glyph represents unread + mute.
 *
 * FR-05a / FR-12: the static unread indicator is visible whenever anything is unread, independent
 * of mute and of window focus - "muting silences notifications, it does not hide that messages
 * arrived". So unread wins over muted; the muted glyph shows only when nothing is unread. (This
 * reverses the earlier muted-first precedence, which hid unread messages on Linux where the tray
 * glyph is the only unread signal.) Blinking alternates 'unread'/'normal' and is never active
 * while muted, so there is no conflict with the mute glyph.
 */
function resolveIconState(unreadCount, muted) {
  if (unreadCount > 0) return 'unread';
  if (muted) return 'muted';
  return 'normal';
}

/**
 * createAppTray(options)
 *
 * Builds the Tray icon + FR-07's context menu (Show/Hide, Mute notifications, Settings…, Exit —
 * in that order) and wires left-click/double-click to mirror Show/Hide per NFR-01's Windows/Linux
 * convention. Returns a small controller the caller drives as state changes; this module holds no
 * app/window state of its own beyond the Tray instance and the currently-shown icon state.
 *
 * **Amended per FR-15/Wireframe F** (tray-lifecycle.md): Start at login and Notification sound are
 * no longer tray-menu checkboxes — they moved to the Settings window (FR-15). Mute notifications
 * is the only preference checkbox that stays on the tray, and a new "Settings…" entry opens the
 * Settings window.
 *
 * @param {object} options
 * @param {() => boolean} options.getNotificationsMuted
 * @param {() => string} options.getVersionLabel Owner request (2026-09-22): a disabled
 *   diagnostic line showing which build is actually running — see version.js's own doc comment
 *   for why a bare package.json version isn't enough.
 * @param {() => void} options.onToggleShowHide
 * @param {() => void} options.onToggleMute
 * @param {() => void} options.onOpenSettings Opens/focuses the Settings window (FR-15).
 * @param {() => void} options.onExit
 */
function createAppTray({
  getNotificationsMuted,
  getVersionLabel,
  onToggleShowHide,
  onToggleMute,
  onOpenSettings,
  onExit,
}) {
  let currentIconState = 'normal';
  const tray = new Tray(trayIconPath(currentIconState));
  tray.setToolTip('Google Chat Desktop');

  function buildMenu() {
    return Menu.buildFromTemplate([
      { label: 'Show/Hide Google Chat', click: () => onToggleShowHide() },
      { type: 'separator' },
      {
        label: 'Mute notifications',
        type: 'checkbox',
        checked: getNotificationsMuted(),
        click: () => onToggleMute(),
      },
      { type: 'separator' },
      { label: 'Settings…', click: () => onOpenSettings() },
      { type: 'separator' },
      // The only path that terminates the process — see the space's `quit-only-from-tray` rule.
      { label: 'Exit', click: () => onExit() },
      { type: 'separator' },
      // Owner request (2026-09-22): disabled/non-clickable diagnostic line, deliberately last and
      // visually de-emphasized — this is a diagnostic aid, not a feature, and must not compete
      // with the actual controls above it.
      { label: getVersionLabel(), enabled: false },
    ]);
  }

  function refreshMenu() {
    tray.setContextMenu(buildMenu());
  }

  refreshMenu();

  // NFR-01: left-click/double-click mirrors the Show/Hide menu entry on Windows/Linux.
  tray.on('click', () => onToggleShowHide());
  tray.on('double-click', () => onToggleShowHide());

  function setIconState(state) {
    if (state === currentIconState) return;
    currentIconState = state;
    tray.setImage(trayIconPath(state));
  }

  return { tray, refreshMenu, setIconState, resolveIconState };
}

/**
 * setUnreadOverlay(win, unreadCount) — Windows-only taskbar overlay badge on the main window
 * (notifications.md: "Windows carries the unread signal on the taskbar overlay instead"). No-op
 * on any other platform, where the tray glyph itself (see resolveIconState) is the signal.
 */
function setUnreadOverlay(win, unreadCount) {
  if (process.platform !== 'win32') return;
  if (win.isDestroyed()) return;
  if (unreadCount > 0) {
    win.setOverlayIcon(nativeImage.createFromPath(overlayIconPath(32)), 'Unread messages');
  } else {
    win.setOverlayIcon(null, '');
  }
}

module.exports = {
  createAppTray,
  trayIconPath,
  overlayIconPath,
  resolveIconState,
  setUnreadOverlay,
};
