'use strict';

// UI-05 / FR-18, docs/architecture/smart-copy.md. Right-click on a link copies the link address (main window and
// Google app windows, through the contents' `context-menu` event); releasing the left button after selecting text
// copies the selection (main window only: its preload sends the payload-free `smartcopy:signal`, this module
// validates it and calls webContents.copy()). No Electron import: every collaborator is injected, so the module is
// unit-testable under plain node:test.
//
// Logging: outcome only (`link copied`, `selection copied`, `signal rejected`). Never a URL, selected text or
// clipboard content.

const { unwrapTarget, WRAPPER_ORIGIN, WRAPPER_PATH } = require('./wrapperUrl');
const { isAllowedSender } = require('./originCheck');

const SIGNAL_CHANNEL = 'smartcopy:signal';
const MAX_URL_LENGTH = 8192;
const COPY_WINDOW_MS = 100;
const COPYABLE_PROTOCOLS = Object.freeze(['http:', 'https:', 'mailto:']);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

const WRAPPER_HOSTNAME = new URL(WRAPPER_ORIGIN).hostname;

function parse(input) {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function acceptableText(text) {
  return typeof text === 'string' && text !== '' && text.length <= MAX_URL_LENGTH && !CONTROL_CHARS.test(text);
}

/**
 * copyableLinkUrl(raw) -> string | null. Pure, never throws.
 * A direct http/https/mailto link comes back exactly as given (Chromium has already canonicalised `linkURL`, so
 * it is never re-serialised here). A https://www.google.com/url?q=<target> wrapper gives the decoded `q` text
 * verbatim, unwrapped exactly once (a nested wrapper comes back as text). Any other scheme, a malformed wrapper
 * (duplicated q, port, userinfo), over-long input or a control character gives null.
 */
function copyableLinkUrl(raw) {
  try {
    if (!acceptableText(raw)) return null;
    const u = parse(raw);
    if (u === null) return null;

    if (u.hostname === WRAPPER_HOSTNAME && u.pathname === WRAPPER_PATH) {
      const target = unwrapTarget(u); // null for a duplicated q, a port or userinfo: nothing is copied
      if (target === null || !acceptableText(target)) return null;
      const t = parse(target);
      if (t === null || !COPYABLE_PROTOCOLS.includes(t.protocol)) return null;
      return target;
    }

    return COPYABLE_PROTOCOLS.includes(u.protocol) ? raw : null;
  } catch {
    return null;
  }
}

function isValidSignalPayload(payload) {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    Object.keys(payload).length === 1 &&
    payload.kind === 'selection'
  );
}

function frameOrigin(frame) {
  if (!frame || typeof frame.url !== 'string') return undefined;
  const u = parse(frame.url);
  return u === null ? undefined : u.origin;
}

/**
 * createSmartCopy({ clipboard, showHint, timers, log, ipcMain, notificationOrigins }) ->
 *   { bindSmartCopyMain(mainWindow), bindSmartCopyApp(webContents) }
 */
function createSmartCopy({
  clipboard,
  showHint,
  timers = { setTimeout, clearTimeout },
  log = () => {},
  ipcMain,
  notificationOrigins,
}) {
  function hint(kind) {
    try {
      const result = showHint(kind);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      log('[gcd] smartcopy hint failed');
    }
  }

  function bindLinkCopy(webContents) {
    webContents.on('context-menu', (_event, params) => {
      try {
        const url = copyableLinkUrl(params && params.linkURL);
        if (url === null) return;
        clipboard.writeText(url);
        log('[gcd] smartcopy link copied');
        hint('link-copied');
      } catch (err) {
        log('[gcd] smartcopy link copy failed', err && err.name);
      }
    });
  }

  /** Google app windows: right-click link copy only (no preload there, so no copy-on-select). */
  function bindSmartCopyApp(webContents) {
    bindLinkCopy(webContents);
  }

  /** Main Chat window: link copy plus the validated `smartcopy:signal` handler with a trailing-edge limit. */
  function bindSmartCopyMain(mainWindow) {
    const webContents = mainWindow.webContents;
    bindLinkCopy(webContents);

    let windowTimer = null; // the open 100 ms window
    let pending = false; // one trailing copy is owed at the window's end

    const alive = () => !mainWindow.isDestroyed() && !webContents.isDestroyed();

    function copyNow() {
      if (!alive()) return;
      try {
        webContents.copy();
      } catch (err) {
        log('[gcd] smartcopy copy failed', err && err.name);
        return;
      }
      log('[gcd] smartcopy selection copied');
      hint('copied');
    }

    function openWindow() {
      windowTimer = timers.setTimeout(() => {
        windowTimer = null;
        if (!pending) return;
        pending = false;
        if (!alive()) return;
        copyNow();
        openWindow(); // the trailing copy is itself rate-limited
      }, COPY_WINDOW_MS);
    }

    function clearTimers() {
      if (windowTimer !== null) timers.clearTimeout(windowTimer);
      windowTimer = null;
      pending = false;
    }

    function reject(why) {
      log('[gcd] smartcopy signal rejected: ' + why);
    }

    const onSignal = (event, payload) => {
      try {
        if (mainWindow.isDestroyed() || webContents.isDestroyed()) return;
        if (!event || event.sender !== webContents) return reject('sender');
        const frame = event.senderFrame;
        if (!frame) return reject('no frame');
        if (frame !== webContents.mainFrame) return reject('not the main frame');
        if (!isAllowedSender(frameOrigin(frame), notificationOrigins)) return reject('origin');
        if (!isValidSignalPayload(payload)) return reject('payload');

        if (windowTimer !== null) {
          pending = true; // last signal wins: the trailing copy reads the then-current selection
          return;
        }
        copyNow();
        openWindow();
      } catch (err) {
        log('[gcd] smartcopy signal failed', err && err.name);
      }
    };
    ipcMain.on(SIGNAL_CHANNEL, onSignal);

    mainWindow.on('closed', () => {
      clearTimers();
      // A window created later (macOS-style re-open) must not leave this stale handler behind.
      if (typeof ipcMain.removeListener === 'function') ipcMain.removeListener(SIGNAL_CHANNEL, onSignal);
    });
  }

  return { bindSmartCopyMain, bindSmartCopyApp };
}

module.exports = { copyableLinkUrl, createSmartCopy, SIGNAL_CHANNEL };
