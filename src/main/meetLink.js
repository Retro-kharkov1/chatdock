'use strict';

// NFR-07 / docs/architecture/meet-call-window.md section 2. The ONLY place that decides "call
// window or system browser" for a link, and which schemes may reach the OS. Pure: no Electron
// import, never throws for any input type.

const MEET_ORIGIN = 'https://meet.google.com';
const { unwrapTarget } = require('./wrapperUrl');

const OPENABLE_SCHEMES = Object.freeze(['http:', 'https:', 'mailto:']);

function parse(input) {
  if (typeof input !== 'string') return null;
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

/** True only for https://meet.google.com (default port normalised away), no userinfo. */
function isMeetUrl(u) {
  return u !== null && u.origin === MEET_ORIGIN && u.username === '' && u.password === '';
}

/**
 * classifyLink(input) -> { outcome: 'call-window' | 'system-browser', url }
 * `url` is the normalised href of the TARGET (never the raw input or the wrapper).
 */
function classifyLink(input) {
  const SYSTEM = { outcome: 'system-browser', url: typeof input === 'string' ? input : '' };
  const u = parse(input);
  if (u === null) return SYSTEM;
  if (isMeetUrl(u)) return { outcome: 'call-window', url: u.href };
  const target = unwrapTarget(u);
  if (target === null) return SYSTEM;
  const t = parse(target);
  if (isMeetUrl(t)) return { outcome: 'call-window', url: t.href };
  return SYSTEM;
}

/** isOpenableExternalScheme(url) - http:, https: or mailto: only; everything else is not opened. */
function isOpenableExternalScheme(url) {
  const u = parse(url);
  return u !== null && OPENABLE_SCHEMES.includes(u.protocol);
}

module.exports = { MEET_ORIGIN, classifyLink, isOpenableExternalScheme };
