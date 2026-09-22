# Notifications (FR-05)

<overview>
The full design and its rationale live in
[ADR-0002](../adr/0002-notification-delivery-mechanism.md) — read that first. This doc is the
concrete implementation surface an implementer builds against.
</overview>

<architecture>
## Three independent pieces

### 1. Notification content + timing — native bridge, unmodified
No code beyond configuration: `webPreferences.backgroundThrottling: false` on the single
`BrowserWindow`, plus `session.setPermissionRequestHandler` on the `persist:google-chat` session
granting `notifications` (deny everything else by default). Google Chat's own page JS calls
`new Notification(...)` exactly as it would in a background browser tab; Electron/Chromium bridges
that straight to the OS notification center. Nothing in this piece touches sender/preview content.

### 2. Click → window focus, AND landing on the specific conversation — minimal main-world injection

**Sharpened requirement (owner, this pass):** clicking a notification must not just bring the app
to the foreground — it must land the user on the **specific conversation/message the notification
was for**. "Window comes back showing whatever was last open" does not satisfy FR-05. The owner's
own framing used the word "hooks," describing exactly the interception mechanism below — this is
that mechanism's actual job, not a separate feature.

**Does the page already do this for us? Established here, to be confirmed empirically at task 5.**
The wrapper below **delegates to the original `Notification` constructor and returns the real,
unmodified `Notification` instance** to Google Chat's own calling code. This matters because it
means Chat's own JS — not this wrapper — holds a live reference to that same object and can attach
its own `onclick`/`addEventListener('click', ...)` handler to it, exactly as it would in a plain
browser tab. The Web Notifications API allows multiple independent click listeners on one
`Notification` instance (an `onclick` property assignment and any number of `addEventListener`
listeners all fire on the same click, in registration order) — the wrapper's own listener does not
call `preventDefault()` or `stopImmediatePropagation()`, so it cannot block Chat's own handler from
also firing. **If Google Chat's web app already wires its own Notification objects' click handlers
to its in-page router** (the same behavior it has in a background browser tab, which is the whole
premise FR-05 was scoped around), then the deep-link navigation happens automatically, for free,
the moment the click event fires — this wrapper does not need to know which conversation a
notification was for; it never has to.

This is a testable, not assumed, claim: task 5's real-desktop verification must confirm Chat's page
actually attaches a navigating click handler to its own `Notification` objects (observable as: click
a notification while the window is hidden, and the correct conversation is visibly open once the
window is shown — not just "a" conversation, or whatever was last open). If real testing shows Chat
does **not** wire click-to-navigate on its own notifications (possible if Chat relies on some other
signal, e.g. the Page Visibility/focus event, to trigger navigation only when a tab is already
foregrounded), this piece degrades to the **named fallback** below — build it only if task 5 shows
the automatic case fails, not speculatively.

**Also carries FR-11/FR-12 (sound/mute)**, since this is the one place `Notification` calls are
actually intercepted — see [tray-lifecycle.md](tray-lifecycle.md)'s "Sound & mute" section for where
`window.__gcdSoundEnabled`/`window.__gcdMuted` are set from the main process on toggle. This is the
canonical wrapper snippet; tray-lifecycle.md does not repeat it.

```js
webContents.executeJavaScript(`
  (() => {
    if (window.__gcdNotifyPatched) return;
    window.__gcdNotifyPatched = true;
    const Original = window.Notification;
    window.Notification = function (title, options) {
      if (window.__gcdMuted) {
        // FR-12: suppress entirely. Return a stub so page code calling n.close()/
        // addEventListener afterward doesn't throw, but no real OS notification is created.
        return { close() {}, addEventListener() {}, removeEventListener() {} };
      }
      // FR-11: force silent when sound is toggled off, unless the page already asked for silent.
      const n = new Original(title, { ...options, silent: options.silent || !window.__gcdSoundEnabled });
      // Own listener only, added in addition to whatever Chat's own code does with `n`
      // afterward (n.onclick = ...  or n.addEventListener('click', ...)). Never calls
      // preventDefault/stopImmediatePropagation — must never block Chat's own handler.
      n.addEventListener('click', () => {
        window.__gcdBridge && window.__gcdBridge.notificationClicked();
      });
      return n;
    };
    window.Notification.permission = Original.permission;
    window.Notification.requestPermission = Original.requestPermission.bind(Original);
  })();
`, /* userGesture */ false);
```
`window.__gcdSoundEnabled`/`window.__gcdMuted` are set by the same `executeJavaScript` re-injection
path immediately before/after the snippet above (their current values, from `settings.json`, are
interpolated in at injection time and updated live on every tray toggle — see tray-lifecycle.md).

`window.__gcdBridge` is exposed by the preload via `contextBridge.exposeInMainWorld` (see
[IPC Contract](ipc-contract.md) — `notificationClicked`). The original constructor is always
delegated to first and the same live object is returned, so Google Chat's own registered
`click`/`onclick` handling still runs unmodified — this wrapper adds only the OS-window-focus step,
per the space's `wrapper-not-a-rewrite` rule.

