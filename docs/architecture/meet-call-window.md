# Meet Call Window (FR-16, NFR-07)

<overview>
Design for opening Google Meet links in an app-owned call window with camera, microphone and screen share.
The behaviour is specified by [FR-16 and NFR-07](../business/requirements.md); the evidence is
[ADR-0004](../adr/0004-desktop-shell-technology-and-electron-retention.md) "Spike B result" (Windows) and
"Spike B, Linux half" (WSLg), cited below as **Spike B**. The standing rules (security baseline, quit only
from the tray, wrapper not a rewrite) are in [Project Rules](project-rules.md) and are not restated here.

**Scope is deliberately minimal (owner decision 2026-10-02).** The call window shows **only the Meet page**.
The app draws exactly **one** surface: the screen-share source picker. There is no app-owned view inside
the call window, no status strip, no loading/error/crash panel, no preload on the Meet page and no
window-state persistence. Everything the user must be told (live-call close, Exit, a crash) is a **native
OS dialog**. Nothing in this design injects script into Meet (*Wrapper, not a rewrite*).

Status tags: **[Spike B]** observed facts; **[U]** unverified, the implementer proves it on Electron 44.4.3
with a real build and records the outcome here. Code is cited by file or symbol, not line.

**Known limitations accepted by this scope** (not defects to fix in this change):
- *End-of-call page.* "Meeting page" is decided from the address only (section 5). After a call ends Meet
  keeps a meeting-code address, so a second link then gets "focus and notify" instead of loading into the
  window. The user closes the window and clicks the link again.
- *No in-window load-error or "opening" UI.* A failed load shows Chromium's own error page; a slow load
  shows an empty window until Meet paints. The window is always closable.
- *Page-initiated unload objection is not overridden* (section 8): a Meet-started reload during a call
  with `beforeunload` registered does nothing, silently. Spike B showed this is the Electron default.
- *Popups that need the session* (for example a sign-in popup that Meet opens) go to the system browser
  and do not share the app's session; watch for it in the manual run (section 12).
</overview>

<architecture>
## 1. Units

| Unit | File (suggested) | Kind | Purpose |
|---|---|---|---|
| URL classifier + scheme allow-list | `src/main/meetLink.js` | pure, no Electron import | The only place that decides call window versus system browser, and which schemes may reach the OS. |
| Link router factory | `src/main/linkRouter.js` | pure factory, deps injected | Main-window `setWindowOpenHandler` / `will-navigate` routing. Also used by the call window's popup and navigation handlers. |
| Permission policy | `src/main/meetPermissions.js` | pure decision functions + installer | Origin gate and the request / check / display-media decisions. Installed from `configurePersistentSession` in `src/main/session.js`. |
| Meeting-page predicate | `src/main/meetingPage.js` (or inside the call window module) | pure | Address-only "is this a meeting page". |
| Call window | `src/main/callWindow.js` | main-process factory, deps injected | Singleton window, navigation limits, popups, close/quit handling, second-link rule, crash dialog. |
| Dialog slot | inside the call window module | small state machine | At most one native dialog (P1, P2 or crash) at a time; owns its `AbortController`. |
| Source picker | `src/main/pickerWindow.js` + `src/renderer/picker/` + `src/preload/pickerPreload.js` | main + local renderer | The only app-drawn surface. Section 7. |

Wiring: `src/main/index.js` constructs the router with the real `openCallWindow` and `shell.openExternal`,
passes the call window module `isQuitting` getter and the tray refresh hook, and keeps `before-quit` as
today.

## 2. URL classification (unit 1)

```
classifyLink(input: unknown) -> { outcome: 'call-window' | 'system-browser', url: string }
isOpenableExternalScheme(url: string) -> boolean        // http:, https:, mailto: only
```

`classifyLink` is the contract the existing `test/meetLink.test.js` fixes; it never throws for any input
type. Rules (the full table of cases is NFR-07's and the test file's; not repeated):

