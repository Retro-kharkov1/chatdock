'use strict';

// UI-01 tray menu content: P3 "Show call window" (docs/architecture/tray-lifecycle.md "Tray icon and
// context menu"; docs/design/06-meet-native-wording.md section 3). RED until src/main/trayMenu.js
// exists.
//
// Why a new module: src/main/tray.js requires `electron` at load time, so its menu cannot be built
// under plain `node --test`. The menu TEMPLATE is extracted as a pure function and tray.js's
// buildMenu() becomes `Menu.buildFromTemplate(buildTrayMenuTemplate({ ...callbacks }))`.
//
//   src/main/trayMenu.js
//   buildTrayMenuTemplate({ getNotificationsMuted, getVersionLabel, hasCallWindow, onShowCallWindow,
//                           onToggleShowHide, onToggleMute, onOpenSettings, onExit })
//     -> Electron MenuItem template array. hasCallWindow() is read at build time (tray.refreshMenu()
//        is called by the call window's onChange hook).
//     Without a call window: Show/Hide Google Chat, -, Mute notifications (checkbox), -, Settings...,
//       -, Exit, -, <build label> (disabled).
//     With a call window the SAME list is preceded by "Show call window" and a separator.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers/pending');

const SHOW_CALL = 'Show call window';
const SHOW_HIDE = 'Show/Hide Google Chat';
const MUTE = 'Mute notifications';
const SETTINGS = 'Settings…';
const HELP = 'Help'; // UI-06
const EXIT = 'Exit';
const VERSION = '0.1.0 (abc1234, local)';

function build({ call = false, muted = false } = {}) {
  const clicks = [];
  const template = load('trayMenu.js').buildTrayMenuTemplate({
    getNotificationsMuted: () => muted,
    getVersionLabel: () => VERSION,
    hasCallWindow: () => call,
    onShowCallWindow: () => clicks.push('show-call'),
    onToggleShowHide: () => clicks.push('show-hide'),
    onToggleMute: () => clicks.push('mute'),
    onOpenSettings: () => clicks.push('settings'),
    onOpenHelp: () => clicks.push('help'),
    onExit: () => clicks.push('exit'),
  });
  const shape = template.map((item) => (item.type === 'separator' ? '-' : item.label));
  const byLabel = (label) => template.find((item) => item.label === label);
  return { template, shape, clicks, byLabel };
}

test('tray menu without a call window: Help (UI-06) sits right after Settings, Exit stays last above the version line', () => {
  const { shape } = build();
  assert.deepEqual(shape, [SHOW_HIDE, '-', MUTE, '-', SETTINGS, HELP, '-', EXIT, '-', VERSION]);
});

test('tray menu with a call window: "Show call window" is the first entry, then a separator, then the unchanged menu', () => {
  const { shape } = build({ call: true });
  assert.deepEqual(shape, [SHOW_CALL, '-', SHOW_HIDE, '-', MUTE, '-', SETTINGS, HELP, '-', EXIT, '-', VERSION]);
});

test('tray menu: "Show call window" runs the call window action and never the main-window toggle', () => {
  const { byLabel, clicks } = build({ call: true });
  byLabel(SHOW_CALL).click();
  assert.deepEqual(clicks, ['show-call']);
});

test('tray menu: the entry follows the live state - the same builder, called again, reflects the call window appearing and going', () => {
  let call = false;
  const mk = () => load('trayMenu.js').buildTrayMenuTemplate({
    getNotificationsMuted: () => false,
    getVersionLabel: () => VERSION,
    hasCallWindow: () => call,
    onShowCallWindow: () => {},
    onToggleShowHide: () => {},
    onToggleMute: () => {},
    onOpenSettings: () => {},
    onOpenHelp: () => {},
    onExit: () => {},
  }).map((i) => i.label);
  assert.equal(mk().includes(SHOW_CALL), false);
  call = true;
  assert.equal(mk()[0], SHOW_CALL);
  call = false;
  assert.equal(mk().includes(SHOW_CALL), false);
});

test('tray menu: the other entries keep their callbacks (Show/Hide, Mute, Settings, Exit)', () => {
  const { byLabel, clicks } = build({ call: true });
  byLabel(SHOW_HIDE).click();
  byLabel(MUTE).click();
  byLabel(SETTINGS).click();
  byLabel(HELP).click();
  byLabel(EXIT).click();
  assert.deepEqual(clicks, ['show-hide', 'mute', 'settings', 'help', 'exit']);
});

test('tray menu: Mute is a checkbox reflecting the setting, and the build label is a disabled line', () => {
  const on = build({ muted: true });
  const off = build({ muted: false });
  assert.equal(on.byLabel(MUTE).type, 'checkbox');
  assert.equal(on.byLabel(MUTE).checked, true);
  assert.equal(off.byLabel(MUTE).checked, false);
  assert.equal(on.byLabel(VERSION).enabled, false);
});
