'use strict';

// The ONE definition of "unwrap a https://www.google.com/url?q=... redirect wrapper" (UI-05 / FR-18,
// docs/architecture/smart-copy.md sections 1 and 6). Shared by meetLink.js, googleLink.js and smartCopy.js.
// Pure: no Electron import, no I/O.

const WRAPPER_ORIGIN = 'https://www.google.com';
const WRAPPER_PATH = '/url';

/**
 * unwrapTarget(u: URL) -> string | null
 * The decoded `q` value when `u` is exactly https://www.google.com/url with a single `q`, no port (the default
 * :443 normalises away) and no userinfo; otherwise null. Unwraps once only: the caller never feeds the result back.
 */
function unwrapTarget(u) {
  if (u.origin !== WRAPPER_ORIGIN || u.username !== '' || u.password !== '') return null;
  if (u.pathname !== WRAPPER_PATH) return null;
  const values = u.searchParams.getAll('q');
  if (values.length !== 1) return null;
  return values[0];
}

module.exports = { WRAPPER_ORIGIN, WRAPPER_PATH, unwrapTarget };
