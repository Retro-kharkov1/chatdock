'use strict';

// Scaffold note (Task 1 of docs/development/plan-google-chat-desktop-mvp.md): this file
// currently exports only the two pure decision functions covered by Task 0's test net,
// `isAllowedSender` and `decideSingleInstanceAction`. The actual app bootstrap — single-instance
// lock acquisition, `app.whenReady()`, BrowserWindow/Tray creation, session/notification/IPC
// wiring described in the sibling architecture docs — is implemented in a later pass (tasks 2-7)
// and deliberately does not exist yet. Requiring this file does not start an Electron app or
// touch any Electron API, which is what keeps these two functions unit-testable under plain
// `node:test` (no Electron runtime needed).

/**
 * isAllowedSender(frameOrigin, allowlist)
 *
 * Pure check behind docs/architecture/ipc-contract.md's "Sender validation" section: before
 * acting on the `notification:clicked` IPC message, the main-process handler (wired in a later
 * pass) must confirm the message actually came from a frame whose origin is one this app
 * legitimately loads (`chat.google.com`, plus `accounts.google.com` during sign-in — see
 * docs/architecture/overview.md's `will-navigate` allowlist), not from some other origin that
 * ended up execution context via a bug or a compromised page.
 *
 * @param {string} frameOrigin The origin to check, as read from `event.senderFrame`'s origin
 *   (e.g. `"https://chat.google.com"`). Origins never include a path, so this is a plain string
 *   equality check against the allowlist — no prefix/substring matching, precisely so a
 *   similar-looking-but-different origin (e.g. `"https://chat.google.com.evil.example"` or
 *   `"https://evilchat.google.com"`) is rejected rather than accidentally matched.
 * @param {string[]} allowlist The allowed origins (see overview.md's `will-navigate` allowlist —
 *   the same list backs both checks, per ipc-contract.md).
 * @returns {boolean} `true` only if `frameOrigin` is a case-sensitive exact match for one entry
 *   in `allowlist`. `false` for any non-string `frameOrigin`, an empty/missing allowlist, or no
 *   match — never throws.
 */
function isAllowedSender(frameOrigin, allowlist) {
  if (typeof frameOrigin !== 'string' || !Array.isArray(allowlist)) return false;
  return allowlist.includes(frameOrigin);
}

/**
 * decideSingleInstanceAction(gotLock)
 *
 * Pure mapping behind FR-08 / docs/architecture/tray-lifecycle.md's single-instance
 * enforcement: `app.requestSingleInstanceLock()` returns a boolean, and this function names the
 * two branches that boolean selects, so the branch-selection itself is unit-testable without a
 * real second Electron process.
 *
 * @param {boolean} gotLock The return value of `app.requestSingleInstanceLock()`.
 * @returns {'quit'|'proceed'} `'quit'` when `gotLock` is falsy — another instance already holds
 *   the lock, and this process must call `app.quit()` immediately without creating any window.
 *   `'proceed'` when `gotLock` is truthy — this is the primary instance; continue with
 *   `app.on('second-instance', ...)` registration and normal `app.whenReady()` startup.
 */
function decideSingleInstanceAction(gotLock) {
  return gotLock ? 'proceed' : 'quit';
}

module.exports = { isAllowedSender, decideSingleInstanceAction };
