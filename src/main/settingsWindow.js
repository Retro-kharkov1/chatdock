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
function openSettingsWindow({ appIconPath } = {}) {
  const { BrowserWindow } = require('electron');

  if (settingsWindowInstance && !settingsWindowInstance.isDestroyed()) {
    settingsWindowInstance.focus();
    return settingsWindowInstance;
  }

  settingsWindowInstance = new BrowserWindow({
    title: 'Google Chat Desktop — Settings',
    width: 380,
    height: 460,
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

  settingsWindowInstance.on('closed', () => {
    settingsWindowInstance = null;
  });

  return settingsWindowInstance;
}

module.exports = { openSettingsWindow, getSettingsWindow };