**Ordering, made explicit** (this is where a race could otherwise hide): both listeners — Chat's own
and this wrapper's — are attached to the *same* click event and fire synchronously, in the
renderer's own event-loop turn, **independently of window visibility**. Because piece 1 already
keeps the page's JS running while hidden (`backgroundThrottling: false`), Chat's in-page SPA
navigation is not gated on the window being shown — it runs (and, in the normal case, completes,
since client-side route changes are synchronous DOM/state updates, not network-bound) whether or
not `win.show()` has happened yet. This wrapper's own listener independently sends a fire-and-forget
IPC message; the main process's `win.show(); win.focus();` (below) runs asynchronously relative to
the renderer's navigation. **Net effect**: by the time the window is actually shown, Chat's own
navigation has normally already happened in the background, so the user sees the right conversation
the instant the window appears — there is no user-visible race in the common case. Two edge cases to
name rather than silently hand-wave:
- **Page mid-reload when the notification is clicked** (e.g. `did-finish-load` just fired and the
  wrapper is mid-re-injection): the clicked `Notification` instance may belong to a torn-down page
  context. Treat this the same as the fallback below — show/focus the window, land wherever the
  reloaded page currently is, and log it as a known degraded case rather than erroring.
- **App was fully quit (not just hidden to tray) when a stale OS notification from a previous run is
  clicked**: there is no live process to receive the click. This is a known limitation of the
  mechanism (not fixable without a native OS toast-activation/relaunch integration, out of scope for
  this personal utility) — clicking a notification after the app has fully exited may do nothing or
  simply relaunch the app to its default view, not the specific conversation.

Main-process handler:

```js
ipcMain.on('notification:clicked', () => {
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});
```

**Failure mode to log, not swallow**: if `executeJavaScript` throws (e.g. CSP change on Google's
side) or the injected wrapper is never invoked (e.g. Chat redefines `window.Notification` after
both `dom-ready` and `did-finish-load`), the implementer logs this distinctly rather than letting
click-to-focus silently stop working — this is the fragility ADR-0002 already calls out, and it is
also the skeptic-flagged most fragile point of this whole design (injecting into a page Google
controls and can change at any time).

**Fallback — named, degraded, and must be surfaced as such, not silently substituted.** If task 5's
verification shows Chat's own page does *not* navigate to the right conversation on notification
click (see "Does the page already do this for us?" above), the implementer builds a best-effort
substitute rather than leaving click-to-focus doing nothing useful: parse whatever conversation
identifier is available from the `Notification`'s own `options` (Chat's own notifications commonly
carry a `tag`, `data`, or a deep-link `body`/`icon` URL — the exact shape must be inspected from a
real notification object during task 5, not guessed here) and, if a usable identifier is found,
navigate the page via `location.hash`/`history.pushState` equivalent that Chat's own router
responds to; if no usable identifier is found, **fall back further to just showing/focusing the
window on whatever conversation is currently open, and log this explicitly as the degraded path**
(e.g. `console.warn('[gcd] notification click could not resolve a target conversation, showing
default view')`) so it is visible in the implementer's/owner's own verification rather than passing
as if deep-linking worked. Do not build any of this speculatively — only after task 5 proves the
automatic (page-native) path insufficient.

### 3. Tray unread indicator — `page-title-updated`, no injection
```js
mainWindow.webContents.on('page-title-updated', (event, title) => {
  const match = title.match(/^\((\d+)\)/);
  setTrayUnread(match ? Number(match[1]) : 0);
});
```
`setTrayUnread(n)` (in `src/main/tray.js`): `win.setOverlayIcon(icon, 'Unread messages')` /
`win.setOverlayIcon(null, '')` on Windows, and swapping the `Tray`'s image between a plain and a
badged/dot variant on Linux (no standard OS badge API there — NFR-01 already accepts this as a
platform difference, not a defect). macOS is out of scope per [ADR-0003](../adr/0003-packaging-and-code-signing-approach.md);
no Dock-badge code path exists. Cleared when `n === 0` or when the window regains focus while
showing the relevant conversation.

## Fallback — the primary contingency for a known Windows bug, not a speculative edge case
`electron/electron#31016` documents that on Windows, `backgroundThrottling: false` does **not**
reliably keep a window's script execution live when it is hidden via `win.hide()` (the exact
mechanism [tray-lifecycle.md](tray-lifecycle.md) uses for close-to-tray) — as opposed to merely
occluded or minimized, where it works fine. The fix (`electron/electron#38924`) only ships starting
with Electron 27+ and was explicitly marked `no-backport`. See [ADR-0002](../adr/0002-notification-delivery-mechanism.md)
for the full citation and the pinned-Electron-version check this implies.

**Concrete trigger for adopting this fallback**: task 5's real-desktop verification (window hidden
via close-to-tray, a real message sent) shows a notification missing or delayed. When that happens,
do not keep debugging piece 1 — the root cause is already identified as Electron/Chromium's own
compositor behavior, not something fixable in this app's code. Go straight to the fallback.

Design (full detail in ADR-0002's "Risks" section): a `page-title-updated` unread-count-transition
(`0 → N`) fires a **main-process** `Notification` with generic content (sender/preview not
recoverable this way), whose `click` handler is the native `notification.on('click', ...)` API — no
injection needed for this path. This stays event-driven (no timer), so it does not violate NFR-02.
</architecture>