1. Parse with WHATWG `URL`. `call-window` only when `origin === 'https://meet.google.com'` and
   `username === ''` and `password === ''`. The origin test refuses an explicit non-default port, a trailing
   dot, a lookalike or deeper host and any non-https scheme; default `:443` normalises away. No suffix,
   substring or wildcard matching.
2. **Unwrap once.** Only `https://www.google.com/url` (no port, no userinfo, path exactly `/url`) is
   unwrapped. Require exactly one `q` parameter (a duplicated `q` is refused, as the test table expects).
   The decoded target must pass rule 1 **on its own**; a wrapper target that is itself a wrapper fails
   because its host is not `meet.google.com`.
3. `url` is the **normalised href of the target**, never the raw input or the wrapper (parser-differential
   removal; the tests assert it).
4. Everything else, including every parse failure and non-string, is `{ outcome: 'system-browser' }`.
5. **Scheme allow-list.** Whatever is handed to the OS (`shell.openExternal`) first passes
   `isOpenableExternalScheme`: parsed protocol `http:`, `https:` or `mailto:`. `file:`, `ms-settings:`,
   `javascript:`, custom schemes and unparseable values are **not opened** and not routed anywhere. The
   Meet test runs first; the allow-list gates only the `system-browser` branch.

## 3. Link router factory (unit 2)

```
createLinkRouter({ classifyLink, isOpenableExternalScheme, openCallWindow, openExternal, log })
  -> {
       route(url) -> 'call-window' | 'external' | 'dropped'      // the shared decision + side effect
       onWindowOpen({ url }) -> { action: 'deny' }               // always deny; route(url) as a side effect
       onWillNavigate(event, url, { allowedOrigins }) -> void    // in-app origins pass; else preventDefault + route(url)
     }
```

- `route(url)`: `classifyLink(url)`; `call-window` → `openCallWindow(result.url)`; otherwise, if
  `isOpenableExternalScheme(url)` → `openExternal(url)`; else log (scheme only, never the URL) and drop.
- Main window: `setWindowOpenHandler` = `onWindowOpen`; `will-navigate` keeps the existing in-app origin
  allow-list (chat, sign-in origin; see [Overview](overview.md)), and anything outside it is
  `preventDefault()`ed and routed. This replaces today's "every other URL goes to `shell.openExternal`"
  in `createWindow` in `src/main/index.js`. The allow-list part is a security fix that stands on its own
  and ships first (section 11).
- Call window: popups use `onWindowOpen`; navigations use the call window's own origin list (section 4).
  `openCallWindow` is the call window module's second-link entry (section 5).
- All collaborators are injected, so the factory is unit-tested with fakes and no Electron.
- `will-redirect` into Meet on the main window is not intercepted (NFR-07 scopes `will-navigate`); revisit
  only if Chat is observed to redirect to Meet.

## 4. Call window

`new BrowserWindow` with `webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
partition: PARTITION }`; `PARTITION` comes from `src/main/session.js` (the shared session, so the Google
login carries over). **No `preload` key at all.** Meet's contents has no bridge and no IPC channel. Tests
assert the options the window is **created with**, not only the live contents (NFR-07).

- **Content:** only `https://meet.google.com/...` (and `accounts.google.com` for re-authentication). Nothing
  local is ever loaded into it.
- **Navigation:** `will-navigate` and `will-redirect` on the main frame allow only origins
  `https://meet.google.com` and `https://accounts.google.com` (compared via `new URL(x).origin`); anything
  else is `preventDefault()`ed and routed by the link router (`route(url)`: allow-listed schemes go to the
  system browser). Sub-frame navigation is not restricted (Meet embeds frames). Do not widen the list
  without evidence and an owner decision. Whether Meet legitimately needs another Google host during a call
  is [U]; it shows up as a blocked navigation in the manual run.
- **Popups:** `setWindowOpenHandler` always returns `{ action: 'deny' }` (no popup window is ever created).
  The target is routed: non-Meet → system browser through the scheme allow-list; Meet → the second-link
  rule of section 5 (a Meet link inside a Meet page, for example in-call chat).
- **Singleton.** At most one call window. The module reference is set synchronously at creation, before the
  load, so two quick links cannot create two windows.
