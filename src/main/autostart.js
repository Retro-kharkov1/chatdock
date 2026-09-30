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

const STARTUP_APPROVED_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';

/**
 * windowsLoginItemOptions() - the ONE set of { path, args, name } used for BOTH the write and the
 * read-back. Electron decides `openAtLogin` by comparing the registry Run value with
 * `"<path>" <args>`, so a read-back that omits the `--hidden` the write added never matches and
 * reports false although the write succeeded. That mismatch was the "Couldn't change Start at
 * login - Windows didn't apply the change" bug. `name` is pinned to the AppUserModelID (Electron's
 * own default) so the Run value name and the StartupApproved lookup can never disagree.
 */
function windowsLoginItemOptions({ isPackaged, execPath, appPath, name }) {
  return {
    path: execPath,
    args: isPackaged ? ['--hidden'] : [appPath, '--hidden'],
    name,
  };
}

/**
 * isStartupApprovedDisabled(regQueryOutput) - Windows keeps the Task Manager "Startup apps"
 * Enabled/Disabled switch in HKCU\...\Explorer\StartupApproved\Run as a REG_BINARY whose first
 * byte has bit 0 set when the user disabled the entry (0x02/0x06 enabled, 0x03 disabled). No value
 * at all means enabled.
 */
function isStartupApprovedDisabled(regQueryOutput) {
  if (typeof regQueryOutput !== 'string') return false;
  const m = /REG_BINARY\s+([0-9A-Fa-f]{2})/.exec(regQueryOutput);
  if (!m) return false;
  return (parseInt(m[1], 16) & 1) === 1;
}

/**
 * readWindowsStartAtLogin() - the true OS-level state: the Run entry exists (with the exact
 * registered command) AND the user has not switched it off in Task Manager. A user-disabled entry
 * is a legitimate state to report as OFF, not a failure.
 */
function readWindowsStartAtLogin({ getLoginItemSettings, queryStartupApproved, options }) {
  if (!getLoginItemSettings(options).openAtLogin) return false;
  try {
    return !isStartupApprovedDisabled(queryStartupApproved(options.name));
  } catch {
    return true; // cannot read the approval flag - trust the Run entry.
  }
}

function queryStartupApprovedViaReg(name) {
  const { execFileSync } = require('child_process');
  try {
    return execFileSync('reg', ['query', STARTUP_APPROVED_KEY, '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null; // reg.exe exits 1 when the value does not exist = enabled.
  }
}

function currentWindowsOptions() {
  const { app } = require('electron');
  const { resolveAppUserModelId } = require('./appIdentity');
  return windowsLoginItemOptions({
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    appPath: app.getAppPath(),
    name: resolveAppUserModelId({ isPackaged: app.isPackaged }),
  });
}

/**
 * linuxExecLine() - inside an AppImage `process.execPath` is a temporary mount that vanishes on
 * exit, so the stable `$APPIMAGE` path must be registered instead. In dev, execPath is the bare
 * electron binary and needs the app directory.
 */
function linuxExecLine({ isPackaged, execPath, appPath, appImage }) {
  if (isPackaged) return `"${appImage || execPath}" --hidden`;
  return `"${execPath}" "${appPath}" --hidden`;
}

/**
 * getStartAtLogin() - reads the actual OS-level state. `false` on any platform this app doesn't
 * implement the mechanism for.
 */
function getStartAtLogin() {
  if (process.platform === 'win32') {
    const { app } = require('electron');
    return readWindowsStartAtLogin({
      getLoginItemSettings: (o) => app.getLoginItemSettings(o),
      queryStartupApproved: queryStartupApprovedViaReg,
      options: currentWindowsOptions(),
    });
  }
  if (process.platform === 'linux') {
    return fs.existsSync(linuxAutostartPath());
  }
  return false;
}

/**
 * setStartAtLogin(enabled) - writes the OS-level state (dev-vs-packaged launch command handled in
 * windowsLoginItemOptions / linuxExecLine). Electron's set also clears a Task Manager "Disabled"
 * flag, so turning the switch ON again after the user disabled it re-enables the entry.
 */
function setStartAtLogin(enabled) {
  if (process.platform === 'win32') {
    const { app } = require('electron');
    app.setLoginItemSettings({ openAtLogin: enabled, ...currentWindowsOptions() });
    return;
  }
  if (process.platform === 'linux') {
    const { app } = require('electron');
    const filePath = linuxAutostartPath();
    if (enabled) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const execLine = linuxExecLine({
        isPackaged: app.isPackaged,
        execPath: process.execPath,
        appPath: app.getAppPath(),
        appImage: process.env.APPIMAGE,
      });
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
  // No-op elsewhere - macOS is out of scope (ADR-0003) and no other platform is targeted.
}

module.exports = {
  getStartAtLogin,
  setStartAtLogin,
  linuxAutostartPath,
  windowsLoginItemOptions,
  isStartupApprovedDisabled,
  readWindowsStartAtLogin,
  linuxExecLine,
};
