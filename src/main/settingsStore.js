'use strict';

const fs = require('fs');
const path = require('path');
const realAutostart = require('./autostart');

// FR-10/FR-11/FR-12/FR-14, docs/architecture/tray-lifecycle.md "Single source of truth". This
// module is the single read/write authority for all four persisted preferences — the only code
// path allowed to write `settings.json` or call the OS login-item API is `applySetting`, which is
// what makes the tray<->Settings-window Mute sync (and the blink-stop side effects) possible
// without a second writer ever drifting out of consistency with the first.

const DEFAULTS = Object.freeze({
  startAtLogin: false,
  soundEnabled: true,
  notificationsMuted: false,
  blinkOnUnread: true,
});

/**
 * getSettingsPath() — resolves `settings.json`'s location under Electron's own `userData`
 * directory. Requires `electron` lazily so this module stays requirable under plain `node:test`.
 */
function getSettingsPath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'settings.json');
}

/**
 * loadPersistedSettings(filePath) — never throws: a missing file (first launch), corrupt JSON, or
 * a field of the wrong type all fall back to DEFAULTS for that field, same "never trust persisted
 * data blindly" posture window-state.js's resolveWindowState takes for its own saved state.
 */
function loadPersistedSettings(filePath) {
  const result = { ...DEFAULTS };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof parsed[key] === 'boolean') result[key] = parsed[key];
    }
  } catch {
    // missing/corrupt file — defaults already in `result`.
  }
  return result;
}

/** persist(filePath, state) — best-effort write; logged, never thrown (an always-on tray app must
 * not crash over a failed preference write). */
function persist(filePath, state) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('[gcd] failed to persist settings.json', err);
  }
}

/**
 * platformStartAtLoginFailureMessage() — the design spec's (00-settings-surface-spec.md §5/§6)
 * platform-specific inline error text for a failed Start at login change.
 */
function platformStartAtLoginFailureMessage() {
  if (process.platform === 'linux') {
    return "Couldn't enable Start at login — couldn't write to the autostart folder.";
  }
  return "Couldn't change Start at login — Windows didn't apply the change.";
}

/**
 * createSettingsStore(options)
 *
 * @param {object} options
 * @param {string} options.settingsPath Where `settings.json` lives (see getSettingsPath()).
 * @param {() => ({refreshMenu: () => void})|undefined} [options.getTrayController] Returns the
 *   live tray controller (see tray.js), if the tray has been created yet, so a `notificationsMuted`
 *   change can refresh the tray menu's checkbox (which reads its `checked` state live on every
 *   `refreshMenu()` call — no separate MenuItem handle needed).
 * @param {() => ({stopBlinking: () => void})|undefined} [options.getTrayBlink] Returns the
 *   trayBlink module/controller, so a mute-on or blink-off change can stop an active blink
 *   immediately (tray-lifecycle.md "Interaction with Settings/tray toggles").
 * @param {() => (Electron.BrowserWindow|null)} [options.getSettingsWindow] Returns the currently
 *   open Settings window, or null/undefined if none is open, for the `settings:changed` broadcast.
 * @returns {{get, getAll, applySetting}}
 */
