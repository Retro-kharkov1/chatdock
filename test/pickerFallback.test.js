'use strict';

// BUG-08: pages of the shared session lose the File System Access pickers (showOpenFilePicker, showSaveFilePicker,
// showDirectoryPicker) so they use the plain <input type="file"> chooser. See src/preload/pickerFallback.js and
// docs/architecture/file-access.md for the evidence (Docker/Linux, Electron 44.4.3).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'pickerFallback.js');
const { configurePersistentSession, PICKER_FALLBACK_PRELOAD } = require('../src/main/session.js');

/** Loads the preload with a fake `electron` whose webFrame.executeJavaScript is `exec`. */
function loadPreload(exec) {
  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return { webFrame: { executeJavaScript: exec } };
    return realLoad.call(this, request, ...rest);
  };
  delete require.cache[PRELOAD];
  try {
    return require(PRELOAD);
  } finally {
    Module._load = realLoad;
    delete require.cache[PRELOAD];
  }
}

test('the preload runs one script in the page world and it deletes exactly the three pickers', () => {
  const ran = [];
  const { REMOVE_PICKERS_SCRIPT } = loadPreload((code) => {
    ran.push(code);
    return Promise.resolve();
  });
  assert.equal(ran.length, 1);
  assert.equal(ran[0], REMOVE_PICKERS_SCRIPT);

  const win = {
    showOpenFilePicker() {},
    showSaveFilePicker() {},
    showDirectoryPicker() {},
    showModalDialog: 1,
    fetch() {},
    Notification: function Notification() {},
  };
  win.window = win;
  vm.runInNewContext(REMOVE_PICKERS_SCRIPT, win);
  for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
    assert.equal(name in win, false, `${name} removed (feature detection with "in" must see it gone)`);
    assert.equal(typeof win[name], 'undefined');
  }
  assert.equal(typeof win.fetch, 'function', 'everything else is untouched');
  assert.equal(typeof win.Notification, 'function');
  assert.equal(win.showModalDialog, 1);
});

test('the script does not throw when a picker is missing or not deletable', () => {
  const { REMOVE_PICKERS_SCRIPT } = loadPreload(() => Promise.resolve());
  const win = {};
  win.window = win;
  Object.defineProperty(win, 'showOpenFilePicker', { value: () => {}, configurable: false });
  assert.doesNotThrow(() => vm.runInNewContext(REMOVE_PICKERS_SCRIPT, win));
});

test('the preload never disturbs the page: a throwing or rejecting executeJavaScript is swallowed', () => {
  assert.doesNotThrow(() => loadPreload(() => { throw new Error('boom'); }));
  assert.doesNotThrow(() => loadPreload(() => Promise.reject(new Error('nope'))));
});

test('the preload exposes nothing: no contextBridge, no ipcRenderer, only webFrame is required from electron', () => {
  const src = fs
    .readFileSync(PRELOAD, 'utf8')
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('//'))
    .join(' ');
  assert.doesNotMatch(src, /contextBridge|ipcRenderer|exposeInMainWorld|sendSync/);
  assert.match(src, /const \{ webFrame \} = require\('electron'\)/);
});

test('session: the preload is registered once, as a frame preload, and the file exists', () => {
  const calls = [];
  configurePersistentSession(
    {
      setUserAgent: () => {},
      setPermissionRequestHandler: () => {},
      setPermissionCheckHandler: () => {},
      registerPreloadScript: (reg) => { calls.push(reg); return 'id'; },
    },
    { notificationOrigins: ['https://chat.google.com'] }
  );
  assert.deepEqual(calls, [{ type: 'frame', filePath: PICKER_FALLBACK_PRELOAD }]);
  assert.ok(path.isAbsolute(PICKER_FALLBACK_PRELOAD));
  assert.equal(path.resolve(PICKER_FALLBACK_PRELOAD), path.resolve(PRELOAD));
  assert.ok(fs.existsSync(PICKER_FALLBACK_PRELOAD));
});

test('session: a session object without registerPreloadScript is tolerated', () => {
  assert.doesNotThrow(() =>
    configurePersistentSession(
      { setUserAgent: () => {}, setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} },
      { notificationOrigins: [] }
    )
  );
});
