'use strict';

// BUG-09 diagnostics. A small, privacy-safe, rotating file log for permission decisions, window-open / navigation
// routing and main-window console warnings/errors. No Electron import: the sink is installed by index.js.
//
// Privacy contract (rule electron-security-baseline): this module only ever receives values that went through
// redactUrl / redactOrigin / truncateText. It never sees cookies, headers, tokens, request bodies or message
// content, and a URL is reduced to scheme + host + path (no userinfo, query or fragment) before it is written.

const fs = require('fs');
const path = require('path');

const MAX_CONSOLE_CHARS = 300;
const MAX_PATH_CHARS = 200;
const MAX_FILE_BYTES = 1024 * 1024;
const LOG_FILE_NAME = 'diagnostics.log';

/**
 * redactUrl(value) -> string
 * http(s)/ws(s)/ftp/file: scheme://host[:port]/path (userinfo, query, fragment dropped; path capped).
 * about:blank / about:srcdoc: kept verbatim (no data in them). blob:<origin>/..: blob:<origin>/ only.
 * Every other scheme (data:, javascript:, mailto:, custom): the scheme alone, e.g. "data:".
 * Not a string or not parseable: "<unparseable>".
 */
function redactUrl(value) {
  if (typeof value !== 'string' || value === '') return '<unparseable>';
  let u;
  try {
    u = new URL(value);
  } catch {
    return '<unparseable>';
  }
  const scheme = u.protocol; // includes the colon
  if (scheme === 'about:') return u.href === 'about:blank' || u.href === 'about:srcdoc' ? u.href : 'about:';
  if (scheme === 'blob:') {
    try {
      return `blob:${new URL(u.pathname).origin}/`;
    } catch {
      return 'blob:';
    }
  }
  if (['http:', 'https:', 'ws:', 'wss:', 'ftp:', 'file:'].includes(scheme)) {
    const pathname = u.pathname.length > MAX_PATH_CHARS ? `${u.pathname.slice(0, MAX_PATH_CHARS)}...` : u.pathname;
    return `${scheme}//${u.host}${pathname}`;
  }
  return scheme;
}

/** redactOrigin(value) -> origin of a URL / origin string ("null" for opaque), "<none>" when absent, "<unparseable>". */
function redactOrigin(value) {
  if (value === undefined || value === null || value === '') return '<none>';
  if (typeof value !== 'string') return '<unparseable>';
  try {
    const o = new URL(value).origin;
    return o;
  } catch {
    return '<unparseable>';
  }
}

/**
 * truncateText(text, max) -> string
 * One line (whitespace runs collapsed), any URL inside the text reduced through redactUrl, then cut to `max`
 * characters with a marker carrying the number of characters dropped.
 */
function truncateText(text, max = MAX_CONSOLE_CHARS) {
  if (typeof text !== 'string') return '';
  const oneLine = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi, (m) => redactUrl(m));
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}...(+${oneLine.length - max} chars)`;
}

/** formatLine(event, fields) -> "<event> k=v k=v" with string values JSON-quoted (so spaces/newlines cannot forge fields). */
function formatLine(event, fields) {
  const parts = [event];
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined) continue;
    parts.push(`${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`);
  }
  return parts.join(' ');
}

/**
 * createDiagLogger({ write, now }) -> { diag(event, fields), setWrite(fn) }
 * `write(line)` receives a complete line (timestamp included). Without a writer, diag() is a no-op, so importing
 * modules stay inert in unit tests. Identical consecutive lines are collapsed ("repeated xN" is written once the
 * next different line arrives). diag never throws.
 */
function createDiagLogger({ write, now = () => new Date().toISOString() } = {}) {
  let sink = typeof write === 'function' ? write : null;
  let last = null;
  let repeats = 0;

  function flushRepeats() {
    if (repeats > 0 && sink) sink(`${now()} repeated x${repeats}`);
    repeats = 0;
  }

  function diag(event, fields) {
    if (!sink) return;
    try {
      const body = formatLine(event, fields);
      if (body === last) {
        repeats += 1;
        return;
      }
      flushRepeats();
      last = body;
      sink(`${now()} ${body}`);
    } catch {
      // diagnostics must never affect the app
    }
  }

  return {
    diag,
    setWrite(fn) {
      sink = typeof fn === 'function' ? fn : null;
      last = null;
      repeats = 0;
    },
  };
}

/**
 * createRotatingFileWriter(dir, { maxBytes, fsImpl }) -> { write(line), file }
 * Appends to <dir>/diagnostics.log; past maxBytes the file becomes diagnostics.1.log (one previous generation kept).
 * Synchronous on purpose (a few short lines per call attempt) and never throws.
 */
function createRotatingFileWriter(dir, { maxBytes = MAX_FILE_BYTES, fsImpl = fs } = {}) {
  const file = path.join(dir, LOG_FILE_NAME);
  const previous = path.join(dir, 'diagnostics.1.log');
  let size = null;
  function write(line) {
    try {
      if (size === null) {
        fsImpl.mkdirSync(dir, { recursive: true });
        try {
          size = fsImpl.statSync(file).size;
        } catch {
          size = 0;
        }
      }
      const text = `${line}\n`;
      if (size + Buffer.byteLength(text) > maxBytes) {
        try {
          fsImpl.renameSync(file, previous);
        } catch {
          // no current file to rotate
        }
        size = 0;
      }
      fsImpl.appendFileSync(file, text);
      size += Buffer.byteLength(text);
    } catch {
      // diagnostics must never affect the app
    }
  }
  return { write, file };
}

const shared = createDiagLogger();

/** initDiagLog(dir, header) - installs the file sink for the shared logger and writes a start line. Returns the file path. */
function initDiagLog(dir, header) {
  const writer = createRotatingFileWriter(dir);
  shared.setWrite(writer.write);
  shared.diag('diag-start', header);
  return writer.file;
}

module.exports = {
  LOG_FILE_NAME,
  MAX_CONSOLE_CHARS,
  redactUrl,
  redactOrigin,
  truncateText,
  formatLine,
  createDiagLogger,
  createRotatingFileWriter,
  initDiagLog,
  diag: shared.diag,
};
