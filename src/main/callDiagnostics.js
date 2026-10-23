'use strict';

// BUG-09 call-failure diagnostics (log only). Wires Electron events to the redacting diag log. It changes no
// permission, origin or navigation behaviour: every handler only calls `diag` and never throws.
//
// Privacy contract (rule electron-security-baseline): only redactUrl / redactOrigin / truncateText output and
// numbers / enum-like reason strings are written. No cookies, headers, request bodies or message text.
// No Electron import here: index.js passes `app` and the contents in, so the module is unit-testable.

const { redactUrl, redactOrigin, truncateText } = require('./diagLog');

const MAX_FEATURES_CHARS = 120;
const MAX_SWITCH_VALUE_CHARS = 200;

// Chromium switches that change WebRTC / media / GPU behaviour. Nothing in this app sets them today (checked:
// no appendSwitch in src); the log line says so, and shows them if an environment or a later change sets any.
const WEBRTC_SWITCHES = [
  'disable-webrtc',
  'disable-webrtc-hw-encoding',
  'disable-webrtc-hw-decoding',
  'force-webrtc-ip-handling-policy',
  'webrtc-ip-handling-policy',
  'enforce-webrtc-ip-permission-check',
  'disable-features',
  'enable-features',
  'disable-gpu',
  'use-fake-ui-for-media-stream',
  'use-fake-device-for-media-stream',
  'allow-loopback-in-peer-connection',
];

function str(value, max) {
  return typeof value === 'string' ? truncateText(value, max) : undefined;
}

function safeUrl(contents) {
  try {
    return contents && !contents.isDestroyed() ? contents.getURL() : undefined;
  } catch {
    return undefined;
  }
}

/** Runs a handler body; a diagnostics fault must never reach the app. */
function guarded(fn) {
  return (...args) => {
    try {
      fn(...args);
    } catch {
      // diagnostics must never affect the app
    }
  };
}

/**
 * attachContentsDiagnostics(contents, { diag, owner }) - load failures (frames included) and media state of one
 * WebContents. `did-fail-load` fires for the main frame and for sub-frames (isMainFrame=false); the Meet call inside
 * Chat is a sub-frame. `did-fail-provisional-load` is the older, earlier-stage twin and has the same arguments.
 */
function attachContentsDiagnostics(contents, { diag, owner = 'main' }) {
  const onFail = (eventName) =>
    guarded((_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      diag(eventName, {
        owner,
        mainFrame: Boolean(isMainFrame),
        code: errorCode,
        description: str(errorDescription, 80),
        url: redactUrl(validatedURL),
      });
    });
  contents.on('did-fail-load', onFail('did-fail-load'));
  contents.on('did-fail-provisional-load', onFail('did-fail-provisional-load'));
  // media-started-playing / media-paused carry no arguments: log which page (origin only) they came from.
  contents.on(
    'media-started-playing',
    guarded(() => diag('media-started-playing', { owner, origin: redactOrigin(safeUrl(contents)) }))
  );
  contents.on(
    'media-paused',
    guarded(() => diag('media-paused', { owner, origin: redactOrigin(safeUrl(contents)) }))
  );
}

/**
 * attachProcessDiagnostics(app, { diag }) - renderer crashes of any WebContents and every non-renderer child process
 * (GPU, network service, utility) that exits abnormally.
 */
function attachProcessDiagnostics(app, { diag }) {
  app.on(
    'render-process-gone',
    guarded((_event, webContents, details) => {
      diag('render-process-gone', {
        origin: redactOrigin(safeUrl(webContents)),
        reason: details && details.reason,
        exitCode: details && details.exitCode,
      });
    })
  );
  app.on(
    'child-process-gone',
    guarded((_event, details) => {
      diag('child-process-gone', {
        type: details && details.type,
        reason: details && details.reason,
        exitCode: details && details.exitCode,
        service: details && str(details.serviceName, 80),
        name: details && str(details.name, 80),
      });
    })
  );
}

/**
 * describeDeniedBlankOpen(details) -> fields for the `window-open-blank` line, or null when the target is not
 * about:blank. Origin of the opener (the `referrer` Electron reports for the call; HandlerDetails carries no frame
 * object), the disposition and the features string. No URL beyond the origin, no query.
 */
function describeDeniedBlankOpen(details) {
  if (!details || redactUrl(details.url) !== 'about:blank') return null;
  return {
    openerOrigin: redactOrigin(details.referrer && details.referrer.url),
    disposition: details.disposition,
    features: str(details.features, MAX_FEATURES_CHARS),
  };
}

