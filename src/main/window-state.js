'use strict';

const fs = require('fs');
const path = require('path');

/**
 * resolveWindowState(saved, displays, defaultSize)
 *
 * Pure decision logic behind FR-02 (docs/business/requirements.md) and the window-state
 * persistence design in docs/architecture/overview.md: given a previously persisted window
 * state, decide the state that should actually be applied to the BrowserWindow on the next
 * launch — restoring it when it is still on-screen, or falling back to a centered default when
 * it is not (e.g. a monitor was disconnected since the state was saved).
 *
 * This function has no Electron/OS dependency by design (per the plan's "structural constraint
 * carried by task 0") so it is unit-testable without a running Electron process. The real caller
 * (src/main/window-state.js's own load/save wiring, built in a later pass) is responsible for
 * reading/writing the persisted JSON and for calling `screen.getAllDisplays()` — this function
 * only makes the decision from data already handed to it.
 *
 * @param {{width:number, height:number, x:number, y:number, isMaximized?:boolean}|null|undefined} saved
 *   The previously persisted state, or a nullish/malformed value on first launch or if the
 *   persisted file is missing/corrupt. Any value that is not an object with finite numeric
 *   `width`/`height`/`x`/`y` is treated the same as "no saved state" — this function never
 *   throws on a malformed `saved` value, it falls back to the centered default instead.
 * @param {Array<{workArea:{x:number,y:number,width:number,height:number}}>} displays
 *   The connected displays, in the shape returned by Electron's `screen.getAllDisplays()`
 *   (specifically, each entry's `workArea`). **Convention**: `displays[0]` is treated as the
 *   *primary* display — the plan's signature takes only this one `displays` array (no separate
 *   `primaryDisplay` parameter), so the caller is responsible for ordering it with the primary
 *   display first (e.g. `[screen.getPrimaryDisplay(), ...screen.getAllDisplays().filter(d =>
 *   d.id !== screen.getPrimaryDisplay().id)]`). This convention is not stated explicitly in the
 *   plan/architecture docs and is recorded here as the resolved ambiguity — see this module's
 *   entry in the implementation report.
 *   An empty array is handled without throwing (see return value below).
 * @param {{width:number, height:number}} defaultSize
 *   FR-01's default size (1200x800) to fall back to, and to center on the primary display.
 *
 * @returns {{width:number, height:number, x:number|undefined, y:number|undefined, isMaximized:boolean}}
 *   - If `saved` is a well-formed state and its top-left corner (`x`,`y`) falls within the work
 *     area of *any* connected display (not just the primary one), `saved` is returned as-is
 *     (with `isMaximized` defaulted to `false` if the field is missing).
 *   - Otherwise (no usable saved state, or its position is outside every display's work area),
 *     `defaultSize` is returned, centered on `displays[0]`'s work area, with `isMaximized: false`.
 *   - If `displays` is empty, the centered-default branch returns `x: undefined, y: undefined`
 *     (letting the BrowserWindow's own default centering behavior take over) instead of
 *     computing a center against a display that doesn't exist.
 */
function resolveWindowState(saved, displays, defaultSize) {
  const safeDisplays = Array.isArray(displays) ? displays : [];

  const isFiniteNumber = (n) => typeof n === 'number' && Number.isFinite(n);
  const isWellFormedSaved =
    saved &&
    typeof saved === 'object' &&
    isFiniteNumber(saved.width) &&
    isFiniteNumber(saved.height) &&
    isFiniteNumber(saved.x) &&
    isFiniteNumber(saved.y);

  if (isWellFormedSaved) {
    const isOnScreen = safeDisplays.some((display) => {
      const wa = display && display.workArea;
      if (!wa) return false;
      return (
        saved.x >= wa.x &&
        saved.x < wa.x + wa.width &&
        saved.y >= wa.y &&
        saved.y < wa.y + wa.height
      );
    });

    if (isOnScreen) {
      return {
        width: saved.width,
        height: saved.height,
        x: saved.x,
        y: saved.y,
        isMaximized: Boolean(saved.isMaximized),
      };
    }
  }

  // Fallback: centered default size on the primary display (displays[0]), or no position at
  // all if there is no display to center on.
  const primary = safeDisplays[0];
  if (!primary || !primary.workArea) {
    return {
      width: defaultSize.width,
      height: defaultSize.height,
      x: undefined,
      y: undefined,
      isMaximized: false,
    };
  }

  const wa = primary.workArea;
  return {
    width: defaultSize.width,
    height: defaultSize.height,
    x: Math.round(wa.x + (wa.width - defaultSize.width) / 2),
    y: Math.round(wa.y + (wa.height - defaultSize.height) / 2),
    isMaximized: false,
  };
}

// --- Disk load/save wiring (task 3) ---------------------------------------------------------
// The functions above are the pure decision logic (task 0's covered net). Everything below is
// the actual persistence side: reading/writing `window-state.json` under Electron's `userData`
// directory, and calling `screen.getAllDisplays()` to build the `displays` array
// `resolveWindowState` expects (primary display first — see that function's own JSDoc on the
// convention). `electron` is required lazily inside these functions, not at module load, so this
// file stays requirable under plain `node:test` (see window-state.test.js, which only imports
// `resolveWindowState`) without an Electron runtime.

/** getWindowStatePath() — resolves `window-state.json`'s location under `userData`. */
function getWindowStatePath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'window-state.json');
}

/**
 * loadSavedWindowState(filePath) — reads the persisted JSON, or returns `null` on any failure
 * (missing file on first launch, corrupt JSON, etc.) so the caller falls into
 * `resolveWindowState`'s own "no usable saved state" branch rather than throwing.
 */
function loadSavedWindowState(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * saveWindowState(filePath, state) — best-effort persistence; a write failure is logged, not
 * thrown, since losing window geometry is not worth crashing an always-running tray app over.
 */
function saveWindowState(filePath, state) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state), 'utf8');
  } catch (err) {
    console.error('[gcd] failed to persist window-state.json', err);
  }
}

/**
 * getOrderedDisplays() — `screen.getAllDisplays()` with the primary display moved to index 0, per
 * `resolveWindowState`'s documented convention (that function takes only one `displays` array and
 * treats `displays[0]` as primary; ordering it is this caller's job).
 */
function getOrderedDisplays() {
  const { screen } = require('electron');
  const primary = screen.getPrimaryDisplay();
  const all = screen.getAllDisplays();
  return [primary, ...all.filter((d) => d.id !== primary.id)];
}

module.exports = {
  resolveWindowState,
  getWindowStatePath,
  loadSavedWindowState,
  saveWindowState,
  getOrderedDisplays,
};
