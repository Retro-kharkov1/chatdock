'use strict';

// UI-05 / FR-18, docs/architecture/smart-copy.md section 4. The small "Copied" / "Link copied" hint next to the
// cursor. Electron has no tooltip API, so it is an app-owned, click-through, never-focused BrowserWindow that loads
// one bundled static page (no script, no preload) and is created lazily, reused, hidden 1.5 s after the last hint
// and destroyed after 5 minutes without one. No Electron import: every collaborator is injected.

const HINT_MS = 1500;
const IDLE_MS = 5 * 60 * 1000;
const HEIGHT = 28;
const OFFSET_X = 12;
const OFFSET_Y = 18;
const PARTITION = 'gcd-copy-hint'; // non-persistent on purpose: nothing is stored, the Google session is never shared

// Frozen two-entry table: the ONLY scripts ever run in the hint page. Nothing page- or user-supplied is
// concatenated into them; the strings themselves live in copy-hint.css as `content`.
const HINTS = Object.freeze({
  copied: Object.freeze({ script: "document.body.className='copied'", width: 76 }),
  'link-copied': Object.freeze({ script: "document.body.className='link-copied'", width: 104 }),
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

/** Cursor + (12, 18), flipped left of / above the cursor on overflow, then clamped inside the work area. */
function place(cursor, width, workArea) {
  let x = cursor.x + OFFSET_X;
  let y = cursor.y + OFFSET_Y;
  if (x + width > workArea.x + workArea.width) x = cursor.x - OFFSET_X - width;
  if (y + HEIGHT > workArea.y + workArea.height) y = cursor.y - OFFSET_Y - HEIGHT;
  x = clamp(x, workArea.x, Math.max(workArea.x, workArea.x + workArea.width - width));
  y = clamp(y, workArea.y, Math.max(workArea.y, workArea.y + workArea.height - HEIGHT));
  return { x: Math.round(x), y: Math.round(y), width, height: HEIGHT };
}

/**
 * createCopyHint({ BrowserWindow, screen, session, timers, htmlPath, log }) -> { showHint(kind, cursorPoint?), destroy() }
 * kind: 'copied' | 'link-copied'; anything else is ignored.
 */
function createCopyHint({
  BrowserWindow,
  screen,
  session,
  timers = { setTimeout, clearTimeout },
  htmlPath,
  nativeTheme, // optional: an OS theme change drops the window (see below)
  log = () => {},
}) {
  let inst = null; // { win, ready }
  let hideTimer = null;
  let idleTimer = null;
  let latest = null; // the newest request; an older one that wakes up after an await gives way to it

  function clearTimers() {
    if (hideTimer !== null) timers.clearTimeout(hideTimer);
    if (idleTimer !== null) timers.clearTimeout(idleTimer);
    hideTimer = null;
    idleTimer = null;
  }

  function create() {
    // Own named, non-persistent partition: never the default session. Every permission denied.
    const ses = session.fromPartition(PARTITION);
    ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);

    const win = new BrowserWindow({
      width: HINTS.copied.width,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
      },
    });
    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.setIgnoreMouseEvents(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());

    const entry = { win, ready: null };
    entry.ready = Promise.resolve()
      .then(() => win.loadFile(htmlPath))
      .catch((err) => {
        log('[gcd] copy hint load failed', err && err.name);
        throw err;
      });
    // A window that closes by itself must not leave timers or a stale reference behind.
    win.on('closed', () => {
      clearTimers();
      if (inst === entry) inst = null;
    });
    return entry;
  }

  function ensure() {
    if (inst && inst.win.isDestroyed()) {
      clearTimers();
      inst = null;
    }
    if (!inst) inst = create();
    return inst;
  }

  async function showHint(kind, cursorPoint) {
    if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(HINTS, kind)) return;
    const hint = HINTS[kind];
    try {
      const cursor = cursorPoint || screen.getCursorScreenPoint();
      const entry = ensure();
      const { win } = entry;
      const request = { kind, cursor };
      latest = request;

      await entry.ready;
      if (win.isDestroyed() || latest !== request) return;
      await win.webContents.executeJavaScript(hint.script);
      if (win.isDestroyed() || latest !== request) return;

      win.setBounds(place(cursor, hint.width, screen.getDisplayNearestPoint(cursor).workArea));
      win.showInactive(); // never show()/focus(): the page keeps the keyboard focus

      clearTimers();
      hideTimer = timers.setTimeout(() => {
        hideTimer = null;
        if (!win.isDestroyed()) win.hide();
      }, HINT_MS);
      idleTimer = timers.setTimeout(() => {
        idleTimer = null;
        if (!win.isDestroyed()) win.destroy();
      }, IDLE_MS);
    } catch (err) {
      // A failed hint is cosmetic: drop the instance so the next one starts clean.
      log('[gcd] copy hint failed', err && err.name);
      const broken = inst;
      inst = null;
      clearTimers();
      try {
        if (broken && !broken.win.isDestroyed()) broken.win.destroy();
      } catch {
        // already gone
      }
    }
  }

  /** At app quit: destroy the window and clear every timer. */
  function destroy() {
    clearTimers();
    const entry = inst;
    inst = null;
    latest = null;
    if (entry && !entry.win.isDestroyed()) entry.win.destroy();
  }

  // Spike finding (Electron 44.4.3 / Windows 11): a transparent hint window that already exists when the theme
  // changes (prefers-color-scheme flips) stops painting: it is shown but blank. The window is cheap and lazily
  // recreated (~160 ms for the next hint), so a theme change simply drops it.
  if (nativeTheme && typeof nativeTheme.on === 'function') {
    nativeTheme.on('updated', () => {
      try {
        destroy();
      } catch {
        // already gone
      }
    });
  }

  return { showHint, destroy };
}

module.exports = { createCopyHint, HINTS, HINT_MS, IDLE_MS };
