'use strict';

const fs = require('fs');
const path = require('path');

// FR-11 (notification sound), FR-12 (mute) — persisted alongside window-state per
// tray-lifecycle.md's "Sound & mute" section. Deliberately does NOT store `startAtLogin`: FR-10
// requires that checkbox to reflect the *actual* OS-level state, not a possibly-stale in-app
// preference — see autostart.js, which reads/writes the OS mechanism directly instead.

const DEFAULTS = Object.freeze({ soundEnabled: true, notificationsMuted: false });

/**
 * getSettingsPath() — resolves `settings.json`'s location under Electron's own `userData`
 * directory. Requires the `electron` module lazily (only when actually called, from inside a
 * running Electron main process) so this file stays requirable under plain `node:test` without
 * pulling in Electron.
 */
function getSettingsPath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'settings.json');
}

/**
 * loadSettings(filePath)
 *
 * Reads and validates the persisted settings file. Never throws: a missing file (first launch),
 * corrupt JSON, or a field of the wrong type all fall back to DEFAULTS for that field — this is
 * the same "never trust persisted data blindly" posture window-state.js's resolveWindowState
 * takes for its own saved state.
 */
function loadSettings(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      soundEnabled:
        typeof parsed.soundEnabled === 'boolean' ? parsed.soundEnabled : DEFAULTS.soundEnabled,
      notificationsMuted:
        typeof parsed.notificationsMuted === 'boolean'
          ? parsed.notificationsMuted
          : DEFAULTS.notificationsMuted,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * saveSettings(filePath, settings) — best-effort persistence; a write failure is logged, not
 * thrown, since losing a sound/mute preference is not worth crashing an always-running tray app
 * over.
 */
function saveSettings(filePath, settings) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('[gcd] failed to persist settings.json', err);
  }
}

module.exports = { DEFAULTS, getSettingsPath, loadSettings, saveSettings };
