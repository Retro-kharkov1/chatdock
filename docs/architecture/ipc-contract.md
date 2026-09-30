# IPC Contract

<overview>
The complete, narrow surface `src/preload/preload.js` exposes via `contextBridge`, plus the one
main-world injection used by the notification-click bridge (a different mechanism — see
[Notifications](notifications.md)), plus the separate, smaller surface the Settings window's own
preload exposes (see [Tray & Lifecycle](tray-lifecycle.md)'s "Settings window (FR-15)"), plus two
**provisional** surfaces added by the 2026-09-30 requirements (the Meet contents has none; the call
window's app view, the screen-share picker and an optional service-worker channel are sketched). This is the contract the
implementer and the tests both cite; nothing beyond this list is exposed to the renderer(s).
</overview>

<architecture>
## Main window — `contextBridge.exposeInMainWorld('__gcdBridge', { ... })`

Exposed at `window.__gcdBridge` inside the renderer's **isolated world** (i.e. reachable from the
preload's own code, and from the main-world injection in `notifications.md` via the page's global
`window` object once the preload has run — `contextBridge`-exposed APIs are visible on the page's
`window` object by design, that is the whole point of `exposeInMainWorld`).

| Exposed function (`window.__gcdBridge.<name>`) | Wire IPC channel | Direction | Payload | Purpose |
|---|---|---|---|---|
| `notificationClicked()` | `'notification:clicked'` | renderer → main, `ipcRenderer.send` (fire-and-forget) | none | Sent by the injected page-`Notification` click wrapper (mechanism M1 in [notifications.md](notifications.md)). Main responds by showing/focusing the window (FR-05c step 1). No response value. **Mechanism-dependent:** if M0, M2 or M3 is chosen, the click is delivered by the OS notification to main (or to Chat's own service worker) and this channel may become unused; remove it then rather than leave an unused bridge. It carries no conversation id, so it cannot serve FR-05c step 2. |

The two names are deliberately different: `notificationClicked` is the JS function exposed on
`window.__gcdBridge` (renderer-facing API surface, camelCase per JS convention); `'notification:clicked'`
is the underlying wire channel name passed to `ipcRenderer.send`/`ipcMain.on` (colon-namespaced per
`electron-desktop.md`'s IPC channel-naming convention). The preload implements the former by calling
`ipcRenderer.send('notification:clicked')` internally — the renderer code and tests never see the
wire channel name directly, only `window.__gcdBridge.notificationClicked()`. Every other reference
to this bridge in this doc set (notifications.md's code snippets, this file's own "Sender
validation" section) uses the wire channel name `'notification:clicked'`, since those are all
main-process-side concerns.

That is the **entire** exposed surface. No `invoke`/`handle` channels exist because nothing in this
wrapper needs a request/response round trip from the renderer — window state, session, tray, and
packaging are all main-process-only concerns with no renderer-side trigger.

## What is deliberately NOT exposed to the main window

- No filesystem access.
- No `ipcRenderer` object itself (only the one named function above) — per
  `electron-desktop.md` §2's mandatory pattern, never expose `ipcRenderer` directly to a renderer
  loading third-party content.
- No read access back into main-process state (e.g. no "get window state" call) — nothing in this
  app's UI needs to read that back into the page.
- **No settings read/write API of any kind** — see "Settings window" below for exactly why this
  surface is deliberately kept separate from the one above, not merged into it.

## Sender validation (main window only)

Because the main window loads exactly one, fixed, never-user-navigable-elsewhere origin
(`chat.google.com`, with `accounts.google.com` allowed only during the sign-in redirect — see
`will-navigate` allowlist in [Overview](overview.md)), `ipcMain.on('notification:clicked', ...)`
additionally checks `event.senderFrame`'s origin against that same allowlist before acting, per
`electron-desktop.md` §2's sender-validation guidance for any handler reachable once the app loads
remote content. This check applies **only** to the main window's channel — see below for why the
Settings window's channels do not carry the same requirement.

## Settings window — `contextBridge.exposeInMainWorld('__gcdSettingsBridge', { ... })`

Exposed at `window.__gcdSettingsBridge` inside the **Settings window's** isolated world only, via a
separate preload script, `src/preload/settingsPreload.js` — never merged into `preload.js` above.
This is a deliberate split, not incidental file organization: the main window's preload is reachable
by `chat.google.com`, a third-party origin this app does not control; putting settings read/write
channels on that same bridge would hand a remote page a way to call them. The Settings window loads
only this app's own bundled, local, static HTML (see
[Tray & Lifecycle](tray-lifecycle.md#settings-window-fr-15)) — no remote content ever runs there —
so it gets its own, larger bridge with no origin-validation requirement on the main-process side
(there is no third-party origin to validate against).

| Exposed function (`window.__gcdSettingsBridge.<name>`) | Wire IPC channel | Direction | Payload | Purpose |
|---|---|---|---|---|
| `getAll()` | `'settings:get'` | renderer → main, `ipcRenderer.invoke` (request/response) | none | Called once on window load. Response: `{ startAtLogin: boolean, soundEnabled: boolean, notificationsMuted: boolean, blinkOnUnread: boolean, version: string }` — the live snapshot the design spec's Loading state (§5) resolves against. `startAtLogin` is read live from the OS (`getLoginItemSettings()`/XDG file check), never from a cached value, per FR-10's existing rule. |
| `set(key, value)` | `'settings:set'` | renderer → main, `ipcRenderer.invoke` (request/response) | request: `{ key: 'startAtLogin' \| 'soundEnabled' \| 'notificationsMuted' \| 'blinkOnUnread', value: boolean }` | Called on every switch toggle. Response: `{ ok: true, value: boolean }` (the confirmed applied value, post OS read-back for `startAtLogin`) or `{ ok: false, message: string }`. The design spec's §4 "optimistic UI + reconciliation" and §5/§6 error states are driven directly off this response — `ok: false` is what triggers the switch revert + inline error text. |
| `onChanged(callback)` | `'settings:changed'` | main → renderer, `webContents.send`, renderer subscribes via `ipcRenderer.on` | `{ key: string, value: boolean }` | Pushed by main whenever a setting changes from a source **other than this window's own last `set()` call** — today, only `notificationsMuted` toggled from the tray menu. This is the tray→Settings direction of FR-15's Mute two-way sync; see [Tray & Lifecycle](tray-lifecycle.md#echo-loop-prevention) for the echo-loop-prevention rule that decides when this fires. |

`getAll`/`set` are `invoke`/`handle` (request/response) rather than `send`/`on` like the main
window's `notificationClicked`, because the Settings window's UI genuinely needs a response value
(the current settings snapshot; the applied-or-rejected result of a toggle) — unlike
`notificationClicked`, which is correctly fire-and-forget. This is the one place in the app where a
request/response IPC round trip is used, and it exists specifically because this window's own
renderer-side state (the switches) needs to reconcile against a main-process-confirmed outcome.

## Call window (FR-16): Meet contents has no bridge; the app view has a narrow one — PROVISIONAL

The call window holds two web contents (see [Meet Call Window](meet-call-window.md) §3a).

**The Meet contents has no preload script and exposes nothing:** no `contextBridge` object, no IPC channel
is reachable from Meet's page (space rule `electron-security-baseline`). Everything the app needs from it is
done from the main process (window events, `render-process-gone`, `did-fail-load`, permission and
display-media handlers).

**The app view** (a child `WebContentsView` that draws the loading, load-error and crashed panels and the
status strip) loads only bundled local HTML, with its own preload exposing `window.__gcdCallUiBridge`. It is
**provisional**: it follows the Meet design, which is under review, and the offline and back-online states
are cut and have no channel. Security constraints (context isolation, sandbox, no Node, no navigation,
non-persistent separate session, local content only) are in
[Meet Call Window](meet-call-window.md) §3a and are not repeated here. Never merged into any other preload.

| Exposed function | Wire channel | Direction | Payload | Purpose |
|---|---|---|---|---|
| `onState(cb)` | `'callui:state'` | main → view, `webContents.send`; view subscribes via `ipcRenderer.on` | `{ state: 'opening' \| 'slow' \| 'load-error' \| 'crashed' \| 'ok', address: string, errorCode?: number, strip?: 'link-blocked' \| null }` | The complete UI state, replaced whole on every change (no partial updates to drift). `address` is a display string main builds (for example `meet.google.com/abc-defg-hij`), never a raw URL with query or fragment. `errorCode` is a number; the wording for each code is local to the view. `strip` is an enum; the view holds the text. **No string taken from the Meet page is ever sent.** |
| `act(action)` | `'callui:action'` | view → main, `ipcRenderer.send` (fire-and-forget) | `{ action: 'retry' \| 'reload' \| 'close' \| 'dismiss-strip' }` | The user pressed a button. Main ignores any value outside the enum **and** any action illegal in the current state: `retry` only in `load-error`; `reload` only in `slow` or `crashed`; **`close` only in `slow`, `load-error` or `crashed`** (the states where the design offers a Close button and no live page can object; it destroys the window directly, with no probe or dialog; there is no in-view close in `opening` or `ok`); `dismiss-strip` only with a strip showing. |

Sender validation: main accepts `'callui:action'` only when `event.sender` is the app view's own web
contents (its stored id) and its frame URL is the bundled local file. Anything else is dropped and logged as
a warning, without content. Nothing is invoked with a response (`send`, not `invoke`) because the view has
no use for a return value; the next `callui:state` is the only feedback. The close and Exit confirms
(design SC-2) are native OS dialogs, not channels (see [Meet Call Window](meet-call-window.md) §3b, pending
owner approval).

## Screen-share picker window — PROVISIONAL

**Provisional: the picker is being wireframed ([design/05](../design/05-meet-source-picker.md)), and these
channels may change with it.** The picker loads only this app's own local HTML with its own preload
(`__gcdPickerBridge`), the same trust model as the Settings window, never a third-party origin. Nothing
below may be exposed on the main window's, the Meet contents' or the app view's bridge.

| Exposed function | Wire channel | Direction | Payload | Purpose |
|---|---|---|---|---|
| `getSources()` | `'picker:get-sources'` | renderer → main, `invoke` | none | Returns the list of screens/windows (id, name, thumbnail) for this request. Thumbnails show live screen content: never logged or persisted. |
| `choose(sourceId)` | `'picker:choose'` | renderer → main, `invoke` | `{ sourceId: string }` | The user's selection; main returns that source to the pending display-media request. Only a value from the list main just sent is accepted. |
| `cancel()` | `'picker:cancel'` | renderer → main, `send` | none | Denies the request. Closing the picker window without choosing is equivalent. |

There is never an automatic choice: with no `choose`, the request is denied. **Where the picker exists:**
on Windows always; on Linux X11 (design position); **not** on Linux Wayland/PipeWire, where the OS
picker replaces it **only if Spike B shows the conditions in [Meet Call Window](meet-call-window.md) §5 hold**
(the user chooses explicitly; a silent or pre-selected source is never allowed on any platform). If Spike B
shows they do not, this window is used there too. The OS-picker path adds no channel.

## Service-worker context — PROVISIONAL, only if mechanism M2 is chosen

If [Notifications](notifications.md) mechanism **M2** is built, a service-worker preload script forwards
Chat's `showNotification` payload to main over the service-worker IPC that Electron's `ServiceWorkerMain`
exposes (`ipc`, `send`; Experimental, [U]). Contract if built: a single fire-and-forget channel from the
service-worker context to main carrying only `{ title, body, tag, icon }` (fields Chat supplied; no cookies,
no page state). Main must validate that the sender's `scope`/`scriptURL` origin is exactly
`https://chat.google.com` before acting, the same rule as the sender validation above. Not built, not
chosen: it exists so the surface is reviewed before code, not after.

## What is deliberately NOT exposed to the Settings window

- No `ipcRenderer` object itself — same `electron-desktop.md` §2 pattern as the main window, even
  though this window loads only trusted local content; there is no need for the renderer to reach
  arbitrary main-process channels beyond the three named above.
- No filesystem access, no direct access to `mainWindow`/main-window state beyond what `getAll()`
  already returns.
</architecture>
