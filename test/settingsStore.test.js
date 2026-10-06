'use strict';

// docs/architecture/tray-lifecycle.md "Single source of truth" — settingsStore.js's single
// `applySetting(key, value)` mutation entry point. Covers the platform-independent surface only:
// input validation, persistence round-trip for the three non-OS keys (soundEnabled,
// notificationsMuted, blinkOnUnread), and the side-effect wiring (tray menu refresh, blink stop,
// settings:changed broadcast) via injected fakes. `startAtLogin`'s real OS read/write path is
// intentionally NOT covered here — per the plan's task 0 "explicitly NOT covered" convention, it
// has no meaningful pure-logic shape independent of the OS and is hand-verification-only (task 4d).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSettingsStore, DEFAULTS } = require('../src/main/settingsStore.js');

function tempSettingsPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gcd-settings-')), 'settings.json');
}

test('defaults match tray-lifecycle.md: soundEnabled true, notificationsMuted false, blinkOnUnread true, startAtLogin false', () => {
  assert.deepEqual(DEFAULTS, {
    startAtLogin: false,
    soundEnabled: true,
    notificationsMuted: false,
    blinkOnUnread: true,
  });
});

test('a fresh store (no settings.json yet) reports the documented defaults', () => {
  const store = createSettingsStore({ settingsPath: tempSettingsPath() });
  assert.equal(store.get('soundEnabled'), true);
  assert.equal(store.get('notificationsMuted'), false);
  assert.equal(store.get('blinkOnUnread'), true);
});

test('applySetting rejects an unknown key without touching state', async () => {
  const store = createSettingsStore({ settingsPath: tempSettingsPath() });
  const result = await store.applySetting('notARealSetting', true);
  assert.equal(result.ok, false);
});

test('applySetting rejects a non-boolean value', async () => {
  const store = createSettingsStore({ settingsPath: tempSettingsPath() });
  const result = await store.applySetting('soundEnabled', 'yes');
  assert.equal(result.ok, false);
});

test('applySetting persists a valid boolean change for a non-OS key and updates in-memory state', async () => {
  const settingsPath = tempSettingsPath();
  const store = createSettingsStore({ settingsPath });
  const result = await store.applySetting('notificationsMuted', true);
  assert.deepEqual(result, { ok: true, value: true });
  assert.equal(store.get('notificationsMuted'), true);

  const persisted = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(persisted.notificationsMuted, true);
});

test('a change persisted by one store instance is read back by a new instance against the same file', async () => {
  const settingsPath = tempSettingsPath();
  const store1 = createSettingsStore({ settingsPath });
  await store1.applySetting('blinkOnUnread', false);

  const store2 = createSettingsStore({ settingsPath });
  assert.equal(store2.get('blinkOnUnread'), false);
});

test('applySetting(notificationsMuted) refreshes the tray menu as a side effect', async () => {
  let refreshed = 0;
  const store = createSettingsStore({
    settingsPath: tempSettingsPath(),
    getTrayController: () => ({ refreshMenu: () => { refreshed += 1; } }),
  });
  await store.applySetting('notificationsMuted', true);
  assert.equal(refreshed, 1);
});

test('applySetting(notificationsMuted, true) stops any active blink as a side effect', async () => {
  let stopCalls = 0;
  const store = createSettingsStore({
    settingsPath: tempSettingsPath(),
    getTrayBlink: () => ({ stopBlinking: () => { stopCalls += 1; } }),
  });
  await store.applySetting('notificationsMuted', true);
  assert.equal(stopCalls, 1);
});

test('applySetting(notificationsMuted, false) does NOT stop blinking (only muting-on and blink-off do)', async () => {
  let stopCalls = 0;
  const store = createSettingsStore({
    settingsPath: tempSettingsPath(),
    getTrayBlink: () => ({ stopBlinking: () => { stopCalls += 1; } }),
  });
  await store.applySetting('notificationsMuted', false);
  assert.equal(stopCalls, 0);
});

test('applySetting(blinkOnUnread, false) stops any active blink as a side effect', async () => {
  let stopCalls = 0;
  const store = createSettingsStore({
    settingsPath: tempSettingsPath(),
    getTrayBlink: () => ({ stopBlinking: () => { stopCalls += 1; } }),
  });
  await store.applySetting('blinkOnUnread', false);
  assert.equal(stopCalls, 1);
});

test('applySetting(blinkOnUnread, true) does NOT stop blinking', async () => {
  let stopCalls = 0;
  const store = createSettingsStore({
    settingsPath: tempSettingsPath(),
    getTrayBlink: () => ({ stopBlinking: () => { stopCalls += 1; } }),
  });
  await store.applySetting('blinkOnUnread', true);
  assert.equal(stopCalls, 0);
});

test('broadcasts settings:changed to an open Settings window that did NOT originate the change', async () => {
  const sent = [];
  const fakeWebContents = { id: 42, send: (channel, payload) => sent.push([channel, payload]) };
  const store = createSettingsStore({
    settingsPath: tempSettingsPath(),
    getSettingsWindow: () => ({ isDestroyed: () => false, webContents: fakeWebContents }),
  });
  // Originated by the tray (no IPC sender id at all) — always broadcast.
  await store.applySetting('notificationsMuted', true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], ['settings:changed', { key: 'notificationsMuted', value: true }]);
});

