'use strict';

// FR-19 tray entry "Back to Chat" (docs/architecture/sign-in-flow.md section 3a "Tray entry", test map row "Tray
// entry"; docs/architecture/tray-lifecycle.md context-menu table). The existing test/trayMenu.test.js stays untouched
// and green: with the new collaborators ABSENT the menu is exactly today's (re-pinned below).
//
// MODULE API ASSUMED (extends buildTrayMenuTemplate of src/main/trayMenu.js; both additions OPTIONAL):
//
//   buildTrayMenuTemplate({ ...existing,
//     isSignInActive,   // () => boolean, read at BUILD time (like hasCallWindow); absent -> false
//     onBackToChat,     // () => void; its click handler (index.js: createBackToChat(...) - abort('user') then show)
//   })
//   While isSignInActive() is true the template has one more entry, label exactly "Back to Chat", directly after
//   "Show/Hide Google Chat" (the existing separator then follows). The call-window entry, when present, is still first.
//   The menu is rebuilt on mode change by index.js (onModeChange -> trayController.refreshMenu), never from the blink
//   tick: that is a source-level check in test/signInWiring.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers/pending');

const SHOW_CALL = 'Show call window';
const SHOW_HIDE = 'Show/Hide Google Chat';
const BACK = 'Back to Chat';
const MUTE = 'Mute notifications';
const SETTINGS = 'Settings…';
const HELP = 'Help';
const EXIT = 'Exit';
const VERSION = '0.1.0 (abc1234, local)';

function build({ active, call = false, withBack = true } = {}) {
  const clicks = [];
  const deps = {
    getNotificationsMuted: () => false,
    getVersionLabel: () => VERSION,
    hasCallWindow: () => call,
    onShowCallWindow: () => clicks.push('show-call'),
    onToggleShowHide: () => clicks.push('show-hide'),
    onToggleMute: () => clicks.push('mute'),
    onOpenSettings: () => clicks.push('settings'),
    onOpenHelp: () => clicks.push('help'),
    onExit: () => clicks.push('exit'),
  };
  if (active !== undefined) deps.isSignInActive = typeof active === 'function' ? active : () => active;
  if (withBack) deps.onBackToChat = () => clicks.push('back-to-chat');
  const template = load('trayMenu.js').buildTrayMenuTemplate(deps);
  const shape = template.map((item) => (item.type === 'separator' ? '-' : item.label));
  const byLabel = (label) => template.find((item) => item.label === label);
  return { template, shape, clicks, byLabel, deps };
}

test('tray menu, sign-in on: "Back to Chat" sits directly after "Show/Hide Google Chat", before the separator', () => {
  const { shape } = build({ active: true });
  assert.deepEqual(shape, [SHOW_HIDE, BACK, '-', MUTE, '-', SETTINGS, HELP, '-', EXIT, '-', VERSION]);
});

test('tray menu, sign-in on with a call window: the call entry stays first, Back to Chat is still right after Show/Hide', () => {
  const { shape } = build({ active: true, call: true });
  assert.deepEqual(shape, [SHOW_CALL, '-', SHOW_HIDE, BACK, '-', MUTE, '-', SETTINGS, HELP, '-', EXIT, '-', VERSION]);
});

test('tray menu, sign-in off: no "Back to Chat" - the menu is exactly today\'s', () => {
  const { shape } = build({ active: false });
  assert.deepEqual(shape, [SHOW_HIDE, '-', MUTE, '-', SETTINGS, HELP, '-', EXIT, '-', VERSION]);
});

test('tray menu, collaborators absent: today\'s menu, and building never throws', () => {
  const { shape } = build({ withBack: false });
  assert.deepEqual(shape, [SHOW_HIDE, '-', MUTE, '-', SETTINGS, HELP, '-', EXIT, '-', VERSION]);
});

test('tray menu: the label is exactly "Back to Chat" and the entry is a plain enabled action (no checkbox, no tooltip surface)', () => {
  const entry = build({ active: true }).byLabel(BACK);
  assert.ok(entry);
  assert.equal(entry.label, 'Back to Chat');
  assert.notEqual(entry.type, 'checkbox');
  assert.notEqual(entry.enabled, false);
  assert.equal(typeof entry.click, 'function');
});

test('tray menu: clicking "Back to Chat" runs the Back to Chat action and nothing else (not Show/Hide, not Exit)', () => {
  const { byLabel, clicks } = build({ active: true });
  byLabel(BACK).click();
  assert.deepEqual(clicks, ['back-to-chat']);
});

test('tray menu: the other entries keep their callbacks while the entry is present', () => {
  const { byLabel, clicks } = build({ active: true, call: true });
  byLabel(SHOW_HIDE).click();
  byLabel(MUTE).click();
  byLabel(SETTINGS).click();
  byLabel(HELP).click();
  byLabel(EXIT).click();
  byLabel(SHOW_CALL).click();
  assert.deepEqual(clicks, ['show-hide', 'mute', 'settings', 'help', 'exit', 'show-call']);
});

test('tray menu: the entry follows the live state - the same builder, rebuilt, shows it when the mode turns on and drops it when it ends', () => {
  let active = false;
  const mk = () => build({ active: () => active }).template.map((i) => i.label);
  assert.equal(mk().includes(BACK), false);
  active = true;
  const on = mk();
  assert.equal(on[on.indexOf(SHOW_HIDE) + 1], BACK);
  active = false;
  assert.equal(mk().includes(BACK), false);
});

test('tray menu: isSignInActive is read when the menu is built (once per build), not cached across builds', () => {
  let reads = 0;
  const deps = build({ active: () => { reads += 1; return true; } }).deps;
  const before = reads;
  load('trayMenu.js').buildTrayMenuTemplate(deps);
  assert.ok(reads > before);
});

test('tray menu: a click on a stale item (the mode already ended) still goes to the same action; the no-op lives in that action', () => {
  const { byLabel, clicks } = build({ active: true });
  const entry = byLabel(BACK);
  entry.click();
  entry.click();
  assert.deepEqual(clicks, ['back-to-chat', 'back-to-chat']);
});

test('trayMenu.js stays pure (no Electron import) after the extension', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'trayMenu.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(/require\(['"]electron['"]\)/.test(code), false);
});
