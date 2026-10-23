'use strict';

// UI-10: keyboard + Ctrl+wheel zoom for the main Chat window and the Google app windows, one factor shared by all
// of them, bounded, and persisted in `zoom.json` under userData (a number only: nothing sensitive is stored or logged).
// The application menu is null (index.js), so Electron's zoom accelerators do not exist; they are rebuilt here.
// The call window (Meet), Settings, Help and the picker are never bound. No Electron import: contents and the
// filesystem are passed in. Kept out of editShortcuts.js on purpose (BUG-11 edits the Ctrl+V code there).

const fs = require('fs');
const path = require('path');

const MIN_FACTOR = 0.5;
const MAX_FACTOR = 3.0;
const STEP = 0.1;
const DEFAULT_FACTOR = 1.0;

/** Round to 2 decimals and clamp to [MIN, MAX]; anything that is not a finite number becomes the default. */
function clampFactor(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_FACTOR;
  const rounded = Math.round(value * 100) / 100;
  return Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, rounded));
}

/** Map a key event to 'in' | 'out' | 'reset' | null. Ctrl (or Cmd), no Alt. Shift allowed (Ctrl+Shift+= is '+'). */
function zoomActionFor(input) {
  if (!input || input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return null;
  const key = String(input.key);
  if (key === '=' || key === '+') return 'in';
  if (key === '-' || key === '_') return 'out';
  if (key === '0') return 'reset';
  return null;
}

function loadFactor(filePath, fsImpl = fs) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    return clampFactor(parsed && parsed.factor);
  } catch {
    return DEFAULT_FACTOR; // missing or corrupt file
  }
}

function saveFactor(filePath, factor, fsImpl = fs) {
  try {
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    fsImpl.writeFileSync(filePath, JSON.stringify({ factor }), 'utf8');
  } catch (err) {
    console.error('[gcd] failed to persist zoom.json', err && err.code ? err.code : 'error'); // code only
  }
}

/**
 * createZoom({ filePath, fsImpl, scheduler }) -> { bind(webContents), getFactor() }
 * `scheduler(fn)` defers a callback to after the current event turn (default setTimeout 0).
 */
function createZoom({ filePath, fsImpl = fs, scheduler = (fn) => setTimeout(fn, 0) } = {}) {
  let factor = filePath ? loadFactor(filePath, fsImpl) : DEFAULT_FACTOR;
  const bound = new Set();

  const live = (wc) => !(typeof wc.isDestroyed === 'function' && wc.isDestroyed());

  function applyTo(wc) {
    if (live(wc) && wc.getZoomFactor() !== factor) wc.setZoomFactor(factor);
  }

  /** Make `next` the shared factor: apply to every bound window, persist when it changed. */
  function setFactor(next) {
    const clamped = clampFactor(next);
    const changed = clamped !== factor;
    factor = clamped;
    for (const wc of bound) applyTo(wc);
    if (changed && filePath) saveFactor(filePath, factor, fsImpl);
  }

  function bind(wc) {
    bound.add(wc);
    wc.on('destroyed', () => bound.delete(wc));
    // The factor is per origin and resets when a window navigates to another one: re-apply on every page load.
    wc.on('dom-ready', () => applyTo(wc));
    wc.on('before-input-event', (event, input) => {
      const action = zoomActionFor(input);
      if (!action) return;
      event.preventDefault();
      setFactor(action === 'reset' ? DEFAULT_FACTOR : action === 'in' ? factor + STEP : factor - STEP);
    });
    // Ctrl+wheel. Electron documents this event but not whether Chromium has already zoomed (UI-10 coverage map).
    // Self-correcting: after the event turn, if the contents' factor moved, adopt it; if not, apply the step here.
    wc.on('zoom-changed', (_event, direction) => {
      const before = factor;
      scheduler(() => {
        if (!live(wc)) return;
        const current = clampFactor(wc.getZoomFactor());
        if (current !== before) setFactor(current);
        else if (direction === 'in') setFactor(before + STEP);
        else if (direction === 'out') setFactor(before - STEP);
      });
    });
    return wc;
  }

  return { bind, getFactor: () => factor };
}

module.exports = { createZoom, clampFactor, zoomActionFor, loadFactor, saveFactor, MIN_FACTOR, MAX_FACTOR, STEP, DEFAULT_FACTOR };