- **Close destroys, never quits, never hides.** A hidden call would keep the camera and microphone live.
  `window-all-closed` is a no-op (the main window lives in the tray). The `close` handler is section 8.
- **Release of devices** on destroy is observed at OS level on both platforms for audio and, on Windows, for
  camera [Spike B]; the X-button / LED path and Linux camera are manual checks (section 12).
- **No window-state persistence, no app menu** (the application menu is `null`, see
  [Tray & Lifecycle](tray-lifecycle.md)); edit shortcuts are Meet's own page behaviour.
- **Renderer crash:** section 9.
- **Teardown hook:** every teardown of the Meet page (window `closed`, `render-process-gone`) calls the
  picker's `abortPending()` (section 7), so a source is never handed to a gone page.

## 5. Second link and "meeting page" (address-only)

`openCallWindow(url)` is the single entry for a Meet link from anywhere (main window, popup from the call
window, tray is not an entry):

| State | Action |
|---|---|
| No call window | Create it (section 4) and `loadURL(url)`; focus. |
| Call window exists, **not** a meeting page | `loadURL(url)` into the existing window; restore if minimized, raise, focus. No notification. |
| Call window exists, **meeting page** | Restore if minimized, raise, focus (the picker if one is open); show a native `Notification` "A call is already open. The new link was not opened."; do **not** navigate. |

- **Meeting page is decided by exclusion, from the address only** (`webContents.getURL()` parsed with
  `URL`): it is **not** a meeting page when the origin is not `https://meet.google.com` (this covers
  `accounts.google.com`, `about:blank` and Chromium error pages), or when the path is `/` or `/landing`.
  Anything else, **including any address form not recognised, is a meeting page.** The failure direction is
  safe: unknown means "focus and notify", never "navigate away from a call". No live-call probe is involved
  (that is section 8, a different question).
- The notification is shown **regardless of mute** (app status, not a chat message); it does not pass the
  FR-05 mute check. Clicking it focuses the call window, but only if `!win.isDestroyed()`; on a destroyed
  window the click is a no-op (no new window, no main-window focus).
- A call window showing the crash dialog counts as a meeting page by address: the second link focuses and
  notifies; the dialog stays.
- Delivery depends on OS toast delivery ([Notifications](notifications.md)); if toasts are suppressed the
  user still sees the window come to the front.
- **Known limitation:** the end-of-call page is a meeting page by address (see overview).

## 6. Permissions (NFR-07), with Spike B facts

The session is shared, so the handlers see requests from the main window and the call window alike and
decide by **origin**, never by window. `configurePersistentSession` already installs a request and a check
handler (notifications and `clipboard-sanitized-write`, chat origin only, everything else denied). The Meet
gate **extends** them and must leave those two grants exactly as they are (tests: notifications and clipboard
still work in the main window).

**Origin gate** (one pure function, `meetOriginGate`): grant only when **both** the requesting origin and the
top-level origin equal `https://meet.google.com`. Every origin is normalised with `new URL(x).origin`:
Spike B showed origins arrive **with a trailing slash** (`https://meet.google.com/`), so a literal string
compare fails. Fail closed: a null `webContents` (the check handler may pass null), a missing or
unparseable origin, an `embeddingOrigin` that is present and not Meet, a Meet frame inside a non-Meet page,
or a non-Meet frame inside a Meet page is a denial. Deriving the top-level origin (`webContents.getURL()`
versus `details.embeddingOrigin`) is the implementer's call, pinned by the NFR-07 matrix in tests.

**What Electron delivers [Spike B, Windows and WSLg alike]:**

| Call | Request handler | Check handler |
|---|---|---|
| `getUserMedia` | `media`, `details.mediaTypes` = `["audio"]` / `["video"]` / `["audio","video"]` | `media`, `details.mediaType` = `video` / `audio` (singular, or absent); and `speaker-selection` (no mediaType) |
| `getDisplayMedia` (screen share) | `media` with **empty** `mediaTypes`, then `setDisplayMediaRequestHandler` | n/a |
| `display-capture` | **never delivered** | never delivered |

