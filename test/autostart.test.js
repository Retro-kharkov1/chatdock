'use strict';

// Start-at-login root-cause regression (BUG: "Couldn't change Start at login — Windows didn't
// apply the change" on the installed 0.0.1-61 build).
//
// Root cause: setStartAtLogin registered the Run entry with `args: ['--hidden']`, but the read-back
// called `app.getLoginItemSettings()` with NO options. Electron compares the registry value against
// `"<exePath>"` + the args it is asked about, so the bare read never matches an entry that carries
// `--hidden` and reports openAtLogin:false even though the write succeeded. Every enable therefore
// failed the read-back check. Set and get must use the exact same { path, args, name }.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  windowsLoginItemOptions,
  isStartupApprovedDisabled,
  readWindowsStartAtLogin,
  linuxExecLine,
} = require('../src/main/autostart.js');

const PACKAGED = {
  isPackaged: true,
  execPath: 'C:\\Program Files\\Google Chat Desktop\\Google Chat Desktop.exe',
  appPath: 'C:\\Program Files\\Google Chat Desktop\\resources\\app.asar',
  name: 'dev.retro-kharkov1.google-chat-desktop',
};

test('packaged Windows options: exe path, --hidden only, explicit Run-key name', () => {
  assert.deepEqual(windowsLoginItemOptions(PACKAGED), {
    path: PACKAGED.execPath,
    args: ['--hidden'],
    name: PACKAGED.name,
  });
});

test('dev Windows options: app directory comes first so electron.exe launches the app', () => {
  const o = windowsLoginItemOptions({ ...PACKAGED, isPackaged: false, name: PACKAGED.name + '.dev' });
  assert.deepEqual(o.args, [PACKAGED.appPath, '--hidden']);
  assert.equal(o.name, PACKAGED.name + '.dev');
});

test('REGRESSION: the read-back passes the SAME options that were written (incl. --hidden args)', () => {
  const options = windowsLoginItemOptions(PACKAGED);
  let seen;
  // Fake that behaves like Electron: only reports openAtLogin when asked with the written args.
  const getLoginItemSettings = (opts) => {
    seen = opts;
    const matches = opts && JSON.stringify(opts.args) === JSON.stringify(['--hidden']);
    return { openAtLogin: Boolean(matches) };
  };
  const on = readWindowsStartAtLogin({ getLoginItemSettings, queryStartupApproved: () => null, options });
  assert.equal(on, true);
  assert.deepEqual(seen, options);
});

test('isStartupApprovedDisabled: Task Manager "Disabled" (first byte odd) is detected', () => {
  const disabled = '\r\nHKEY_CURRENT_USER\\...\\StartupApproved\\Run\r\n    x    REG_BINARY    030000000000000000000000\r\n';
  const enabled = '\r\nHKEY_CURRENT_USER\\...\\StartupApproved\\Run\r\n    x    REG_BINARY    020000000000000000000000\r\n';
  const enabled6 = '    x    REG_BINARY    060000000000000000000000';
  assert.equal(isStartupApprovedDisabled(disabled), true);
  assert.equal(isStartupApprovedDisabled(enabled), false);
  assert.equal(isStartupApprovedDisabled(enabled6), false);
  assert.equal(isStartupApprovedDisabled(null), false); // no StartupApproved value = enabled
  assert.equal(isStartupApprovedDisabled('garbage'), false);
});

test('an entry the user disabled in Task Manager reads as OFF (true state, not an error)', () => {
  const options = windowsLoginItemOptions(PACKAGED);
  const on = readWindowsStartAtLogin({
    getLoginItemSettings: () => ({ openAtLogin: true }),
    queryStartupApproved: () => '    x    REG_BINARY    030000000000000000000000',
    options,
  });
  assert.equal(on, false);
});

test('no Run entry reads as OFF even when StartupApproved is enabled', () => {
  const on = readWindowsStartAtLogin({
    getLoginItemSettings: () => ({ openAtLogin: false }),
    queryStartupApproved: () => '    x    REG_BINARY    020000000000000000000000',
    options: windowsLoginItemOptions(PACKAGED),
  });
  assert.equal(on, false);
});

test('a failing StartupApproved query falls back to the Run-entry answer', () => {
  const on = readWindowsStartAtLogin({
    getLoginItemSettings: () => ({ openAtLogin: true }),
    queryStartupApproved: () => { throw new Error('reg.exe missing'); },
    options: windowsLoginItemOptions(PACKAGED),
  });
  assert.equal(on, true);
});

test('Linux Exec line: packaged deb uses the installed binary', () => {
  assert.equal(
    linuxExecLine({ isPackaged: true, execPath: '/opt/GoogleChatDesktop/google-chat-desktop', appPath: '/x', appImage: undefined }),
    '"/opt/GoogleChatDesktop/google-chat-desktop" --hidden',
  );
});

test('Linux Exec line: an AppImage run registers the stable $APPIMAGE path, not the temp mount', () => {
  assert.equal(
    linuxExecLine({ isPackaged: true, execPath: '/tmp/.mount_abc/google-chat-desktop', appPath: '/x', appImage: '/home/u/GCD.AppImage' }),
    '"/home/u/GCD.AppImage" --hidden',
  );
});

test('Linux Exec line: dev run passes the app directory', () => {
  assert.equal(
    linuxExecLine({ isPackaged: false, execPath: '/n/electron', appPath: '/repo', appImage: undefined }),
    '"/n/electron" "/repo" --hidden',
  );
});
