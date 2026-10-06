'use strict';

// UI-06 wiring checks on src/main/index.js (source-level, like the other *Wiring tests).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const index = read('src', 'main', 'index.js');

test('wiring: one Help controller, loading the generated help.html, sharing the system-browser opener and scheme allow-list', () => {
  assert.match(index, /require\('\.\/helpWindow'\)/);
  assert.equal((index.match(/createHelpWindowController\(/g) || []).length, 1);
  assert.match(index, /renderer\/help\/help\.html/);
  assert.match(index, /openExternal:\s*\(target\) => openInSystemBrowser\(target\)/);
  assert.match(index, /isOpenableExternalScheme,/);
});

test('wiring: the tray Help entry and the Settings channel both call helpWindow.open()', () => {
  assert.match(index, /onOpenHelp:\s*\(\) => \{\s*helpWindow\.open\(\);/);
  assert.match(index, /openHelp:\s*\(\) => helpWindow\.open\(\)/);
});

test('wiring: the Help window gets no preload and no IPC channel of its own', () => {
  const src = read('src', 'main', 'helpWindow.js');
  assert.doesNotMatch(src, /preload\s*:/);
  assert.doesNotMatch(src, /ipcMain|require\('electron'\)|app\.quit|\.quit\(/);
});

test('wiring: the tray module passes onOpenHelp through to the menu template', () => {
  const tray = read('src', 'main', 'tray.js');
  assert.match(tray, /onOpenHelp,\s*\n\s*onExit/);
});