test('echo-loop prevention: does NOT broadcast back to the Settings window that originated the change', async () => {
  const sent = [];
  const fakeWebContents = { id: 42, send: (channel, payload) => sent.push([channel, payload]) };
  const store = createSettingsStore({
    settingsPath: tempSettingsPath(),
    getSettingsWindow: () => ({ isDestroyed: () => false, webContents: fakeWebContents }),
  });
  await store.applySetting('notificationsMuted', true, { originSenderId: 42 });
  assert.equal(sent.length, 0);
});

test('no settings window open -> broadcast is skipped without throwing', async () => {
  const store = createSettingsStore({
    settingsPath: tempSettingsPath(),
    getSettingsWindow: () => null,
  });
  const result = await store.applySetting('soundEnabled', false);
  assert.equal(result.ok, true);
});

test('getAll() returns all four keys plus reflects an update made via applySetting', async () => {
  const store = createSettingsStore({ settingsPath: tempSettingsPath() });
  await store.applySetting('soundEnabled', false);
  const all = store.getAll();
  assert.equal(all.soundEnabled, false);
  assert.equal(typeof all.startAtLogin, 'boolean');
  assert.equal(typeof all.notificationsMuted, 'boolean');
  assert.equal(typeof all.blinkOnUnread, 'boolean');
});

test('a corrupt settings.json falls back to defaults instead of throwing', () => {
  const settingsPath = tempSettingsPath();
  fs.writeFileSync(settingsPath, '{not valid json', 'utf8');
  const store = createSettingsStore({ settingsPath });
  assert.equal(store.get('soundEnabled'), true);
  assert.equal(store.get('blinkOnUnread'), true);
});

// ---- First-run defaults (maintainer decision 2026-09-30: everything ON after a fresh install) --------
// Start at login is enabled exactly once, on the first run (no settings.json yet), and only for a
// packaged build. An existing settings.json always wins; an entry the user later disables (Settings
// or Task Manager) is never re-enabled by a restart.

function fakeAutostart(initial = false) {
  const calls = { set: [] };
  let on = initial;
  return {
    calls,
    get: () => on,
    set: (v) => { calls.set.push(v); on = v; },
  };
}

test('first run (no settings.json) enables Start at login and persists the file', () => {
  const settingsPath = tempSettingsPath();
  const autostart = fakeAutostart(false);
  const store = createSettingsStore({ settingsPath, autostart, enableStartAtLoginOnFirstRun: true });
  assert.deepEqual(autostart.calls.set, [true]);
  assert.equal(store.getAll().startAtLogin, true);
  assert.equal(fs.existsSync(settingsPath), true);
});

test('first run keeps the other documented defaults: sound on, blink on, mute off', () => {
  const store = createSettingsStore({
    settingsPath: tempSettingsPath(),
    autostart: fakeAutostart(false),
    enableStartAtLoginOnFirstRun: true,
  });
  const all = store.getAll();
  assert.equal(all.soundEnabled, true);
  assert.equal(all.blinkOnUnread, true);
  assert.equal(all.notificationsMuted, false);
});

test('second launch does NOT re-apply first-run defaults (user choice survives)', () => {
  const settingsPath = tempSettingsPath();
  createSettingsStore({ settingsPath, autostart: fakeAutostart(false), enableStartAtLoginOnFirstRun: true });

  // The user turned it off (or disabled it in Task Manager): OS now reports off.
  const autostart2 = fakeAutostart(false);
  const store2 = createSettingsStore({ settingsPath, autostart: autostart2, enableStartAtLoginOnFirstRun: true });
  assert.deepEqual(autostart2.calls.set, []);
  assert.equal(store2.getAll().startAtLogin, false);
});

test('an existing settings.json from an older version counts as "already chosen" - no first-run enable', () => {
  const settingsPath = tempSettingsPath();
  fs.writeFileSync(settingsPath, JSON.stringify({ soundEnabled: false }), 'utf8');
  const autostart = fakeAutostart(false);
  createSettingsStore({ settingsPath, autostart, enableStartAtLoginOnFirstRun: true });
  assert.deepEqual(autostart.calls.set, []);
});

test('first run is a no-op when not requested (dev / unpackaged runs must not register electron.exe)', () => {
  const autostart = fakeAutostart(false);
  createSettingsStore({ settingsPath: tempSettingsPath(), autostart });
  assert.deepEqual(autostart.calls.set, []);
});

test('first run: an OS failure is swallowed (no crash) and is not retried on the next launch', () => {
  const settingsPath = tempSettingsPath();
  const failing = { get: () => false, set: () => { throw new Error('boom'); } };
  const store = createSettingsStore({ settingsPath, autostart: failing, enableStartAtLoginOnFirstRun: true });
  assert.equal(store.getAll().startAtLogin, false);
  assert.equal(fs.existsSync(settingsPath), true);
});

test('applySetting(startAtLogin) uses the injected OS layer and reports a read-back mismatch as a failure', async () => {
  const lying = { get: () => false, set: () => {} };
  const store = createSettingsStore({ settingsPath: tempSettingsPath(), autostart: lying });
  const result = await store.applySetting('startAtLogin', true);
  assert.equal(result.ok, false);
  const honest = fakeAutostart(false);
  const store2 = createSettingsStore({ settingsPath: tempSettingsPath(), autostart: honest });
  assert.deepEqual(await store2.applySetting('startAtLogin', true), { ok: true, value: true });
});