function createSettingsStore({
  settingsPath,
  getTrayController,
  getTrayBlink,
  getSettingsWindow,
  autostart = { get: realAutostart.getStartAtLogin, set: realAutostart.setStartAtLogin },
  enableStartAtLoginOnFirstRun = false,
} = {}) {
  const getStartAtLogin = autostart.get;
  const setStartAtLogin = autostart.set;
  // First run = no settings.json yet. Any existing file (even one from an older version) means the
  // user has already been through this app, so nothing is ever force-enabled over their choice.
  const isFirstRun = !fs.existsSync(settingsPath);
  const state = loadPersistedSettings(settingsPath);

  // Owner decision 2026-09-30: after a fresh install everything is ON (sound and blink are already
  // ON in DEFAULTS; mute stays OFF because "on" would silence the app), so Start at login is enabled
  // once, here. Runs at most once: the file written below makes every later launch a non-first run,
  // which also means an entry the user disables (Settings switch or Task Manager) stays disabled.
  // Opt-in via the flag so dev/unpackaged runs never register electron.exe as a login item.
  if (isFirstRun && enableStartAtLoginOnFirstRun) {
    try {
      setStartAtLogin(true);
    } catch (err) {
      console.error('[gcd] first-run Start at login could not be enabled', err);
    }
    try {
      state.startAtLogin = getStartAtLogin();
    } catch {
      // keep the default; the live value is re-derived below anyway.
    }
    persist(settingsPath, state);
  }

  // `startAtLogin` is always re-derived from the live OS state at construction time — never
  // trusted from the cached settings.json copy, per FR-10's "reflects actual current OS-level
  // state" rule. A failure here (e.g. not running under real Electron) leaves the cached/default
  // value in place rather than crashing store construction.
  try {
    state.startAtLogin = getStartAtLogin();
  } catch {
    // leave state.startAtLogin as loaded/defaulted above.
  }

  function get(key) {
    return state[key];
  }

  /**
   * getAll() — re-reads `startAtLogin` live from the OS on every call (design spec §3: "never
   * trusted from a cached preference") rather than returning the possibly-stale in-memory copy;
   * the other three keys have no such divergence risk and come straight from in-memory state.
   */
  function getAll() {
    let startAtLogin = state.startAtLogin;
    try {
      startAtLogin = getStartAtLogin();
    } catch {
      // OS read genuinely unavailable — fall back to the last-known value.
    }
    return { ...state, startAtLogin };
  }

  /**
   * applySetting(key, value, { originSenderId })
   *
   * The single mutation entry point (tray-lifecycle.md "Single source of truth"). Called from
   * exactly two places in the running app: the tray menu's Mute checkbox click handler (no
   * `originSenderId` — a tray-originated change is always broadcast to an open Settings window)
   * and the `settings:set` IPC handler (passes `event.sender.id` as `originSenderId`, so the
   * Settings window that just made the change doesn't receive its own change back — echo-loop
   * prevention per tray-lifecycle.md).
   *
   * @param {string} key One of DEFAULTS' keys.
   * @param {boolean} value
   * @param {{originSenderId?: number}} [opts]
   * @returns {Promise<{ok: true, value: boolean}|{ok: false, message: string}>}
   */
  async function applySetting(key, value, opts = {}) {
    const { originSenderId } = opts;

    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
      return { ok: false, message: `Unknown setting: ${key}` };
    }
    if (typeof value !== 'boolean') {
      return { ok: false, message: `Invalid value for ${key}: expected a boolean` };
    }

    if (key === 'startAtLogin') {
      try {
        setStartAtLogin(value);
        const readBack = getStartAtLogin();
        if (readBack !== value) {
          return { ok: false, message: platformStartAtLoginFailureMessage() };
        }
      } catch {
        return { ok: false, message: platformStartAtLoginFailureMessage() };
      }
    }

    state[key] = value;
    persist(settingsPath, state);

    // --- Side effects (tray-lifecycle.md "Single source of truth") -----------------------------
    if (key === 'notificationsMuted') {
      const trayController = getTrayController && getTrayController();
      if (trayController) trayController.refreshMenu();
    }
    if (
      (key === 'notificationsMuted' && value === true) ||
      (key === 'blinkOnUnread' && value === false)
    ) {
      const trayBlink = getTrayBlink && getTrayBlink();
      if (trayBlink) trayBlink.stopBlinking();
    }

    const settingsWindow = getSettingsWindow && getSettingsWindow();
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      const targetId = settingsWindow.webContents.id;
      if (originSenderId === undefined || originSenderId !== targetId) {
        settingsWindow.webContents.send('settings:changed', { key, value });
      }
    }

    return { ok: true, value };
  }

  return { get, getAll, applySetting };
}

module.exports = { DEFAULTS, getSettingsPath, createSettingsStore };
