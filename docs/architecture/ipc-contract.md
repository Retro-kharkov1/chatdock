# IPC Contract

<overview>
The complete, narrow surface `src/preload/preload.js` exposes via `contextBridge` (three fire-and-forget
senders, **on the chat origin only**, see "Origin gating"), the service-worker preload's one bridge and channel (`src/preload/serviceWorkerPreload.js`), plus
the one main-world injection used by the notification bridge (a different mechanism, see
[Notifications](notifications.md)), plus the separate, smaller surface the Settings window's own preload
exposes (see [Tray & Lifecycle](tray-lifecycle.md)'s "Settings window (FR-15)"), plus the screen-share picker's own narrow surface (FR-16; not built yet; the Meet contents has none). This is the contract the implementer and the tests both
cite; nothing beyond this list is exposed to the renderer(s).
</overview>

<architecture>
## Main window — `contextBridge.exposeInMainWorld('__gcdBridge', { ... })`

Exposed at `window.__gcdBridge` **only when the main frame is on the chat origin** (otherwise `window.__gcdBridge` is `undefined`; see "Origin gating" below), inside the renderer's **isolated world** (i.e. reachable from the
preload's own code, and from the main-world injection in `notifications.js` via the page's global
`window` object once the preload has run — `contextBridge`-exposed APIs are visible on the page's
`window` object by design, that is the whole point of `exposeInMainWorld`).

| Exposed function (`window.__gcdBridge.<name>`) | Wire IPC channel | Direction | Payload | Purpose |
|---|---|---|---|---|
| `notificationClicked()` | `'notification:clicked'` | renderer → main, `ipcRenderer.send` (fire-and-forget) | none | Sent by the injected page-`Notification` click wrapper (mechanism M1). Main shows/focuses the window (FR-05c step 1). It carries no conversation id, so it cannot serve step 2. |
| `notificationArrived()` | `'notification:arrived'` | renderer → main, `send` | none | The page created its own native toast (`window.Notification`). An **arrival signal only**: feeds the attention controller and the toast service's arrival matching. |
| `notificationShow(payload)` | `'notification:show'` | renderer → main, `send` | `{ title: string, body: string, silent: boolean, tag: string }` | A page-initiated `ServiceWorkerRegistration.showNotification`, which Electron does not display. Main sanitises it (title 200, body 1000, tag 100, markup stripped) and re-raises a native toast (mechanism M2). The original is not called unless this send throws. |

The two names are deliberately different: `notificationClicked` is the JS function exposed on
`window.__gcdBridge` (camelCase per JS convention); `'notification:clicked'` is the underlying wire
channel (colon-namespaced per the usual Electron naming convention). The preload implements the former
by calling `ipcRenderer.send(<channel>)` internally; the renderer code and tests only see
`window.__gcdBridge.<name>()`. Every other reference to these channels in this doc set uses the wire name,
since those are main-process-side concerns.

That is the **entire** exposed surface: **three fire-and-forget senders** (the one internal smart-copy signal below is not exposed). No `invoke`/`handle` channels exist
because nothing in this wrapper needs a request/response round trip from the renderer.

## Main window — smart-copy signal (FR-18), internal, not exposed

One more channel exists on the main window's preload, and it is **not** a `contextBridge` function: the listener
lives inside `src/preload/preload.js`, so the page can neither call nor observe it (`__gcdBridge` keeps its three
functions). Maintainer decision 2026-10-04; rule of record in [Project Rules](project-rules.md).

| Channel | Direction | Payload | Purpose |
|---|---|---|---|
| `'smartcopy:signal'` | renderer → main, `ipcRenderer.send` (fire-and-forget) | exactly `{ kind: 'selection' }` (no text, coordinates or element data). A `{ kind: 'link', href }` payload is **not authorised** (maintainer decision B, 2026-10-04): it would need maintainer approval and a [Project Rules](project-rules.md) change. | A trusted left `mouseup` ended a drag, double or triple click and the selection is non-empty, changed since `mousedown`, and neither it nor the focus is in `input`/`textarea`/`contenteditable`/`[role=textbox]`. Main then calls `webContents.copy()` and shows the hint. |

The detector is installed only on the chat origin (see "Origin gating"). Validation in main (`src/main/smartCopy.js`), every condition required, otherwise dropped and logged as an outcome
without content: `event.sender` is the main window's `webContents`; `event.senderFrame` is **non-null** (null is rejected) and is its main frame; the frame
URL's origin equals a notification origin (chat only, exact equality, `originCheck.js`; a main window on the sign-in
origin is rejected); the payload is a plain object with exactly the key `kind` and the value `'selection'`; the window
is not destroyed. Copies are rate-limited trailing-edge (100 ms window, the last signal in a window wins; see
[Smart Copy](smart-copy.md) section 2). The preload sends only for `event.isTrusted` events and never calls `preventDefault` or
`stopPropagation`. No reply channel exists.