/** logWebRtcSwitches(app, { diag }) - one line: which WebRTC-relevant Chromium switches are set, with values. */
function logWebRtcSwitches(app, { diag }) {
  try {
    const cl = app.commandLine;
    const set = {};
    for (const name of WEBRTC_SWITCHES) {
      if (cl.hasSwitch(name)) set[name] = str(cl.getSwitchValue(name), MAX_SWITCH_VALUE_CHARS) || '';
    }
    const names = Object.keys(set);
    diag('webrtc-switches', {
      count: names.length,
      switches: names.length ? JSON.stringify(set) : 'none',
    });
  } catch {
    // diagnostics must never affect the app
  }
}

// ---- BUG-09 network evidence (log only) --------------------------------------------------------------------------
// Chat session webRequest.onErrorOccurred / onCompleted. Electron keeps ONE listener per webRequest event per session
// and a later registration replaces an earlier one; nothing else in src registers one (checked), and this is the only
// place that does. There is no main-process WebRTC (ICE / peer connection) signal without injecting into the page, so
// none is added: the evidence is the network layer only.
//
// Privacy: only the host (exact-suffix allow-listed), the resource type, the error string and numeric status counts
// are written. No path, query, headers, cookies or bodies; the URL is parsed here and discarded.

const NET_HOST_SUFFIXES = ['google.com', 'googleapis.com', 'gstatic.com', 'googlevideo.com', 'googleusercontent.com'];
const NET_MAX_LINES_PER_MINUTE = 60;
const NET_FLUSH_MS = 30000;
const NET_MAX_HOSTS = 50;

/** hostOfInterest(url) -> lower-case host when it equals an allow-listed domain or is a subdomain of it, else null. */
function hostOfInterest(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  for (const d of NET_HOST_SUFFIXES) {
    if (host === d || host.endsWith(`.${d}`)) return host;
  }
  return null;
}

/**
 * attachNetworkDiagnostics(session, { diag, now, maxLinesPerMinute, flushMs, setIntervalFn, clearIntervalFn })
 * Returns { flush, dispose }. Lines per minute are capped; excess lines are counted and reported once per minute as
 * `net-diag-suppressed`.
 */
function attachNetworkDiagnostics(session, opts) {
  const {
    diag,
    now = Date.now,
    maxLinesPerMinute = NET_MAX_LINES_PER_MINUTE,
    flushMs = NET_FLUSH_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = opts;
  let windowStart = now();
  let used = 0;
  let suppressed = 0;
  const counts = new Map(); // "host status" -> n

  const roll = () => {
    const t = now();
    if (t - windowStart >= 60000) {
      windowStart = t;
      used = 0;
      if (suppressed > 0) {
        const n = suppressed;
        suppressed = 0;
        diag('net-diag-suppressed', { lines: n });
        used = 1;
      }
    }
  };
  const emit = (event, fields) => {
    roll();
    if (used >= maxLinesPerMinute) {
      suppressed += 1;
      return;
    }
    used += 1;
    diag(event, fields);
  };
  const flush = guarded(() => {
    if (counts.size === 0) return;
    const parts = [...counts.entries()].map(([k, n]) => `${k}=${n}`);
    counts.clear();
    emit('net-status', { non2xx: parts.join(' ') });
  });

  try {
    session.webRequest.onErrorOccurred(
      guarded((details) => {
        const host = hostOfInterest(details && details.url);
        if (!host) return;
        emit('net-error', {
          host,
          resourceType: str(details.resourceType, 30),
          error: str(details.error, 60),
        });
      })
    );
    session.webRequest.onCompleted(
      guarded((details) => {
        const code = details && details.statusCode;
        if (typeof code !== 'number' || (code >= 200 && code < 300)) return;
        const host = hostOfInterest(details.url);
        if (!host) return;
        const key = `${host} ${code}`;
        if (counts.has(key) || counts.size < NET_MAX_HOSTS) counts.set(key, (counts.get(key) || 0) + 1);
      })
    );
  } catch {
    // diagnostics must never affect the app
  }
  const timer = setIntervalFn(flush, flushMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return {
    flush,
    dispose: () => {
      try {
        clearIntervalFn(timer);
      } catch {
        // ignore
      }
    },
  };
}

module.exports = {
  NET_HOST_SUFFIXES,
  attachNetworkDiagnostics,
  hostOfInterest,
  WEBRTC_SWITCHES,
  attachContentsDiagnostics,
  attachProcessDiagnostics,
  describeDeniedBlankOpen,
  logWebRtcSwitches,
};
