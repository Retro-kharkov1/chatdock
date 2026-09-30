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

/**
 * buildNotificationBridgeScript(soundEnabled, muted)
 *
 * Builds the exact `webContents.executeJavaScript()` payload from notifications.md piece 2: sets
 * the two globals the injected wrapper reads (`window.__gcdSoundEnabled`/`window.__gcdMuted`)
 * *before* the wrapper snippet, per tray-lifecycle.md's "Sound & mute" section, then defines the
 * wrapper itself — a one-time (`window.__gcdNotifyPatched` guarded) monkey-patch of
 * `window.Notification` that:
 *   - suppresses entirely when muted (FR-12), returning a stub so page code calling
 *     `n.close()`/`addEventListener()` afterward doesn't throw;
 *   - otherwise delegates to the real `Notification` constructor and returns the same live
 *     instance Chat's own page code receives, so Chat's own click/onclick handling — and any
 *     in-page deep-link navigation it does — keeps running unmodified (per the space's
 *     `wrapper-not-a-rewrite` rule and notifications.md piece 2's "Does the page already do this
 *     for us?" section);
 *   - forces `silent: true` when sound is off, unless the page itself already asked for silent
 *     (FR-11), while never blocking Chat's own listeners (no `preventDefault`/
 *     `stopImmediatePropagation` anywhere in this wrapper);
 *   - adds its own `click` listener, in addition to whatever Chat's own code attaches, that calls
 *     `window.__gcdBridge.notificationClicked()` (see ipc-contract.md) so the main process can
 *     show/focus the window.
 *
 * The branching here intentionally mirrors `shouldMuteOrSilence` above (that function is what
 * task 0's unit net actually covers, since this string must run inside the page's own JS context
 * and can't `require()` it directly — see that function's own JSDoc). This string is injected on
 * both `dom-ready` and `did-finish-load` (index.js), and again on every sound/mute toggle, so the
 * globals and the patch are always current even if Chat's own page later redefines
 * `window.Notification` (in which case `window.__gcdNotifyPatched` no longer guards it — see the
 * "Failure mode to log, not swallow" note in notifications.md, handled by the caller's own
 * try/catch around `executeJavaScript`, not inside this string).
 *
 * @param {boolean} soundEnabled Current value of the FR-11 setting.
 * @param {boolean} muted Current value of the FR-12 setting.
 * @returns {string} A self-contained script to hand to `webContents.executeJavaScript()`.
 */
function buildNotificationBridgeScript(soundEnabled, muted) {
  const soundEnabledLiteral = JSON.stringify(Boolean(soundEnabled));
  const mutedLiteral = JSON.stringify(Boolean(muted));
  return `
    window.__gcdSoundEnabled = ${soundEnabledLiteral};
    window.__gcdMuted = ${mutedLiteral};
    (() => {
      if (window.__gcdNotifyPatched) return;
      window.__gcdNotifyPatched = true;
      const bridge = () => window.__gcdBridge;
      const Original = window.Notification;
      window.Notification = function (title, options) {
        if (window.__gcdMuted) {
          return { close() {}, addEventListener() {}, removeEventListener() {} };
        }
        const n = new Original(title, {
          ...options,
          silent: Boolean(options && options.silent) || !window.__gcdSoundEnabled,
        });
        n.addEventListener('click', () => {
          bridge() && bridge().notificationClicked();
        });
        // The page made its own native toast; only tell main a message arrived (FR-14 trigger).
        try { bridge() && bridge().notificationArrived && bridge().notificationArrived(); } catch (e) {}
        return n;
      };
      window.Notification.permission = Original.permission;
      window.Notification.requestPermission = Original.requestPermission.bind(Original);

      // BUG-01-B, page-initiated service-worker notifications. POLICY (same as the service-worker
      // preload, see nativeToast.js): Electron shows NO toast for
      // ServiceWorkerRegistration.showNotification (verified on 44.4.3 / Windows), so the request
      // is forwarded to the main process, which raises the real toast and applies sound (FR-11) on
      // its side, and the ORIGINAL is NOT called - it would only double up if Electron ever fixed
      // it. The original is the fallback when forwarding is impossible, so nothing is lost.
      // Calls made by Chat's own service worker never pass through this page realm; those are
      // covered by the service-worker preload (preload/serviceWorkerPreload.js).
      const SWR = window.ServiceWorkerRegistration;
      if (SWR && SWR.prototype && typeof SWR.prototype.showNotification === 'function') {
        const originalShow = SWR.prototype.showNotification;
        SWR.prototype.showNotification = function (title, options) {
          if (window.__gcdMuted) return Promise.resolve(); // FR-12: suppressed entirely.
          const opts = options || {};
          const silent = Boolean(opts.silent) || !window.__gcdSoundEnabled;
          const b = bridge();
          if (b && typeof b.notificationShow === 'function') {
            try {
              b.notificationShow({
                title: String(title),
                body: typeof opts.body === 'string' ? opts.body : '',
                silent,
                tag: typeof opts.tag === 'string' ? opts.tag : '',
              });
              return Promise.resolve();
            } catch (e) {
              // fall through to the original
            }
          }
          return originalShow.call(this, title, { ...options, silent });
        };
      }
    })();
  `;
}

/**
 * attachUnreadTitleListener(webContents, onUnreadChange)
 *
 * Wires notifications.md piece 3 (tray unread indicator): Google Chat prefixes its tab title with
 * `(N)` while there are unread messages; this listens for `page-title-updated` and reports the
 * parsed count via `parseUnreadCount` (task 0's covered function — not a re-implementation of the
 * same regex, per the plan's task 6 done-criteria). No polling — purely event-driven, per NFR-02.
 *
 * @param {Electron.WebContents} webContents
 * @param {(unreadCount: number) => void} onUnreadChange
 */
function attachUnreadTitleListener(webContents, onUnreadChange) {
  webContents.on('page-title-updated', (_event, title) => {
    onUnreadChange(parseUnreadCount(title));
  });
}

module.exports = {
  parseUnreadCount,
  shouldMuteOrSilence,
  buildNotificationBridgeScript,
  attachUnreadTitleListener,
};
