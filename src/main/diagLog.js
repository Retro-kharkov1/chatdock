'use strict';

// BUG-05 attempt 2: TEMPORARY diagnostic trail for the notification-click path. One line per hop,
// appended to <userData>/logs/notification-diag.log, size-bounded. It exists so the next failure on a
// real signed-in account is read from evidence, not guessed. Remove (or fold into the application
// log, notifications.md section 5) once BUG-05 is settled.
//
// Privacy contract (the Electron security baseline): NEVER message text, titles, bodies, cookies,
// tokens or credentials. Only event names, counts, flags, booleans, timestamps and URL PATHS with
// every identifier-like segment replaced by `:id` (query and fragment dropped, only the query KEY
// names kept). The injectable fs keeps this unit-testable.

const MAX_BYTES = 256 * 1024;

// Only these literal route words survive; any other segment (an id, a name, a number) becomes :id.
const KNOWN_SEGMENTS = new Set(['', 'room', 'dm', 'space', 'chat', 'app', 'u', 'mole', 'thread', 'frame', 'api', 'home', 'welcome']);

function redactPath(pathname) {
  return String(pathname)
    .split('/')
    .map((seg) => (KNOWN_SEGMENTS.has(seg) ? seg : ':id'))
    .join('/');
}

/** `https://host/room/:id?k=:` shape of a URL. Returns '<unparseable>' rather than the raw text. */
function redactUrl(raw, base) {
  try {
    const u = new URL(String(raw), base);
    const keys = [...u.searchParams.keys()].slice(0, 8);
    return `${u.origin}${redactPath(u.pathname)}${keys.length ? '?' + keys.join('&') : ''}${u.hash ? '#frag' : ''}`;
  } catch {
    return '<unparseable>';
  }
}

/**
 * Describes the SHAPE of a JSON value: object keys and value types, strings reduced to a redacted URL
 * path when they look like one, otherwise just their length. Depth- and size-bounded.
 */
function describeShape(value, depth = 0) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') {
    return /^(https?:\/\/|\/)/.test(value) ? `url(${redactUrl(value, 'https://x.invalid')})` : `str(${value.length})`;
  }
  if (t !== 'object') return t;
  if (depth >= 3) return Array.isArray(value) ? '[...]' : '{...}';
  if (Array.isArray(value)) return `[${value.length}${value.length ? ':' + describeShape(value[0], depth + 1) : ''}]`;
  const keys = Object.keys(value).slice(0, 12);
  return '{' + keys.map((k) => `${k.slice(0, 24)}:${describeShape(value[k], depth + 1)}`).join(',') + '}';
}

/**
 * @param {object} deps
 * @param {(file: string, text: string) => void} deps.append
 * @param {(file: string) => number} deps.size
 * @param {(file: string) => void} deps.reset Truncates the file (called when it grew past the cap).
 * @param {string} deps.file
 * @param {() => number} [deps.now]
 * @param {number} [deps.pid]
 */
function createDiagLog({ append, size, reset, file, now = Date.now, pid = 0 }) {
  function note(event, fields = {}) {
    try {
      const parts = [new Date(now()).toISOString(), `pid=${pid}`, event];
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) continue;
        parts.push(`${k}=${String(v).replace(/[\r\n]+/g, ' ').slice(0, 300)}`);
      }
      if (size(file) > MAX_BYTES) reset(file);
      append(file, parts.join(' ') + '\n');
    } catch {
      // diagnostics must never affect the app
    }
  }
  return { note, file };
}

module.exports = { createDiagLog, redactUrl, redactPath, describeShape, MAX_BYTES };
