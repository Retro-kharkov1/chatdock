'use strict';

// FR-14 (docs/architecture/tray-lifecycle.md "Blink tray icon on unread") — the module-level,
// single-timer-handle shape that section defines. `timerHandle` is the only state this module
// holds; there is no code path that can reach a second live `setInterval` short of calling
// `startBlinking` twice, which is itself a guarded no-op (see below). That guard is what makes
// NFR-06's "no duplicate or orphaned interval handles" a property of this module's two entry
// points (`startBlinking`/`stopBlinking`), not something every caller has to get right on its own.
//
// The icon-swap side effects (which glyph to show on each tick, which glyph to restore on stop)
// are injected via `configure()` rather than this module reaching into a Tray/BrowserWindow
// directly — that keeps it usable with real Electron objects in the app and with plain stub
// functions + fake `setInterval`/`clearInterval` in tests (see test/trayBlink.test.js, which spies
// on the real global timer functions per tray-lifecycle.md's own NFR-06 test recipe).

let timerHandle = null; // null = not blinking. The only state this module holds.
let showBadge = false; // which of the two icon states the current tick is showing.
let onTickCallback = null;
let onStopCallback = null;

/**
 * configure({ onTick, onStop })
 *
 * Injects this module's icon-swap side effects. Called exactly once, from index.js's bootstrap,
 * before any `startBlinking()` call can occur.
 *
 * @param {object} callbacks
 * @param {(showBadge: boolean) => void} callbacks.onTick Called on every ~1s tick with the next
 *   alternation state (`true` = show the badged/unread glyph, `false` = show the plain glyph).
 *   Icon-image swap only — no menu rebuild, no settings read, no other work, per NFR-06's
 *   per-tick cost bound.
 * @param {() => void} callbacks.onStop Called whenever blinking actually stops (never on a no-op
 *   stop) to restore the correct non-blinking icon (idle or static-unread, per the current unread
 *   count) — the icon must never be left mid-blink-cycle when the timer stops.
 */
function configure({ onTick, onStop }) {
  onTickCallback = onTick;
  onStopCallback = onStop;
}

/**
 * startBlinking() — FR-14's start/resume trigger. A no-op whenever a timer is already running,
 * which is what makes "resume" safe: a resume is just another call to this same function from the
 * same call site as the original start (see tray.js's `createUnreadBlinkGate`) — there is no
 * separate "resume" function and therefore no second way to accidentally create a second
 * `setInterval`.
 */
function startBlinking() {
  if (timerHandle !== null) return; // already blinking — FR-14's "no second timer" case.
  showBadge = false;
  timerHandle = setInterval(tick, 1000); // FR-14's ~1s alternation; NFR-06's one allowed timer.
}

/**
 * stopBlinking() — FR-14's three stop triggers all converge here. Always `clearInterval`s and
 * nulls the handle together, never one without the other, so "cleared, not merely paused"
 * (NFR-06) is a property of this entry point, not something callers have to get right themselves.
 * A no-op (including not calling `onStop`) when nothing is currently blinking, so every caller can
 * call this unconditionally without checking `isBlinking()` first.
 */
function stopBlinking() {
  if (timerHandle === null) return;
  clearInterval(timerHandle);
  timerHandle = null;
  if (onStopCallback) onStopCallback();
}

function tick() {
  showBadge = !showBadge;
  if (onTickCallback) onTickCallback(showBadge);
}

function isBlinking() {
  return timerHandle !== null;
}

/**
 * _resetForTests() — test-only escape hatch: clears any live timer and callback configuration
 * without relying on `onStop` having been configured. Never called from production code.
 */
function _resetForTests() {
  if (timerHandle !== null) clearInterval(timerHandle);
  timerHandle = null;
  showBadge = false;
  onTickCallback = null;
  onStopCallback = null;
}

module.exports = { configure, startBlinking, stopBlinking, isBlinking, _resetForTests };
