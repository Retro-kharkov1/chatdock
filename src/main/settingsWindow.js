'use strict';

const path = require('path');

// FR-15, docs/architecture/tray-lifecycle.md "Settings window (FR-15)" / "Process model". A
// second `BrowserWindow`, constructed on demand from the tray's "Settings…" entry only — no
// native application-menu entry point exists (see index.js's `Menu.setApplicationMenu(null)` and
// docs/design/00-settings-surface-spec.md §2's "Decided: no native OS application menu entry
// point"). Loads a local bundled HTML document only, with its own preload
// (src/preload/settingsPreload.js) — never the main window's preload.js — per the security
// boundary tray-lifecycle.md's "Process model" section requires.

/** @type {Electron.BrowserWindow | null} */
let settingsWindowInstance = null;

// BUG-06: the window height follows the content height measured in the renderer (a ResizeObserver
// on #app -> this one-way channel). Root cause of the bug: a fixed 380x460 OUTER window; content
// that grows past 460 minus the title bar made Chromium draw a vertical scrollbar.
const SETTINGS_RESIZE_CHANNEL = 'settings:content-height';
// UI-06: one-way, payload-free: the Settings "Help" link asks main to open the Help window.
const SETTINGS_OPEN_HELP_CHANNEL = 'settings:open-help';
/** If the renderer never reports a height (failed load), show the window anyway after this long. */
const SHOW_FALLBACK_MS = 2000;
const MIN_CONTENT_HEIGHT = 120;

/** Whether the window has been sized to its content yet (first fit also centers it). */
let hasFitted = false;
let lastContentHeight = null;
let fallbackTimer = null;
let fallbackTimers = null;

/**
 * fitContentHeight(requested, { chromeHeight, workAreaHeight }) -> integer content height, or null
 * if `requested` is not a finite positive number. Clamped to the work area minus the window
 * chrome; only content taller than that may scroll.
 */
function fitContentHeight(requested, { chromeHeight, workAreaHeight }) {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) return null;
  const max = Math.max(MIN_CONTENT_HEIGHT, workAreaHeight - chromeHeight);
  return Math.min(Math.max(Math.ceil(requested), MIN_CONTENT_HEIGHT), max);
}

/**
 * computeBounds -> new OUTER bounds: width and x unchanged, height = content + chrome, top edge
 * kept unless the bottom would leave the work area (then moved up, never above the work area top).
 */
function computeBounds({ bounds, contentHeight, chromeHeight, workArea }) {
  const height = contentHeight + chromeHeight;
  let y = bounds.y;
  if (y + height > workArea.y + workArea.height) y = workArea.y + workArea.height - height;
  if (y < workArea.y) y = workArea.y;
  return { x: bounds.x, y, width: bounds.width, height };
}

function handleContentHeight(event, requested, { screen }) {
  const win = settingsWindowInstance;
  if (!win || win.isDestroyed()) return;
  if (!event || !event.sender || event.sender.id !== win.webContents.id) return;

  const bounds = win.getBounds();
  const chromeHeight = Math.max(0, bounds.height - win.getContentBounds().height);
  const workArea = screen.getDisplayMatching(bounds).workArea;
  const contentHeight = fitContentHeight(requested, { chromeHeight, workAreaHeight: workArea.height });
  if (contentHeight === null) return;

  if (contentHeight !== lastContentHeight) {
    lastContentHeight = contentHeight;
    win.setBounds(computeBounds({ bounds, contentHeight, chromeHeight, workArea }));
  }
  if (!hasFitted) {
    hasFitted = true;
    win.center();
    // center() keeps the size; the bounds above already carry the final height. Re-clamp is
    // unnecessary: centering inside the display's work area cannot push the window off-screen.
  }
  if (!win.isVisible()) win.show();
}

/** UI-06: accepted only from the open Settings window's own webContents; any payload is ignored. */
function handleOpenHelp(event, { openHelp }) {
  const win = settingsWindowInstance;
  if (!win || win.isDestroyed()) return;
  if (!event || !event.sender || event.sender.id !== win.webContents.id) return;
  if (typeof openHelp === 'function') openHelp();
}

/** registerSettingsWindowIpc(ipcMain, { screen, openHelp }) — one-way, validated, sender-checked. */
function registerSettingsWindowIpc(ipcMain, { screen, openHelp }) {
  ipcMain.on(SETTINGS_RESIZE_CHANNEL, (event, requested) =>
    handleContentHeight(event, requested, { screen })
  );
  ipcMain.on(SETTINGS_OPEN_HELP_CHANNEL, (event) => handleOpenHelp(event, { openHelp }));
}

/**
 * getSettingsWindow() — returns the currently open Settings window instance, or `null` if none is
 * open. Used by settingsStore.js's `getSettingsWindow` dependency for the `settings:changed`
 * broadcast (echo-loop prevention).
 */
function getSettingsWindow() {
  return settingsWindowInstance;
}

/**
 * openSettingsWindow({ appIconPath })
 *
 * Design spec §1 "Instancing": a second "Settings…" invocation while one instance is already
 * alive focuses that existing window rather than opening a duplicate. Design spec §1 "Closing the
 * window destroys it": no `close` handler intercepts the default close behavior here (unlike the
 * main window's `isQuitting`-gated hide) — a real close destroys the `BrowserWindow`, and the
 * `closed` listener below is only bookkeeping (nulling the module's own reference), not a
 * lifecycle override. This does not affect `isQuitting` and cannot quit the app — the window has
 * no in-page Exit control (project rule "Quit only from the tray", docs/architecture/project-rules.md).
 *
 * @param {object} options
 * @param {string} [options.appIconPath] Optional window icon path.
 * @returns {Electron.BrowserWindow} The (possibly pre-existing, focused) Settings window.
 */
function openSettingsWindow({ appIconPath, electron = require('electron'), timers = globalThis } = {}) {
  const { BrowserWindow } = electron;

  if (settingsWindowInstance && !settingsWindowInstance.isDestroyed()) {
    settingsWindowInstance.focus();
    return settingsWindowInstance;
  }

  settingsWindowInstance = new BrowserWindow({
    title: 'Google Chat Desktop — Settings',
    width: 380,
    height: 460,
    show: false, // sized to its content first, shown on the first height report (no jump on open)
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    icon: appIconPath,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, '../preload/settingsPreload.js'),
    },
  });

  // Belt-and-suspenders: the app-wide Menu.setApplicationMenu(null) in index.js already means no
  // window gets a menu bar, but explicitly denying one on this window too costs nothing and keeps
  // this window's security posture legible on its own, independent of index.js's global call.
  settingsWindowInstance.setMenu(null);

  settingsWindowInstance.loadFile(path.join(__dirname, '../renderer/settings.html'));

  hasFitted = false;
  lastContentHeight = null;
  fallbackTimers = timers;
  fallbackTimer = timers.setTimeout(() => {
    fallbackTimer = null;
    const w = settingsWindowInstance;
    if (w && !w.isDestroyed() && !w.isVisible()) w.show();
  }, SHOW_FALLBACK_MS);

  settingsWindowInstance.on('closed', () => {
    if (fallbackTimer !== null) fallbackTimers.clearTimeout(fallbackTimer);
    fallbackTimer = null;
    settingsWindowInstance = null;
  });

  return settingsWindowInstance;
}

module.exports = {
  openSettingsWindow,
  getSettingsWindow,
  registerSettingsWindowIpc,
  fitContentHeight,
  computeBounds,
  SETTINGS_RESIZE_CHANNEL,
  SETTINGS_OPEN_HELP_CHANNEL,
  SHOW_FALLBACK_MS,
};
