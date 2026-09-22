'use strict';

/**
 * parseUnreadCount(title)
 *
 * Pure parser behind notifications.md piece 3 (tray unread indicator, FR-05). Google Chat's tab
 * title is prefixed with `(N)` when there are N unread messages (e.g. "(3) Google Chat"); this
 * extracts that count. Wired from `webContents.on('page-title-updated', ...)` in a later pass —
 * this function has no Electron dependency so it is unit-testable on its own.
 *
 * @param {string} title The window/page title, as delivered by `page-title-updated`.
 * @returns {number} The parsed unread count. Returns `0` (never throws, never returns
 *   `NaN`/`undefined`) for: no `(N)` prefix present (e.g. `"Google Chat"`), a malformed prefix
 *   that doesn't match the expected `(<digits>)` shape (e.g. `"(abc) Google Chat"`), an empty
 *   string, or any non-string input.
 */
function parseUnreadCount(title) {
  if (typeof title !== 'string') return 0;
  const match = title.match(/^\((\d+)\)/);
  return match ? Number(match[1]) : 0;
}

/**
 * shouldMuteOrSilence(mutedFlag, soundEnabledFlag, notificationOptions)
 *
 * Pure decision logic behind FR-11 (notification sound toggle) and FR-12 (mute), factored out of
 * the `executeJavaScript` injection string in docs/architecture/notifications.md piece 2 so the
 * branching is testable as plain JS before being interpolated into the injected snippet. The
 * injected wrapper calls this (conceptually — the actual injected string re-implements the same
 * three branches inline, since it must run inside the page's own JS context, not import this
 * module) to decide what to do with each `new Notification(title, options)` call Google Chat's
 * page makes.
 *
 * @param {boolean} mutedFlag Current value of `window.__gcdMuted` (FR-12).
 * @param {boolean} soundEnabledFlag Current value of `window.__gcdSoundEnabled` (FR-11).
 * @param {{silent?:boolean}|null|undefined} notificationOptions The `options` argument the page
 *   passed to `new Notification(title, options)`. May be `undefined`/`null` (the Web
 *   Notifications API allows calling `new Notification(title)` with no options) — treated the
 *   same as `{}`.
 * @returns {null|{silent:boolean}} `null` when the notification must be suppressed entirely
 *   (muted, per FR-12 — regardless of the sound setting): the caller must not construct a native
 *   `Notification` at all in this case. Otherwise, the (shallow-copied) options object to
 *   construct the native `Notification` with, where `silent` has been resolved to:
 *   - `true` if the page's own `options.silent` was already `true` (the page's own request for a
 *     silent notification is always respected, independent of the app's sound setting), OR
 *   - `true` if `soundEnabledFlag` is `false` (FR-11: sound off forces silent), OR
 *   - `false` otherwise (sound on, page didn't request silent — plays normally).
 */
function shouldMuteOrSilence(mutedFlag, soundEnabledFlag, notificationOptions) {
  if (mutedFlag) return null;
  const options = notificationOptions || {};
  return { ...options, silent: Boolean(options.silent) || !soundEnabledFlag };
}

module.exports = { parseUnreadCount, shouldMuteOrSilence };
