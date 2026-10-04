'use strict';

// UI-04 wiring checks (source-level, like test/meetWiring.test.js): the Electron bootstrap cannot run under
// `node --test`, so these pin the seams docs/architecture/google-app-windows.md sections 5, 7, 8 require.
// Deliberately loose regexes: they check that the seam exists, not how it is spelled. RED until the modules
// and the index.js wiring exist.
//
// Covered rows: tray acts on the main window only; close never quits; no preload / no Electron import in the
// pure and injected modules; the download handler is registered once on the session; the call window keeps a
// router WITHOUT the Google collaborators (section 5: call window unchanged).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = path.join(__dirname, '..', 'src', 'main');
const read = (name) => fs.readFileSync(path.join(MAIN, name), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('wiring: index.js requires the new units (googleLink, googleAppWindow, downloads, mainWindowActions)', () => {
  const source = read('index.js');
  for (const mod of ['googleLink', 'googleAppWindow', 'downloads', 'mainWindowActions']) {
    assert.match(source, new RegExp(`require\\(['"]\\./${mod}['"]\\)`), mod);
  }
});

test('wiring: the main-window router is built with the Google collaborators', () => {
  const source = read('index.js');
  assert.match(source, /classifyGoogleLink/);
  assert.match(source, /classifyChatTarget/);
  assert.match(source, /openGoogleAppWindow/);
  assert.match(source, /openMainWindow/);
  assert.match(source, /focusMainWindow/);
  assert.match(source, /downloadInMainWindow/);
});

test('wiring: the call window keeps a router WITHOUT the Google collaborators (a different router than the main window)', () => {
  const source = read('index.js');
  const main = /setWindowOpenHandler\([\s\S]{0,200}?\b(\w+)\.onWindowOpen/.exec(source);
  const call = /getRouter:\s*\(\)\s*=>\s*(\w+)/.exec(source);
  assert.ok(main, 'main window popup handler goes through a router');
  assert.ok(call, 'call window manager receives a router');
  assert.notEqual(main[1], call[1]);
  assert.ok((source.match(/createLinkRouter\(/g) || []).length >= 2, 'two routers are built');
});

test('wiring: the Google app window factory gets isQuitting and the shared PARTITION constant, never a literal partition', () => {
  const source = read('index.js');
  const block = /createGoogleAppWindowManager\(\{[\s\S]*?\n  \}\);/.exec(source);
  assert.ok(block, 'createGoogleAppWindowManager call found');
  assert.match(block[0], /isQuitting/);
  assert.equal(/persist:/.test(block[0]), false);
});

test('wiring: the download handler is created once and registered on the session exactly once', () => {
  const source = read('index.js');
  assert.match(source, /createDownloadHandler\(/);
  assert.equal((source.match(/['"]will-download['"]/g) || []).length, 1);
});

test('wiring: the download handler is wired to the factory lookup and the empty-window auto-close', () => {
  const source = read('index.js');
  assert.match(source, /getAppWindowForContents/);
  assert.match(source, /closeEmptyWindow|closeIfEmpty/);
});

test('wiring: window-all-closed still does not quit (closing app windows never quits)', () => {
  const block = /app\.on\(\s*['"]window-all-closed['"][\s\S]*?\n  \}\);/.exec(read('index.js'));
  assert.ok(block);
  assert.equal(/app\.quit\(/.test(stripComments(block[0])), false);
});

test('tray: tray.js and trayMenu.js know nothing about app windows (Show/Hide act on the main window only)', () => {
  for (const file of ['tray.js', 'trayMenu.js']) {
    const code = stripComments(read(file));
    assert.equal(/googleApp|google-app|appWindow/i.test(code), false, file);
  }
});

test('googleAppWindow.js: no Electron import, no quit path, no hide, and no preload', () => {
  const code = stripComments(read('googleAppWindow.js'));
  assert.equal(/require\(['"]electron['"]\)/.test(code), false, 'collaborators are injected');
  assert.equal(/app\.quit|quitApp|\.quit\(/.test(code), false, 'close never quits');
  assert.equal(/\.hide\(/.test(code), false, 'close never hides');
  assert.equal(/\bpreload\b/.test(code), false, 'no preload key at all');
  assert.equal(/persist:google-chat/.test(code), false, 'PARTITION comes from session.js');
  assert.match(code, /require\(['"]\.\/session['"]\)/);
});

test('googleAppWindow.js: never calls loadFile or shows a local page (only Google urls are loaded)', () => {
  assert.equal(/loadFile/.test(stripComments(read('googleAppWindow.js'))), false);
});

test('googleLink.js: pure - no Electron import and no process / fs access', () => {
  const code = stripComments(read('googleLink.js'));
  assert.equal(/require\(['"](electron|fs|node:fs)['"]\)/.test(code), false);
});

test('linkRouter.js: still pure - no Electron import after the extension', () => {
  assert.equal(/require\(['"]electron['"]\)/.test(stripComments(read('linkRouter.js'))), false);
});

test('session.js: the permission handlers read the top-level origin for the new grants (embeddingOrigin on the check path)', () => {
  const code = stripComments(read('session.js'));
  assert.match(code, /embeddingOrigin/);
  assert.match(code, /GOOGLE_APP_CLIPBOARD_FULLSCREEN_ORIGINS/);
});

test('ipc contract: no new IPC channel and no preload entry for the app windows (preload files do not mention them)', () => {
  for (const file of ['preload.js', 'settingsPreload.js', 'pickerPreload.js']) {
    const code = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', file), 'utf8'));
    assert.equal(/google-?app|googleApp/i.test(code), false, file);
  }
});
