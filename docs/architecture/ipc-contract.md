# IPC Contract

<overview>
The complete, narrow surface `src/preload/preload.js` exposes via `contextBridge`, plus the one
main-world injection used by the notification-click bridge (a different mechanism — see
[Notifications](notifications.md)). This is the contract the implementer and the tests both cite;
nothing beyond this list is exposed to the renderer.
</overview>

<architecture>
## `contextBridge.exposeInMainWorld('__gcdBridge', { ... })`

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

## What is deliberately NOT exposed

- No filesystem access.
- No `ipcRenderer` object itself (only the one named function above) — per
  `electron-desktop.md` §2's mandatory pattern, never expose `ipcRenderer` directly to a renderer
  loading third-party content.
- No read access back into main-process state (e.g. no "get window state" call) — nothing in this
  app's UI needs to read that back into the page.

## Sender validation

Because this app loads exactly one, fixed, never-user-navigable-elsewhere origin
(`chat.google.com`, with `accounts.google.com` allowed only during the sign-in redirect — see
`will-navigate` allowlist in [Overview](overview.md)), `ipcMain.on('notification:clicked', ...)`
additionally checks `event.senderFrame`'s origin against that same allowlist before acting, per
`electron-desktop.md` §2's sender-validation guidance for any handler reachable once the app loads
remote content.
</architecture>
