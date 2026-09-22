# IPC Contract

<overview>
The complete, narrow surface `src/preload/preload.js` exposes via `contextBridge`, plus the one
main-world injection used by the notification-click bridge (a different mechanism — see
[Notifications](notifications.md)), plus the separate, smaller surface the Settings window's own
preload exposes (see [Tray & Lifecycle](tray-lifecycle.md)'s "Settings window (FR-15)"). This is the
contract the implementer and the tests both cite; nothing beyond this list is exposed to the
renderer(s).
</overview>

<architecture>
## Main window — `contextBridge.exposeInMainWorld('__gcdBridge', { ... })`

Exposed at `window.__gcdBridge` inside the renderer's **isolated world** (i.e. reachable from the
preload's own code, and from the main-world injection in `notifications.md` via the page's global
`window` object once the preload has run — `contextBridge`-exposed APIs are visible on the page's
`window` object by design, that is the whole point of `exposeInMainWorld`).

| Exposed function (`window.__gcdBridge.<name>`) | Wire IPC channel | Direction | Payload | Purpose |
|---|---|---|---|---|
| `notificationClicked()` | `'notification:clicked'` | renderer → main, `ipcRenderer.send` (fire-and-forget) | none | Sent by the injected `Notification` click wrapper (see notifications.md §2). Main responds by showing/focusing the window. No response value — the renderer does not need one. |

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

## What is deliberately NOT exposed to the Settings window

- No `ipcRenderer` object itself — same `electron-desktop.md` §2 pattern as the main window, even
  though this window loads only trusted local content; there is no need for the renderer to reach
  arbitrary main-process channels beyond the three named above.
- No filesystem access, no direct access to `mainWindow`/main-window state beyond what `getAll()`
  already returns.
</architecture>