Decisions:
1. `media` (request): grant iff the origin gate passes. `mediaTypes` may be `audio`, `video`, both, or
   **empty** (the screen-share precursor: it must be granted for Meet or the display-media handler is never
   reached). The request and check handlers use different detail shapes (`mediaTypes` plural versus
   `mediaType` singular): two parsers, never one shared.
2. `media` (check): grant iff the origin gate passes and `mediaType` is not `unknown`.
3. `speaker-selection` (check): grant iff the origin gate passes. (Meet checks it for output-device choice;
   the Spike B config denied it and what Meet does without it is unknown. Granting it to the Meet origin
   only is the working default.)
4. `display-capture` is **not** relied on; allow-list it under the same origin gate as defence in depth only.
5. Every other permission keeps today's behaviour. `notifications` and `clipboard-sanitized-write` are
   unchanged.

**Display-media handler** (`session.setDisplayMediaRequestHandler`, session-wide) is the effective screen
share gate. In order, any failure denies **without showing a picker**:
1. `request.userGesture === true` (Spike B saw `false` fire; deny it).
2. Origin gate on `request.securityOrigin` and the requesting frame's top-level page.
3. A call window exists and is not destroyed (the picker needs its parent).
4. No other display request is already pending (a second one is denied).
5. Show the picker (section 7), wait for the user's choice; cancel, close, teardown or timeout-free
   dismissal → deny.
6. On a choice, **validate `sourceId` against the list main sent to that picker**; return exactly that
   source, video only (no system-audio loopback in this scope; preference, open to argument).
The callback is invoked **exactly once** per request; a late answer after teardown is dropped. Deny means the
callback is invoked with no streams (the exact form is the implementer's; Spike B saw the page receive
`AbortError` on cancel, identical on Windows and Linux).

Elevated process: Spike B saw screen capture fail with `NotReadableError` when the app runs as
Administrator; release notes say not to run the app elevated if screen share matters.

## 7. Screen-share picker (the only app-drawn surface)

