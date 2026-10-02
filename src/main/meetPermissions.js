'use strict';

// NFR-07 / docs/architecture/meet-call-window.md section 6: the Meet permission policy.
//
//   meetOriginGate          pure origin gate (requesting AND top-level origin must be Meet)
//   decideMeetRequest       permission REQUEST handler decision for Meet permissions
//   decideMeetCheck         permission CHECK handler decision for Meet permissions
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
function decideMeetRequest(webContents, permission, details) {
  if (!MEET_PERMISSIONS.includes(permission)) return undefined;
  const gate = meetOriginGate({
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
function decideMeetCheck(webContents, permission, requestingOrigin, details) {
  if (!MEET_PERMISSIONS.includes(permission)) return undefined;
  const embedding = details && details.embeddingOrigin;
  const gate = meetOriginGate({
    requestingOrigin: requestingOrigin ?? (details && details.requestingUrl),
    topLevelOrigin: embedding !== undefined && embedding !== null ? embedding : topLevelOfWebContents(webContents),
  });
  if (!gate) return false;
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
  decideMeetRequest,
  decideMeetCheck,
  createDisplayMediaGate,
};