## What is deliberately NOT exposed to the main window

- No filesystem access.
- No `ipcRenderer` object itself (only the three named functions above) — per the standard Electron contextBridge pattern, which is the
  mandatory pattern, never expose `ipcRenderer` directly to a renderer loading third-party content.
- No read access back into main-process state (no "get window state" call).
- **No settings read/write API of any kind** — see "Settings window" below for why that surface is kept
  separate, not merged into this one.

## Origin gating (main window) — the bridge exists on the chat origin only

The main window is not only ever on Chat: sign-in (`accounts.google.com`) and any redirect target load in it
too. **Nothing of the app's own is offered to those pages**, on either side of the boundary.

Two origin lists exist (`src/main/origins.js`): **navigation origins** (chat, plus the Google sign-in origin
`accounts.google.com`, provisional per [Overview](overview.md)) — used **only** for the `will-navigate`
allow-list — and **notification origins** (**chat only**, plus a dev loopback origin in an unpackaged dev run),
which gate **every** app channel and injection of the main window. Checks are exact, case-sensitive string
equality (`src/main/originCheck.js`), never prefix or substring.

| Layer | Rule | Where |
|---|---|---|
| Preload (renderer side) | `__gcdBridge` is exposed **and** the smart-copy detector installed **only** when `window.location.origin === 'https://chat.google.com'` (a hard-coded constant) in the **main frame** (`window.parent === window`). Anywhere else the preload does nothing: no `contextBridge` object, no listener, no IPC. | `src/preload/preload.js` |
| Dev loopback stand-in | The preload cannot know the dev origin (**no `process.argv`/env/page input may decide it**). On a loopback `http` origin (`localhost`/`127.0.0.1`) only, it asks main synchronously on `'gcd:bridge-probe'` and exposes the bridge only on the literal answer `true`. Main answers from the transport (sender frame) and its own origin list, and a production run has no loopback origin on that list, so it answers `false`. Any other origin never even asks. | `preload.js`, `mainFrameGate.registerBridgeProbe` |
| Bridge injection | `injectNotificationBridge` is a no-op unless the main frame's URL origin is a notification origin. The check is **inside** the function, so every caller (dom-ready, did-finish-load, tray Mute, `settings:set`) is covered. | `notifications.js` `createNotificationBridgeInjector` |
| Unread count | Both paths (`page-title-updated`, the `did-finish-load` seed) ignore a title unless the main frame is on a notification origin; the listener checks on every event and fails closed when given no predicate. | `notifications.js`, `index.js` |
| Main-process handlers | `notification:clicked`, `:arrived`, `:show` and `smartcopy:signal` accept a message only if **all** hold: `event.sender` is the main window's own `webContents`; `event.senderFrame` is non-null and **is its main frame**; the frame origin is a notification origin; **and** the window is currently on such an origin (a frame created on Chat that has since navigated away is refused). Rejections are logged with the channel and origin, never the payload. | `src/main/mainFrameGate.js` (`createMainFrameGuard`; `smartCopy.js` keeps its equivalent check) |
| Service worker | `__gcdSwBridge`, the `showNotification`/`clients` patches and the click subscription exist only in a worker whose own origin is the chat origin (see "Service-worker context"). | `serviceWorkerPreload.js` |