- **Window:** a modal child of the call window (`parent` + `modal: true`), small, loading local HTML via
  `loadFile`. Own preload `src/preload/pickerPreload.js`, never shared with another window's preload.
  `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, its own **non-persistent** partition
  (not the main session, so Meet's permission handlers do not apply to it; every permission request on that
  partition is denied), `will-navigate` always prevented, `setWindowOpenHandler` denies, strict CSP, text
  rendered with `textContent`, no `openExternal`.
- **Channels** (final; contract in [IPC Contract](ipc-contract.md)): `picker:get-sources` (invoke),
  `picker:choose` (invoke), `picker:cancel` (send). Sender validation: main accepts a message only from
  the picker's own `webContents` id and a frame URL equal to the bundled file; anything else is dropped and
  logged without content.
- **Loading state.** `desktopCapturer.getSources` took 3.3 to 8.2 s on Windows and about 3 s on WSLg Wayland
  [Spike B]. The picker window opens at once with a loading state; the renderer then calls
  `picker:get-sources`; main runs `getSources` (screens and windows, thumbnails) **asynchronously** so the
  event loop and the close path are never blocked. Main records the list of ids it sent.
- **Cancel = deny.** `picker:cancel`, closing the picker window, Escape, or an empty selection all deny the
  pending request. Nothing is ever chosen automatically; there is no default selection.
- **Teardown.** On the Meet contents' `render-process-gone`, on window `closed`, or on a navigation that
  replaces the requesting frame, main `abortPending()`: closes the picker, **denies** the pending request
  (callback once), drops references. A selection arriving later is dropped (the answer handler checks that
  the request is still pending and the call window is not destroyed).
- **Thumbnails** show live screen content: sent only to the picker's renderer, never logged, persisted or
  forwarded.
- **Platforms.** App picker on Windows and on Linux (X11: screens and windows; Wayland in WSLg: screens only,
  about 3 s latency [Spike B]). The Linux OS picker (xdg-desktop-portal) is **not** part of this scope: it
  could not be tested in WSLg and stays off until proven on a native GNOME/KDE desktop with PipeWire
  (conditions: shown on every share start, cancel denies, nothing pre-selected, the source Meet receives is
  the user's choice). `useSystemPicker` is macOS-only and is not used.
- **Picker open blocks the call window.** A close attempt, tray "Show call window" and a second Meet link
  (meeting-page case) all raise and focus the **picker**; the close attempt additionally calls `flashFrame`
  on the **picker window** (never the main window). `attention.stop()` targets the main window only and
  must not touch it.

## 8. Close, quit and `will-prevent-unload`

### Spike B facts that drive this section
Without a `will-prevent-unload` listener (or with one that does not call `preventDefault()`), a page's
`beforeunload` objection silently blocks `win.close()`, `contents.close({waitForBeforeUnload:true})`, a page
reload and **`app.quit()`** (for quit: `before-quit` fires, `will-quit` never does, window and process stay),
on Windows and Linux alike, even with no user activation. A listener that calls `event.preventDefault()`
synchronously lets close, reload and quit proceed. Whether real Meet registers `beforeunload` during a call is
not observed (owner run).

### Rules
1. **`will-prevent-unload` is registered at window creation, always, on the call window's Meet contents and on
   the main window's contents.** An objection is never left without a listener.
2. **While `isQuitting` is true the listener calls `event.preventDefault()` synchronously** (no dialog, no
   async step). A quit therefore always completes, and `before-quit` itself never calls `preventDefault()`
   and never shows a dialog.
3. **`isQuitting` reset.** If a quit is nevertheless cancelled, `isQuitting` must not stay true (the main
   window's X would then destroy instead of hide, breaking quit-only-from-tray). `before-quit` starts a
   one-shot timer (proposed 5 s); `will-quit` clears it. If the timer ever fires, the quit did not happen:
   reset `isQuitting = false`. A test quits with an objecting stub page and proves both the override and the
   reset.
4. **App-initiated close of the call window** (title-bar X, Alt+F4, taskbar close), in order:
   1. `isQuitting` is true, or this is the deliberate destroy after an answer → the handler yields.
   2. Picker open → the close is blocked; the picker is raised, focused and flashed (never silent).
   3. A dialog (P1, P2, crash) is already open → ignored (the dialog already represents it).
   4. Otherwise start a one-shot **close probe** (proposed 3 s) and let the close proceed so Chromium runs
      Meet's `beforeunload`; set `appClose = true`.
5. **Probe outcomes.** Page does not object → the window is destroyed, timer cleared, no dialog. Page
   objects → `will-prevent-unload` fires: if `appClose` is set, consume it (the **first** objection only),
   clear the timer and show **P1** (below); the handler does not call `preventDefault()` itself because the
   dialog is asynchronous, the override is `destroy()`. Page hung (timeout) → treated as not live, destroyed.
   No user activation on the page → no objection is the expected result, so the window closes without a
   dialog. **A missing or unobservable signal always means no dialog**; the cost is one unguarded close, the
   opposite error would prompt at the end of every call.
6. A page-initiated objection (`appClose` not set, not quitting) is **not** overridden: Meet's own leave
   protection stands (silent, per Spike B; a documented limitation). The timer is cleared on every outcome,
   including window `closed`.

### P1, P2 and the crash dialog (native, `dialog.showMessageBox`)
Always asynchronous (`showMessageBox` with the call window as parent), never a synchronous or
event-loop-blocking dialog. One **dialog slot** holds at most one open dialog `{ kind, controller }` where
`controller` is an `AbortController` whose `signal` is passed to `showMessageBox`.

| Dialog | When | Buttons (default, Esc) | Result |
|---|---|---|---|
| **P1** "Close the call window?" | close probe saw an objection (live call) | "Close window", "Keep window open" (default and Esc: keep) | Close → `destroy()`; keep → nothing |
| **P2** "Exit Google Chat Desktop?" | tray Exit with a live call | "Exit", "Cancel" (default and Esc: cancel) | Exit → `app.quit()`; cancel → nothing |
| **Crash** | Meet `render-process-gone` (section 9) | "Reload", "Close" (Esc: close) | Reload → reload; close → `destroy()` |

Every answer handler first checks `!win.isDestroyed()` and that its dialog is still the one in the slot; an
aborted dialog's answer is discarded.

### Exit is never swallowed
Tray Exit (the only quit path, plus OS shutdown) with a call window present and `isQuitting` not yet set:

| Situation when Exit is clicked | Behaviour |
|---|---|
| No call window | `app.quit()` as today. |
| Call window, no dialog | Picker open: close it and deny its request first. Then run the close probe with `exitProbe`. Not live → destroy the window, then `app.quit()`, no dialog. Live → **P2**. |
| **P1 open** | Dismiss P1 (treated as "keep"), show **P2** (a live call is already known, no second probe). |
| **P2 open** | Raise and focus the call window (P2 is its modal child). |
| **Crash dialog open** | Dismiss it and `app.quit()` (a crashed page has no live call to protect). |

**Feasibility of dismissing an open native message box, Electron 44 (verified in the documentation, not yet
on a build):** `dialog.showMessageBox` has no `close()` handle, but its options accept `signal` (an
`AbortSignal`): "the message box will behave as if it was cancelled by the user"; the documented caveat is
macOS only, for boxes without a parent window (out of scope, and ours have a parent). So P1 (and the crash
dialog) can be dismissed programmatically on Windows and Linux. **Verified on Windows 11, Electron 44.4.3 (2026-10-02):** a parented `showMessageBox` with `signal` was
enumerated as a visible `#32770` window; after `abort()` the promise resolved with `cancelId` within about
60 ms and the window was gone (win32 `EnumWindows` before and after). The cancel path resolves to the
"keep" outcome, as the call window module assumes. **[U]** Linux not yet confirmed (no native desktop here).
**Fallback if `signal` does not dismiss the box** on either platform: Exit while P1 is open **focuses P1** and
records `exitPending`; after P1 is answered, "Close window" → the window is gone, so `app.quit()` runs with
no P2; "Keep window open" → show **P2**. Exit while the crash dialog is open: `app.quit()` directly without
dismissing it (quitting destroys the window; the box goes with its parent [U]). Either way Exit is never
silently dropped.

