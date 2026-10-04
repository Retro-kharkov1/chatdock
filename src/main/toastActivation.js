'use strict';

// BUG-05 (attempt 2): how a toast click finds its way back to the notification record.
//
// Measured on Electron 44.4.3 / Windows 11 (docs/architecture/notifications.md, "Why attempt 1
// failed"): a toast built the default way (activationType "foreground") never delivers a click to
// the app's JS `Notification` object - not from the pop-up, not from the Action Center, not even for
// an object that is kept alive. Windows instead COM-activates the app (`<app>.exe -Embedding`, a
// NEW process that does nothing but quit on the single-instance lock), and no `click` event and no
// `Notification.handleActivation` callback ever arrives. That is why a click only brought the window
// forward (through `second-instance`) and never replayed Chat's handler.
//
// A toast with activationType="protocol" behaves differently: Windows raises the in-process
// `click` for the running app (also from the Action Center, as long as the Notification object is
// still referenced) and additionally launches `<app>.exe <scheme>://toast/<id>`, whose argv reaches
// the running instance through `second-instance` and is the only signal a cold start has. So every
// toast carries our own opaque id in a protocol URL; the record (worker scope + Chat's `data`) is
// kept in memory under that id, and every delivery path resolves through here.
//
// Pure module, no Electron import.

const ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const MAX_RECORDS = 100;

/** Escapes text for use inside an XML element or attribute value. */
function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // characters that are not allowed in XML 1.0 would make Windows reject the whole toast
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
}

/** `<scheme>://toast/<id>` - the activation URL a toast carries. */
function activationUrl(scheme, id) {
  return `${scheme}://toast/${id}`;
}

/**
 * Toast XML equivalent to Electron's own default (title + body, optional silent audio) with a
 * protocol activation. Windows renders the AppUserModelID's name and icon itself.
 * @param {{title: string, body?: string, silent?: boolean, id: string, scheme: string}} req
 */
function buildToastXml({ title, body = '', silent = false, id, scheme }) {
  const lines = [`<text>${escapeXml(title)}</text>`];
  if (body) lines.push(`<text>${escapeXml(body)}</text>`);
  return (
    `<toast launch="${escapeXml(activationUrl(scheme, id))}" activationType="protocol">` +
    `<visual><binding template="ToastGeneric">${lines.join('')}</binding></visual>` +
    (silent ? '<audio silent="true"/>' : '') +
    '</toast>'
  );
}

/**
 * Pulls our toast id out of an activation URL. Anything that is not exactly
 * `<scheme>://toast/<id>` (case-insensitive scheme, optional trailing slash) yields null.
 * @param {unknown} raw
 * @param {string} scheme
 * @returns {string|null}
 */
function parseActivationUrl(raw, scheme) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return null;
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/toast\/([^/?#]*)\/?$/.exec(raw.trim());
  if (!m || m[1].toLowerCase() !== String(scheme).toLowerCase()) return null;
  return ID_PATTERN.test(m[2]) ? m[2] : null;
}

/** First argv entry that is one of our activation URLs, as an id (or null). */
function findActivationId(argv, scheme) {
  if (!Array.isArray(argv)) return null;
  for (const a of argv) {
    const id = parseActivationUrl(a, scheme);
    if (id) return id;
  }
  return null;
}

/**
 * Bounded in-memory store of toast records. The oldest record is dropped past `max`.
 * @param {object} deps
 * @param {() => string} deps.newId Returns a fresh unique id (crypto.randomUUID in production).
 * @param {number} [deps.max]
 */
function createToastRegistry({ newId, max = MAX_RECORDS }) {
  const records = new Map();
  return {
    /** @returns {string} the id to put into the toast's activation URL */
    register(record) {
      const id = newId();
      records.set(id, record);
      if (records.size > max) records.delete(records.keys().next().value);
      return id;
    },
    get: (id) => records.get(id),
    forget: (id) => records.delete(id),
    size: () => records.size,
  };
}

/**
 * Collapses double delivery of one click (the in-process `click` and the `second-instance` argv both
 * arrive for the same click) so a conversation is not opened twice.
 * @param {{windowMs?: number, now?: () => number}} [opts]
 */
function createClickDeduper({ windowMs = 1500, now = Date.now } = {}) {
  const last = new Map();
  return {
    /** @returns {boolean} true when this click for `id` should be acted on */
    accept(id) {
      const t = now();
      const prev = last.get(id);
      if (prev !== undefined && t - prev < windowMs) return false;
      last.set(id, t);
      if (last.size > 200) last.delete(last.keys().next().value);
      return true;
    },
  };
}

module.exports = {
  activationUrl,
  buildToastXml,
  parseActivationUrl,
  findActivationId,
  createToastRegistry,
  createClickDeduper,
  escapeXml,
};
