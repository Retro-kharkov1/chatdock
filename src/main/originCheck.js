'use strict';

/**
 * isAllowedSender(frameOrigin, allowlist)
 *
 * Pure check behind docs/architecture/ipc-contract.md's "Sender validation" section: before acting
 * on an IPC message from web content (a frame, or a service worker's scope), confirm its origin is
 * one this app legitimately loads. Origins never include a path, so this is a plain, case-sensitive
 * string equality check - no prefix/substring matching, precisely so a look-alike origin
 * (`https://chat.google.com.evil.example`) is rejected.
 *
 * @param {string} frameOrigin
 * @param {string[]} allowlist
 * @returns {boolean} never throws.
 */
function isAllowedSender(frameOrigin, allowlist) {
  if (typeof frameOrigin !== 'string' || !Array.isArray(allowlist)) return false;
  return allowlist.includes(frameOrigin);
}

module.exports = { isAllowedSender };