**Quitting is unconditional once chosen:** `before-quit` sets `isQuitting`; the close handler yields and
`will-prevent-unload` overrides (rule 2), so P2's "Exit" and an OS shutdown never get stuck on Meet's
objection.

**Risk to watch (unexplained; now reproduced without screen share, see below):** on Windows, once, after a completed `app.quit()` in a process that had used
screen share, the main process stayed alive and even `process.exit(0)` from `will-quit` did not end it; it did
not reproduce on Linux [Spike B]. Cause unknown. The quit-with-call integration test (section 10) must
exercise screen share then quit and assert the process exits; if it recurs the release gate is open.

**Reproduced 2026-10-02 (Windows 11, Electron 44.4.3), independent of this feature's code:** a bare Electron
script that calls `ses.setUserAgent(<desktop Chrome UA>)` (or `app.userAgentFallback`, or
`webContents.setUserAgent`) on a session, loads `https://meet.google.com/landing` or
`https://accounts.google.com/`, then `app.quit()` leaves the main process alive after the JS `exit` event
(all child processes gone; `app.exit(0)` and `destroy()`-then-quit behave the same). The same script with the
default UA, or with `example.org` / `www.google.com` under the custom UA, exits in about 1 s. `process.kill(
process.pid)` from the `quit` event ends it. The app has always set that UA (`session.js`).

