'use strict';

// NFR-07 / docs/architecture/meet-call-window.md section 6: the Meet permission policy.
//
//   meetOriginGate          pure origin gate (requesting AND top-level origin must be Meet)
//   decideMeetRequest       permission REQUEST handler decision for Meet permissions
//   decideMeetCheck         permission CHECK handler decision for Meet permissions
//   meetMediaGate           camera/mic gate: requester Meet; top level Meet OR Chat (BUG-09)
//   createDisplayMediaGate  the session-wide display-media handler (screen share)
//
// session.js installs these; they EXTEND its handlers and never touch the notifications /
// clipboard grants (those stay Chat-only). No Electron import: unit-testable with fakes.

const { MEET_ORIGIN } = require('./meetLink');

/** originOf(value) - normalised origin of a URL / origin string (trailing slash tolerated), or null. */
function originOf(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const u = new URL(value);
    if (u.username !== '' || u.password !== '') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** meetOriginGate({ requestingOrigin, topLevelOrigin }) -> true only when BOTH are https://meet.google.com. */
function meetOriginGate({ requestingOrigin, topLevelOrigin } = {}) {
  return originOf(requestingOrigin) === MEET_ORIGIN && originOf(topLevelOrigin) === MEET_ORIGIN;
}

/** Top-level origins under which the Meet iframe may use camera/mic: the call window and Chat's embedded call. */
const MEET_MEDIA_TOP_LEVELS = Object.freeze([MEET_ORIGIN, 'https://chat.google.com']);

/**
 * meetMediaGate({ requestingOrigin, topLevelOrigin }) -> true only when the requester is exactly
 * https://meet.google.com AND the top level is exactly https://meet.google.com or https://chat.google.com
 * (Chat runs the call as a cross-origin Meet iframe, BUG-09). Used for media / speaker-selection only;
 * display-capture and the display-media handler keep the strict meetOriginGate.
 */
function meetMediaGate({ requestingOrigin, topLevelOrigin } = {}) {
  if (originOf(requestingOrigin) !== MEET_ORIGIN) return false;
  const top = originOf(topLevelOrigin);
  return top !== null && MEET_MEDIA_TOP_LEVELS.includes(top);
}

/**
 * BUG-09 experiment A: meetWakeLockGate({ requestingOrigin, topLevelOrigin }) - same shape as meetMediaGate: requester
 * exactly https://meet.google.com, top level exactly https://meet.google.com or https://chat.google.com.
 */
function meetWakeLockGate({ requestingOrigin, topLevelOrigin } = {}) {
  if (originOf(requestingOrigin) !== MEET_ORIGIN) return false;
  const top = originOf(topLevelOrigin);
  return top !== null && MEET_MEDIA_TOP_LEVELS.includes(top);
}

const WAKE_LOCK = 'screen-wake-lock';

/** Permissions this module decides; every other permission is left to the caller (returns undefined). */
const MEET_PERMISSIONS = Object.freeze(['media', 'speaker-selection', 'display-capture']);

function topLevelOfWebContents(webContents) {
  if (!webContents || typeof webContents.getURL !== 'function') return undefined;
  try {
    return webContents.getURL();
  } catch {
    return undefined;
  }
}

/**
 * decideMeetRequest(webContents, permission, details) -> boolean | undefined
 * `mediaTypes` (plural) is the REQUEST shape: ['audio'], ['video'], both, or EMPTY (the screen-share
 * precursor, which must be granted for Meet or the display-media handler is never reached).
 */
function decideMeetRequest(webContents, permission, details, options) {
  if (permission === WAKE_LOCK) {
    // BUG-09 experiment A: only when the launch flag is on; otherwise left to the caller (which denies).
    if (!options || options.wakeLock !== true) return undefined;
    return meetWakeLockGate({
      requestingOrigin: details && details.requestingUrl,
      topLevelOrigin: topLevelOfWebContents(webContents),
    });
  }
  if (!MEET_PERMISSIONS.includes(permission)) return undefined;
  const gateFn = permission === 'display-capture' ? meetOriginGate : meetMediaGate;
  const gate = gateFn({
    requestingOrigin: details && details.requestingUrl,
    topLevelOrigin: topLevelOfWebContents(webContents),
  });
  if (!gate) return false;
  if (permission === 'media') {
    const types = details && details.mediaTypes;
    if (types !== undefined && !(Array.isArray(types) && types.every((t) => t === 'audio' || t === 'video'))) {
      return false;
    }
  }
  return true;
}

/**
 * decideMeetCheck(webContents, permission, requestingOrigin, details) -> boolean | undefined
 * `mediaType` (singular) is the CHECK shape: 'video' | 'audio' | 'unknown', or absent.
 */
function decideMeetCheck(webContents, permission, requestingOrigin, details, options) {
  if (permission === WAKE_LOCK) {
    if (!options || options.wakeLock !== true) return undefined;
    const wakeSignals = [];
    const embeddingOrigin = details && details.embeddingOrigin;
    if (embeddingOrigin !== undefined && embeddingOrigin !== null) wakeSignals.push(embeddingOrigin);
    const url = topLevelOfWebContents(webContents);
    if (url !== undefined) wakeSignals.push(url);
    if (wakeSignals.length === 0) return false;
    const asker = requestingOrigin ?? (details && details.requestingUrl);
    return wakeSignals.every((topLevelOrigin) => meetWakeLockGate({ requestingOrigin: asker, topLevelOrigin }));
  }
  if (!MEET_PERMISSIONS.includes(permission)) return undefined;
  const embedding = details && details.embeddingOrigin;
  const gateFn = permission === 'display-capture' ? meetOriginGate : meetMediaGate;
  // Every available signal must pass (deny if either fails): `embeddingOrigin` names only the frame that
  // embeds the asker, `webContents.getURL()` is the real top level (same pattern as the UI-04 check).
  const signals = [];
  if (embedding !== undefined && embedding !== null) signals.push(embedding);
  const topUrl = topLevelOfWebContents(webContents);
  if (topUrl !== undefined) signals.push(topUrl);
  if (signals.length === 0) return false;
  const requesting = requestingOrigin ?? (details && details.requestingUrl);
  if (!signals.every((topLevelOrigin) => gateFn({ requestingOrigin: requesting, topLevelOrigin }))) return false;
  if (permission === 'media') {
    const type = details && details.mediaType;
    if (type !== undefined && type !== 'video' && type !== 'audio') return false;
  }
  return true;
}

/**
 * createDisplayMediaGate({ getCallWindow, picker, log }) -> { handler(request, callback), abortPending() }
 *
 * Effective screen-share gate. In order, any failure denies WITHOUT opening the picker: user gesture,
 * origin gate, a live call window, no other request pending. The picker's choice is validated against
 * the list main sent; the source is returned video only. The callback fires exactly once per request;
 * an answer after teardown is dropped.
 */
function createDisplayMediaGate({ getCallWindow, picker, log = () => {} }) {
  /** @type {{ callback: Function, settled: boolean } | null} */
  let pending = null;

  function finish(entry, streams) {
    if (entry.settled) return;
    entry.settled = true;
    if (pending === entry) pending = null;
    try {
      entry.callback(streams);
    } catch (err) {
      log('[gcd] display-media callback threw', err && err.name);
    }
  }

  function deny(callback, why) {
    log('[gcd] display-media denied:', why);
    try {
      callback(null);
    } catch (err) {
      log('[gcd] display-media callback threw', err && err.name);
    }
  }

  function handler(request, callback) {
    if (!request || request.userGesture !== true) return deny(callback, 'no user gesture');
    const top = request.frame && request.frame.top;
    if (!meetOriginGate({ requestingOrigin: request.securityOrigin, topLevelOrigin: top && top.url })) {
      return deny(callback, 'origin');
    }
    const win = getCallWindow();
    if (!win || win.isDestroyed()) return deny(callback, 'no call window');
    if (pending) return deny(callback, 'another request pending');

    const entry = { callback, settled: false };
    pending = entry;

    let opened;
    try {
      opened = Promise.resolve(picker.open(win));
    } catch (err) {
      opened = Promise.reject(err);
    }
    opened.then(
      (result) => {
        if (entry.settled) return; // torn down meanwhile: dropped
        if (win.isDestroyed()) return finish(entry, null);
        const id = result && result.sourceId;
        const sources = result && result.sources;
        if (typeof id !== 'string' || id === '' || !Array.isArray(sources)) return finish(entry, null);
        const source = sources.find((s) => s && s.id === id);
        // Video only: no system-audio loopback in this scope.
        finish(entry, source ? { video: source } : null);
      },
      () => finish(entry, null)
    );
  }

  /** Teardown hook: close the picker, deny the pending request (once), forget it. */
  function abortPending() {
    try {
      picker.abortPending();
    } catch (err) {
      log('[gcd] picker abort failed', err && err.name);
    }
    if (pending) finish(pending, null);
  }

  return { handler, abortPending };
}

module.exports = {
  meetOriginGate,
  meetMediaGate,
  meetWakeLockGate,
  decideMeetRequest,
  decideMeetCheck,
  createDisplayMediaGate,
};
