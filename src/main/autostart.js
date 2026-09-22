'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// FR-10 — start at OS login. Per tray-lifecycle.md: Windows uses Electron's native
// `app.setLoginItemSettings`; Linux has no Electron API for this and gets a hand-written XDG
// autostart `.desktop` file instead. Both branches always read back the actual OS-level state
// rather than trusting a cached preference, per FR-10's explicit requirement that the tray
// checkbox "reflects the actual current OS-level state, not just an in-app preference that could
// drift from reality."
//
// The `--hidden` launch flag (read in index.js) is what makes FR-10's third scenario ("the
// application launches directly into the tray, window hidden, not forced open") work: both
// branches below arrange for the OS to invoke the app with that flag when auto-launching it.

function linuxAutostartPath() {
  return path.join(os.homedir(), '.config', 'autostart', 'google-chat-desktop.desktop');
}

/**
 * getStartAtLogin() — reads the actual OS-level state. `false` on any platform this app doesn't
 * implement the mechanism for (there is none left in scope — Windows and Linux are both covered).
 */
function getStartAtLogin() {
  if (process.platform === 'win32') {
    const { app } = require('electron');
    return app.getLoginItemSettings().openAtLogin;
  }
  if (process.platform === 'linux') {
    return fs.existsSync(linuxAutostartPath());
  }
  return false;
}

/**
 * setStartAtLogin(enabled) — writes the OS-level state.
 *
 * Both branches account for the dev-vs-packaged pitfall named in `electron-desktop.md` §10: in a
 * packaged build `process.execPath` IS the app's own binary and needs no extra argument; in dev,
 * `process.execPath` is the `electron.exe`/`electron` binary itself, which needs the app
 * directory as its first argument to know what to launch. Getting this wrong means "Start at
 * login" silently does nothing (or launches bare Electron with no app) the next time the OS logs
 * the user in — a failure mode that would not show up until the *next* login, long after this was
 * tested.
 */
function setStartAtLogin(enabled) {
  if (process.platform === 'win32') {
    const { app } = require('electron');
    const args = app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: enabled ? args : [],
    });
    return;
  }
  if (process.platform === 'linux') {
    const { app } = require('electron');
    const filePath = linuxAutostartPath();
    if (enabled) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const execLine = app.isPackaged
        ? `"${process.execPath}" --hidden`
        : `"${process.execPath}" "${app.getAppPath()}" --hidden`;
      const contents = [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Google Chat Desktop',
        `Exec=${execLine}`,
        'Terminal=false',
        'X-GNOME-Autostart-enabled=true',
        '',
      ].join('\n');
      fs.writeFileSync(filePath, contents, 'utf8');
    } else if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return;
  }
  // No-op elsewhere — macOS is out of scope (ADR-0003) and no other platform is targeted.
}

module.exports = { getStartAtLogin, setStartAtLogin, linuxAutostartPath };