**Fixed 2026-10-02 (owner decision: flush, then force-terminate)** in `src/main/quitTerminator.js`, wired in
`index.js`: `will-quit` #1 is prevented and the persistent partition (`PARTITION`) is flushed -
`cookies.flushStore()` and `flushStorageData()`, concurrently, bounded by 3 s overall (a stuck flush logs
"timed out" and the quit proceeds); then `app.quit()` is re-issued, `will-quit` #2 passes, and on `quit` the
process ends with `process.kill(process.pid)` (exit code is non-zero on Windows - TerminateProcess). Settings
and window state are written with `writeFileSync`, so they are already on disk; no async flush is needed for
them. Nothing is terminated unless the flush phase completed, never on window close, and never on the OS
shutdown/logoff path: Electron does not emit `before-quit`/`will-quit`/`quit` on Windows then
(<https://www.electronjs.org/docs/latest/api/app>), and the main window's `session-end` additionally disables
the terminate. Only flusher names and error messages are logged, never cookie data. Tests:
`test/quitTerminator.test.js`. Verified on Windows 11 with the real app (a scratch profile, driven via
`app.quit()`, the same call the tray Exit makes): with `accounts.google.com` loaded the unfixed quit stayed alive
(30 s), the fixed one exited in about 1 s after `quit`; a loopback-origin test cookie set in the partition was
present after quit+relaunch.

## 9. Renderer crash

On `render-process-gone` of the Meet contents (any `reason` except `clean-exit`): (1) `abortPending()` the
picker; (2) show the native **crash** dialog "The call window stopped working": **Reload** →
`webContents.reload()` (it returns to a normal Meet load; the user rejoins), **Close** (Esc) → `destroy()`.
If a dialog is already in the slot, it is dismissed first. The OS releases devices when the renderer dies;
verify on a real run (section 12). A repeat crash after Reload shows the dialog again.

## 10. Test-coverage map (Coverage-First: the net is written and green before the code it covers)

U = unit (plain `node:test`, no Electron). I = integration (real Electron, stand-in page served under the
Meet origin as in `spike/meet/`; assertions on the options windows are **created with**). M = manual on a
real desktop, per release.

| Surface | Level | What is asserted |
|---|---|---|
| `classifyLink` | U | `test/meetLink.test.js` as written (positive, adversarial host/scheme/port/userinfo, wrapper cases, never throws). |
| `isOpenableExternalScheme` | U | http, https, mailto true; file, ms-settings, javascript, data, ftp, custom, empty, garbage false. |
| Link router factory | U | Meet → `openCallWindow` once with the normalised url, `openExternal` never; https/mailto → `openExternal`; disallowed scheme → neither (logged without the URL); `onWindowOpen` always returns deny; `onWillNavigate` lets in-app origins through untouched and prevents the rest. |
| Meeting-page predicate | U | `/`, `/landing`, accounts, `about:blank`, error page → not meeting; `/abc-defg-hij`, query/fragment forms, unknown address forms → meeting. |
| Second-link decision | U | no window → create; non-meeting → load into existing, no notification; meeting → focus + notify, no navigation; picker open → focus picker; destroyed window → no-op on notification click. |
| Origin gate | U | trailing-slash origins normalise; NFR-07's requesting/top matrix (seven rows) incl. null webContents, embedding origin, http, chat origin, lookalike. |
| Media request decision | U | `["audio"]`, `["video"]`, both, **empty** grant for Meet only; denied for chat/accounts/other. |
| Media check decision | U | `video`/`audio` grant for Meet only; `unknown` denied; `speaker-selection` Meet only; `display-capture` gated; notifications and clipboard unchanged. |
| Display-media decision | U | `userGesture:false` denied; non-Meet origin denied; no call window denied; second pending denied; chosen id not in the sent list denied; cancel denies; callback exactly once; late answer after teardown dropped. |
| Dialog slot | U | one at a time; P1 + Exit → P1 aborted, P2 shown; P2 + Exit → focus; crash + Exit → quit; fallback path (`exitPending`) with a fake that ignores `signal`; stale answers discarded. |
| Close probe | U | fake timers and fake contents: no objection → destroy; objection → P1; hung → destroy; first-objection-only consumption; picker open → blocked and flashed; isQuitting yields. |
| Call window options | I | created with `contextIsolation`, no `nodeIntegration`, `sandbox`, shared partition, **no preload**; picker created with own preload, non-persistent partition, modal, parent. |
| Navigation and popups | I | will-navigate to chat or evil host blocked and routed; accounts allowed; popup denied (no window created) and routed. |
| `will-prevent-unload` | I | objecting stub: app close → P1 path (dialog stubbed); quit → completes and `will-quit` reached; main-window contents too; `isQuitting` reset after a forced cancelled quit; page reload during a live call is not overridden. |
| Permission handlers live | I | `getUserMedia` and `getDisplayMedia` from the Meet-origin stand-in succeed (picker stubbed); same from accounts denied; main window `Notification` still works. |
| Crash | I | kill the Meet renderer: picker closed and request denied, crash dialog shown (stubbed), Reload/Close behave. |
| Quit after share | I | share, then quit: process exits (watch for the Windows hang). |
| Real Meet call, camera/mic, release (LED / OS indicator), X-button close with live call, Exit with live call | M | Per FR-16 `[manual-only]` scenarios, Windows and Linux separately. |
| Real sign-in in the call window, sign-in popup behaviour, `speaker-selection` need, whether Meet registers `beforeunload`, `signal` dismissal of P1 | M | Results recorded back into this document. |
| Linux native desktop: camera, tray entry P3, picker modal behaviour | M | Native GNOME/KDE only; WSLg proves none of it. |

## 11. Implementation order

Each step starts with its tests from section 10 (red), then code, then green. Steps 1 and 2 are independent of
Meet working at all and fix the existing "every URL goes to `shell.openExternal`" gap, so they ship first.

1. `src/main/meetLink.js` (`classifyLink`, `isOpenableExternalScheme`) against `test/meetLink.test.js`.
2. Link router factory; rewire the main window's `setWindowOpenHandler` and `will-navigate` through it with
   a placeholder `openCallWindow`.
3. `meetPermissions.js` pure gates and decisions, then installed in `configurePersistentSession`; existing
   notification and clipboard tests stay green.
4. Call window: creation, options, navigation limits, popups, singleton, second-link rule and meeting-page
   predicate; connect `openCallWindow` in `index.js`.
5. Quit path: always-registered `will-prevent-unload` (call window and main window), `isQuitting` reset
   timer, close probe, `appClose` flag. Integration test with the objecting stub, quit-after-share test.
6. Picker: window, preload, three channels, loading state, display-media handler, teardown.
7. Native dialogs and slot: P1, P2, crash, `signal` dismissal and its fallback; tray P3 and Exit change
   ([Tray & Lifecycle](tray-lifecycle.md)).
8. Manual verification run (section 12); record outcomes in this document and ADR-0004's living section.

Reviewers: `security-engineer` on steps 1 to 3 and 6; the implementer states the `signal` outcome from step 7.

## 12. Verification and release

The manual scenarios in FR-16 need a real Meet call with real devices and are re-run on every release on
the platform being claimed, as sign-in is under ADR-0001; a release that has not re-verified Meet says so in
its release notes ([Packaging & Release](packaging-release.md)). Windows verification does not establish
Linux. Open points to check on that run: real sign-in and an existing session accepted; sign-in or other
popups from Meet; whether Meet registers `beforeunload` in a call; `speaker-selection`; device release on X
close; behaviour of the crash dialog; the post-quit hang.

## Open questions

1. **Close-probe timeout** (proposed 3 s) and **`isQuitting` reset timer** (proposed 5 s): fix after the
   implementer measures them.
2. **`signal` dismissal** of an open message box: documented, unverified on 44.4.3 (section 8); fallback
   specified.
3. **System-audio capture** in screen share is not offered (video only); revisit if the owner wants it.
4. **Blocked navigation observed in a real call** to a Google host other than the two allowed: extend the
   list only with evidence and an owner decision.
</architecture>

<topics>
- [Requirements FR-16 and NFR-07](../business/requirements.md) — behaviour and the security matrix.
- [ADR-0004](../adr/0004-desktop-shell-technology-and-electron-retention.md) — Spike B evidence (Windows and WSLg).
- [Project Rules](project-rules.md) — security baseline, quit only from the tray, wrapper not a rewrite.
- [IPC Contract](ipc-contract.md) — Meet contents has no bridge; the three picker channels.
- [Tray & Lifecycle](tray-lifecycle.md) — close-to-tray, tray entry P3, Exit (P2), `isQuitting`.
- [Overview](overview.md) — the window model this adds to.
</topics>