`'gcd:bridge-probe'` is a synchronous request/response (`ipcRenderer.sendSync`, answer on `event.returnValue`), the
one exception to "no request/response from the main window's preload". It carries no payload and discloses one
bit (is this frame the app's own bridge page?) to a frame that is already a loopback page.

Not covered by these checks: the Settings window's channels, which have their own check (below).

## Settings window — `contextBridge.exposeInMainWorld('__gcdSettingsBridge', { ... })`

Exposed at `window.__gcdSettingsBridge` inside the **Settings window's** isolated world only, via a
separate preload script, `src/preload/settingsPreload.js` — never merged into `preload.js` above.
This is a deliberate split, not incidental file organization: the main window's preload is reachable
by `chat.google.com`, a third-party origin this app does not control; putting settings read/write
channels on that same bridge would hand a remote page a way to call them. The Settings window loads
only this app's own bundled, local, static HTML (see
[Tray & Lifecycle](tray-lifecycle.md#settings-window-fr-15)) — no remote content ever runs there —
so it gets its own, larger bridge with no *origin* validation on the main-process side (there is no
third-party origin to validate against). `settings:get` and `settings:set` do, as defence in depth, accept
only the open Settings window's own `webContents` (`event.sender`); from any other sender `settings:get`
rejects and `settings:set` returns `{ ok: false, message }` without touching a setting. No page of the main
window has a bridge to these channels in the first place.

| Exposed function (`window.__gcdSettingsBridge.<name>`) | Wire IPC channel | Direction | Payload | Purpose |
|---|---|---|---|---|
| `getAll()` | `'settings:get'` | renderer → main, `ipcRenderer.invoke` (request/response) | none | Called once on window load. Response: `{ startAtLogin: boolean, soundEnabled: boolean, notificationsMuted: boolean, blinkOnUnread: boolean, version: string }` — the live snapshot the design spec's Loading state (§5) resolves against. `startAtLogin` is read live from the OS (`getLoginItemSettings()`/XDG file check), never from a cached value, per FR-10's existing rule. |
| `set(key, value)` | `'settings:set'` | renderer → main, `ipcRenderer.invoke` (request/response) | request: `{ key: 'startAtLogin' \| 'soundEnabled' \| 'notificationsMuted' \| 'blinkOnUnread', value: boolean }` | Called on every switch toggle. Response: `{ ok: true, value: boolean }` (the confirmed applied value, post OS read-back for `startAtLogin`) or `{ ok: false, message: string }`. The design spec's §4 "optimistic UI + reconciliation" and §5/§6 error states are driven directly off this response — `ok: false` is what triggers the switch revert + inline error text. |
| `onChanged(callback)` | `'settings:changed'` | main → renderer, `webContents.send`, renderer subscribes via `ipcRenderer.on` | `{ key: string, value: boolean }` | Pushed by main whenever a setting changes from a source **other than this window's own last `set()` call** — today, only `notificationsMuted` toggled from the tray menu. This is the tray→Settings direction of FR-15's Mute two-way sync; see [Tray & Lifecycle](tray-lifecycle.md#echo-loop-prevention) for the echo-loop-prevention rule that decides when this fires. |
| `reportContentHeight(height)` | `'settings:content-height'` | renderer → main, `ipcRenderer.send` (fire-and-forget) | a single number: the content root's height in CSS px | BUG-06. Main accepts it only from the Settings window's own `webContents`, only if it is a finite positive number, clamps it to the work area minus the window chrome, and resizes the window to it (top edge kept). No response. |
| `openHelp()` | `'settings:open-help'` | renderer → main, `ipcRenderer.send` (fire-and-forget) | **none** (no arguments cross the bridge; any extra arguments are dropped by the preload and ignored by main) | UI-06. The Settings window's "Help" link. Main accepts it only from the open Settings window's own `webContents` and then opens (or focuses) the in-app Help window, the same action as the tray's Help entry. No response. The Help window itself has **no preload, no bridge and no IPC channel** (see "Help window" below). |

`getAll`/`set` are `invoke`/`handle` (request/response) rather than `send`/`on` like the main
window's `notificationClicked`, because the Settings window's UI genuinely needs a response value
(the current settings snapshot; the applied-or-rejected result of a toggle) — unlike
`notificationClicked`, which is correctly fire-and-forget. This is the one place in the app where a
request/response IPC round trip is used, and it exists specifically because this window's own
renderer-side state (the switches) needs to reconcile against a main-process-confirmed outcome.

## Call window (FR-16): the Meet contents has no bridge

**The Meet contents has no preload script and exposes nothing:** no `contextBridge` object and no IPC channel
is reachable from Meet's page (the *Electron security baseline* project rule). The call window has no other
web contents. Everything the app needs from it is done from the main process (window events,
`render-process-gone`, permission and display-media handlers) and with native dialogs, which are not
channels (see [Meet Call Window](meet-call-window.md) §8 and §9). There are no `callui:*` channels.

## Screen-share picker window (FR-16) — final

The picker is the only app-drawn surface of the call window ([Meet Call Window](meet-call-window.md) §7). It
loads only this app's own local HTML with its own preload (`src/preload/pickerPreload.js`, exposing
`window.__gcdPickerBridge`), the same trust model as the Settings window, never a third-party origin.
Nothing below may be exposed on the main window's bridge or on the Meet contents.

| Exposed function | Wire channel | Direction | Payload | Purpose |
|---|---|---|---|---|
| `getSources()` | `'picker:get-sources'` | renderer → main, `invoke` | none | Called once after the window shows its loading state. Resolves (possibly after several seconds) with `[{ id: string, name: string, kind: 'screen' \| 'window', thumbnail: string }]` (`thumbnail` a data URL). Main remembers the ids it sent. Thumbnails show live screen content: never logged or persisted. |
| `choose(sourceId)` | `'picker:choose'` | renderer → main, `invoke` | `{ sourceId: string }` | The user's selection. Main accepts only an id from the list it sent to this picker and only while the display request is still pending; it then returns that source to the request and closes the picker. Resolves `{ ok: boolean }`. |
| `cancel()` | `'picker:cancel'` | renderer → main, `send` | none | Denies the pending request and closes the picker. Closing the window, Escape and Meet-side teardown are equivalent. |

Sender validation: main accepts all three only from the picker's own `webContents` id with a frame URL equal
to the bundled file; anything else is dropped and logged without content. There is never an automatic
choice: with no `choose`, the request is denied. The picker is used on Windows and on Linux (the Linux OS
picker is out of scope and would add no channel).

## Service-worker context (implemented, mechanism M2)

`src/preload/serviceWorkerPreload.js` is registered with `session.registerPreloadScript({ type:
'service-worker' })`. It runs in the worker's **isolated** world, exposes `__gcdSwBridge.show(payload)`, and
uses `contextBridge.executeInMainWorld` to patch the worker's `showNotification`. Electron's
`ServiceWorkerMain` API is marked Experimental; it works for this on 44.4.3 (the implementer's finding).

**Origin gate (the preload runs in the worker of every origin the session loads).** The preload is session-wide,
so it first reads the worker's own origin and does nothing unless it is exactly `https://chat.google.com`
(hard-coded; no dev loopback allowance: a dev stand-in gets no worker bridge). Verified on 44.4.3 with a probe:
the preload's isolated world has **no** `self`, `location` or `registration` (only `globalThis`, `process` and the
electron modules), so the origin is read in the worker's main world with
`contextBridge.executeInMainWorld({ func: () => self.location.origin })`, which returns the value
([contextBridge](https://www.electronjs.org/docs/latest/api/context-bridge#contextbridgeexecuteinmainworldscript));
`self.registration.scope` gave the same origin. `self.location` is the worker script's URL and the preload runs before
any worker script, so the worker cannot have replaced it; a failed read counts as "not chat". Off the chat origin:
no `__gcdSwBridge`, no patches, no `notification:sw-click` subscription. Main's scope check (below) stays as the
second layer.

| Channel | Direction | Payload | Purpose |
|---|---|---|---|
| `'notification:sw-show'` | service-worker context → main, `ipcRenderer.send`, received on `ServiceWorkerMain.ipc` | `{ title: string, body: string, silent: boolean, tag: string, data?: JSON }` (`data` is Chat's click data, 16 KB cap, BUG-05) | Chat's own worker called `showNotification`; main re-raises a native toast (see [Notifications](notifications.md)). No cookies, no page state. |
| `'notification:sw-open'` | service-worker context → main, `ipcRenderer.send`, on `ServiceWorkerMain.ipc` | `string` (URL) | BUG-05: a replayed click asked for `clients.openWindow`/`navigate`. Honoured only from an allowed worker scope; Chat origin opens in the app window, everything else goes through the link router. The URL is never logged. |
| `'notification:sw-click'` | main → service-worker context, `ServiceWorkerMain.send` | `{ title, body, tag, data }` | BUG-05: replay a `notificationclick` to the listeners Chat registered in that worker. |

Validation: main accepts a message **only** when the worker's **scope origin** (`event.serviceWorker.scope`)
is in the notification origins (chat only); anything else is rejected and logged. Payloads are sanitised
downstream. Hooking is per `ServiceWorkerMain` wrapper object (a `WeakSet`), **not** per version id, because
the running-status events reported `versionId` 0 in the probe; workers already running at startup are
enumerated with `getAllRunning`. The worker's console is web-controlled text: only `[gcd-sw]`-prefixed lines
from a worker whose scope is an allowed origin are surfaced in the app log.

## Help window (UI-06): no bridge

The in-app Help window loads only the generated, static `src/renderer/help/help.html` (built from `docs/user-guide.md` by `scripts/build-help.js`; no script, strict CSP). It is created with `contextIsolation`, `sandbox`, no `nodeIntegration`, no `webviewTag`, **no preload**, and its own non-persistent partition (`gcd-help`) on which every permission is denied. It exposes nothing and has no IPC channel. Navigation inside it is denied except in-page `#anchor`s; `http`, `https` and `mailto` links (and `target=_blank`) go to the system browser through the same scheme allow-list as every other window, anything else is dropped. Closing it never quits the app. It is opened only from main (the tray entry, or `settings:open-help` above).

## What is deliberately NOT exposed to the Settings window

- No `ipcRenderer` object itself — same contextBridge pattern as the main window, even
  though this window loads only trusted local content; there is no need for the renderer to reach
  arbitrary main-process channels beyond the named functions above.
- No filesystem access, no direct access to `mainWindow`/main-window state beyond what `getAll()`
  already returns.
</architecture>
