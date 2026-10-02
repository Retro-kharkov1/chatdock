'use strict';

// UI-01 wiring checks on src/main/index.js (source-level, like the other *Wiring tests): the Electron
// bootstrap cannot run under `node --test`, so these pin the seams the architecture doc requires
// (docs/architecture/meet-call-window.md sections 1, 3, 8, 11; tray-lifecycle.md). They are deliberately
// loose regexes - they check that the seam is used, not how it is spelled.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');

test('wiring: no raw shell.openExternal(url) remains in index.js - every external link goes through the router (step 2, security fix)', () => {
  assert.equal(/shell\.openExternal\(\s*url\s*\)/.test(source), false);
});

test('wiring: the main window popup handler and will-navigate go through the link router', () => {
  assert.match(source, /createLinkRouter\(/);
  assert.match(source, /setWindowOpenHandler\([\s\S]{0,120}onWindowOpen/);
  assert.match(source, /onWindowOpen/);
  assert.match(source, /onWillNavigate/);
});

test('wiring: the router is built with the real call window opener and shell.openExternal', () => {
  assert.match(source, /require\(['"]\.\/linkRouter['"]\)/);
  assert.match(source, /require\(['"]\.\/callWindow['"]\)/);
  assert.match(source, /openCallWindow/);
  assert.match(source, /openExternal/);
});

test('wiring: the quit guard is created, the main window contents are guarded, and before-quit / will-quit feed it', () => {
  assert.match(source, /require\(['"]\.\/quitGuard['"]\)/);
  assert.match(source, /guardContents\(\s*mainWindow\.webContents\s*\)/);
  assert.match(source, /onBeforeQuit/);
  assert.match(source, /onWillQuit/);
  assert.match(source, /['"]will-quit['"]/);
});

test('wiring: before-quit never prevents the quit', () => {
  const block = /app\.on\(\s*['"]before-quit['"][\s\S]*?\n  \}\);/.exec(source);
  assert.ok(block, 'before-quit handler found');
  assert.equal(block[0].includes('preventDefault'), false);
});

test('wiring: the tray Exit goes through the call window exit rules, and "Show call window" is wired', () => {
  assert.match(source, /requestExit/);
  assert.match(source, /showCallWindow/);
});

test('wiring: the display-media handler is installed on the persistent session', () => {
  assert.match(source, /displayMediaHandler/);
});

test('wiring: window-all-closed still does not quit, and the application menu is still suppressed (existing guarantees)', () => {
  const block = /app\.on\(\s*['"]window-all-closed['"][\s\S]*?\n  \}\);/.exec(source);
  assert.ok(block);
  assert.equal(/app\.quit\(/.test(block[0].replace(/\/\/.*$/gm, '')), false);
  assert.match(source, /Menu\.setApplicationMenu\(\s*null\s*\)/);
});
