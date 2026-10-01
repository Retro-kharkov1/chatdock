# Meet Call Window (FR-16, NFR-07)

<overview>
Design for opening Google Meet links in an app-owned call window with camera, microphone and screen share.
The requirements are [FR-16 and NFR-07](../business/requirements.md); the decision context is
[ADR-0004](../adr/0004-desktop-shell-technology-and-electron-retention.md) Spike B. **Delivery is
conditional on Spike B**: real Meet inside Electron is not a documented, supported configuration and is
unverified. Statements tagged **[U]** are unverified; nothing here has been run. `file:line` citations of
current code name a file or symbol rather than a line, because the code moves. Nothing in this document is
implemented yet; the BUG-01 change touched the notification, session-permission and attention code, not the
Meet path.

This is the **single exception** to "external links open in the system browser". Its authority is the
the *Electron security baseline* project rule; if this document and that rule ever differ, the rule wins.
Mirrored here without change (owner decision 2026-09-30, UI-01):

> **Single exception:** Google Meet call links open in an app-owned call window. The match is exact:
> scheme `https` and hostname exactly `meet.google.com` (a `www.google.com/url?q=` wrapper is unwrapped
> first and its target must pass the same test). No suffix, substring or wildcard matching. The URL's
> origin must equal `https://meet.google.com` exactly: an explicit non-default port or any userinfo
> (`user@`) is refused and goes to the system browser. The call window keeps `contextIsolation`, has
> `nodeIntegration:false`, `sandbox:true`, shares the main session, denies its own popups, and its
> navigation is limited to `meet.google.com` + `accounts.google.com`. Media and display-capture
> permissions are granted only to the `https://meet.google.com` origin (request AND check handler);
> screen share always goes through the app's own source picker, never an automatic choice. On Linux
> only, the OS's own picker (e.g. the xdg-desktop-portal dialog) may replace the app's picker if Spike B
> shows it works there (owner default, 2026-09-30) — the user still chooses explicitly; a silent or
> pre-selected source is never allowed on any platform. Closing the call window never quits the app.
> Every other URL still goes to the system browser.
>
> **Scheme allow-list (owner decision 2026-10-01, UI-01):** the main window and the call window hand
> a URL to the OS only when its scheme is `http`, `https` or `mailto`. Any other scheme (`file:`,
> `ms-settings:`, custom protocol handlers, …) is not opened. Non-Meet links clicked inside the call
> window go to the system browser, same as in the main window.

The rule says nothing about a second, app-owned view inside the call window (section 3a). Section 3a keeps
that view inside the rule's spirit (local content only, narrow explicit IPC surface, no third-party
origin), but the rule's sentence about the call window's web contents was written for the Meet page. See
open question 7: the owner should confirm, ideally by a one-line addition to the rule.

Nothing in this design injects script into Meet or the call window (the *Wrapper, not a rewrite* project rule).

**Owner decisions of 2026-10-01, folded in below** (recorded in the requirements): second link loads into
the existing window when no meeting page is on screen (section 3); close confirmation (P1), Exit
confirmation (P2) and the tray entry "Show call window" (P3) approved (section 3b); only `http`, `https`
and `mailto` are opened in the OS, by the main window's handler and the call window's alike (sections 2
and 3c); non-Meet links clicked in the call window open in the system browser, so there is **no status
strip** (section 3a, 3c). The *Electron security baseline* project rule quoted above already carries the scheme allow-list; it is still
silent on the app-owned view; see open question 7.
</overview>

<architecture>
## 1. Components

```
 main window ──link click / will-navigate──▶ classifyExternalUrl(url)
   (chat.google.com)                             │
                                     kind:'meet' │ kind:'external'
                                                 ▼                 ▼
                                    openCallWindow(url)     scheme in {http, https, mailto}?
                                      │                       yes: shell.openExternal(url)
                                      │                       no:  not opened
                                      │
                 ┌────────────────────┴───────────────────┐
        no call window open                       call window already open
                 │                       ┌─────────────────┴─────────────────┐
   create BrowserWindow (hardened,   meeting page on screen       no meeting page on screen
   same session as main)             (or address not recognised)  (opening, error, crashed,
                 │                   focus + notify "A call is     sign-in, Meet landing)
                 │                   already open..."; do NOT      load new link into the
                 │                   navigate                      existing window; raise +
                 │                                                 focus; no notification
   Meet page requests camera/mic/screen
                 ▼
   session permission handlers (request + check)  ── origin gate ──▶ deny unless https://meet.google.com
                 ▼ (display capture only)
   setDisplayMediaRequestHandler ─▶ app source picker window ─▶ user picks / cancels
```

| Unit | Kind | New or changed | Purpose |
|---|---|---|---|
| `classifyExternalUrl(url)` | pure function, no Electron import | new | The only place that decides Meet versus system browser. Unit-testable against NFR-07's table. |
| `openCallWindow(url)` / `getCallWindow()` | main-process module | new | Owns the one call window, its `webPreferences`, navigation limits, popup denial, close behaviour. |
| App view (`callUiView`) | child `WebContentsView` of the call window, local HTML, own preload | new (section 3a) | The app-drawn loading, load-error and crashed panels. Never shows Meet. (No status strip: owner decision 2026-10-01.) |
| External-link scheme gate | pure function next to `classifyExternalUrl` | new | For `kind:'external'`, returns "open" only for `http:`, `https:` and `mailto:`; used by the main window's handlers and the call window's (owner decision 2026-10-01). Unit-testable against the NFR-07 scheme table. |
| Permission handlers | `src/main/session.js` | changed | Replace "grant `notifications`, deny the rest" with origin-aware request **and** check handlers. |
| Display-media handler + picker | main + small local renderer | new | Screen-share source choice. |
| `setWindowOpenHandler`, `will-navigate` on the main window | `createWindow` in `src/main/index.js` | changed | Route through `classifyExternalUrl`. |

## 2. URL classification contract

```
classifyExternalUrl(input: string) -> { kind: 'meet', url: string } | { kind: 'external' }
```

Never throws; anything unparseable is `external`. Rules, all from NFR-07 (the test table lives there and
is not repeated here):

1. Parse with the WHATWG `URL`. Accept as Meet only when `protocol === 'https:'`, `hostname ===
   'meet.google.com'`, `port === ''` (default 443 normalizes to empty; any other explicit port is refused),
   and `username === '' && password === ''`. Hostname case is normalized by parsing; a trailing dot, a
   suffix or a lookalike host is a different hostname and fails the equality.
2. **Unwrap once.** If the URL is exactly `https://www.google.com/url` (hostname `www.google.com`, path
   `/url`, https, no port, no userinfo), read `q`. Require **exactly one** `q` parameter
   (`searchParams.getAll('q').length === 1`; a duplicated `q` is refused, a hardening not spelled out in
   NFR-07 that only narrows it). Parse the decoded value; it must pass rule 1 **on its own**. A wrapper
   target that is itself a wrapper fails naturally because its hostname is not `meet.google.com`. Any other
   host with a wrapper-shaped URL is not unwrapped.
3. Return the **target** URL's normalized `href`, never the wrapper, as the URL the call window loads.
4. **Scheme gate for `kind:'external'` (owner decision 2026-10-01).** Only a parsed `protocol` of `http:`,
   `https:` or `mailto:` is passed to `shell.openExternal`; every other scheme (`file:`, `ms-settings:`,
   `javascript:`, custom schemes) and every unparseable value is **not opened**: no `openExternal`, no
   window. This replaces today's "every other URL goes to `shell.openExternal`" in the main window's
   `setWindowOpenHandler` and `will-navigate` handlers, and applies to the call window's own routing too
   (section 3c). The Meet test of rules 1 to 3 runs first.

Where it is called: the main window's `setWindowOpenHandler` (new-window requests) **and**
`will-navigate` (the main frame navigating to Meet is prevented in the main window and routed the same
way). Redirects (`will-redirect`) are the implementer's decision to cover for the main window; NFR-07 puts
only `will-navigate` in scope, so a redirect chain into Meet is an open question below.

## 3. Call window

- `new BrowserWindow` with `webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
  partition: PARTITION }` (`PARTITION` in `src/main/session.js`, the main window's session, so the Google login
  carries over). **The Meet web contents has no preload and no bridge**: nothing is exposed to Meet. The
  app-drawn UI lives in a separate view (section 3a). Automated tests assert the options each web contents
  is **created with** (NFR-07), not only the live contents.
- `setWindowOpenHandler` returns `{ action: 'deny' }` for every popup: **no popup window is ever created**.
  Owner decision 2026-10-01: the denied target is then routed as in section 3c (an `http`, `https` or
  `mailto` target opens in the system browser; any other scheme is not opened), so the call window's own
  denial stays intact and the link is not silently lost.
- Navigation limit: `will-navigate` allows only `https://meet.google.com` and `https://accounts.google.com`
  (sign-in re-authentication) and blocks the rest; a blocked navigation target is routed as in section 3c.
  Whether iframe navigations and `will-redirect` must
  also be limited, and whether Meet legitimately navigates to other Google hosts during a call, is unknown
  [U] and is a Spike B observation; do not widen the list without evidence and an owner decision, since the
  rule names exactly these two hosts.
- **The call window has a `close` handler** (unlike "no interception"; full mechanics and the live-call
  probe are in section 3b). In order, for an app-initiated close:
  1. If `isQuitting` is true, or the close is the deliberate destroy after an answer, the handler yields and
     the window is destroyed. Never `hide()`.
  2. If the **source picker is open** the close is blocked: the picker is raised, focused and flashed
     (`flashFrame` on the picker window, not the main window), so the attempt is never silent.
  3. Otherwise Meet's own unload objection decides: a page that does **not** object lets the window be
     destroyed at once; a page that **objects** (a live call) shows the SC-2 confirm (P1,
     owner-approved 2026-10-01; section 3b).
  Destroying the window ends the participant's call and must release camera, microphone and screen capture;
  confirm the OS camera indicator goes off on a real desktop (FR-16 manual scenario): release on destroy is
  expected but unverified [U]. Closing never touches `isQuitting` and never quits (`window-all-closed` is a
  no-op).
- **One call window (owner-approved; the no-meeting-page branch below was decided by the owner on
  2026-10-01, design A3).** A second Meet link never opens a second window. Two branches, chosen by
  whether the call window shows a **meeting page**:
  - **Meeting page on screen** → the existing window is restored if minimized, raised and focused; the
    existing call is **not** navigated; the OS notification "A call is already open. The new link was not
    opened." is shown **regardless of mute** (app status, not a chat message); clicking it focuses the call
    window. It is created in the main process as an Electron `Notification` and does not pass through the
    FR-05 mute check. If the picker is open, the picker (with its call window) is raised and focused.
  - **No meeting page on screen** (opening, load-error, crashed, Google sign-in, Meet landing) → nothing can
    be lost: the new link is **loaded into the existing window** (state back to `opening` for the new
    address), the window is raised and focused, and **no notification** is shown, because "a call is already
    open" would be false.
  - **"Meeting page" is defined by exclusion, on purpose:** the known non-meeting pages are the app's own
    panel states, `accounts.google.com`, and `meet.google.com` at path `/` or `/landing`. Anything else,
    **including an address form the rule does not recognise, counts as a meeting page.** The failure
    direction is safe: an unknown page gets "focus and notify", never "navigate away". This predicate uses
    the address and panel state only and is **not** the live-call probe of section 3b (different question,
    different failure direction).
  - **Dependency, stated so it is not missed:** the notification is only as reliable as OS toast delivery,
    which is BUG-01 (Spike A). If toasts are suppressed the user still sees the call window come to the
    front, but the "never silent" wording of FR-16 is not guaranteed until Spike A is resolved.
  - Whether it follows the sound setting (FR-11) is unspecified; assumption: it follows it.
- **Tray and attention.** Tray Show/Hide acts on the main window only and never hides or closes the call
  window. A separate tray entry **"Show call window"** (design 03 F7, SC-4; present in every call-window
  state; owner-approved 2026-10-01, P3) restores, raises and focuses the call window; when the source picker is open
  focus goes to the **picker**. The main window is untouched. FR-14 indicators still fire while the call window has focus (see
  [tray-lifecycle.md](tray-lifecycle.md)); the call window never appears in that logic.
  Tray Show/Hide acting on the main window only remains a recommended default, not an owner decision.

## 3a. App-owned view inside the call window (decision, provisional pending the wireframes)

**Revised 2026-10-01.** The status strip ("A link was not opened.") is **removed**: the owner decided that
non-Meet links clicked in the call window open in the system browser (section 3c), so there is nothing to
report. The app view therefore draws **panels only**, and no strip behaviour remains below.
One consequence: the app view is never a thin band beside Meet, so Meet never has to be shrunk (see the
layout notes).

**Problem.** The design ([design/04](../design/04-meet-call-window.md)) draws app UI in the call window: a
loading panel, a load-error panel (Try again, Close) and a crashed panel (Reload, Close). That UI cannot come from
Meet's page, cannot be a local page in the same web contents (the Meet page is what the window navigates,
and navigation is limited to two Google hosts), and a crashed Meet renderer cannot draw its own panel. The
offline and back-online strips are being cut from the design (the signals are unobservable) and are **not**
designed for here.

**Decision.** The call window hosts **two web contents in two processes**: the Meet page, and a small
**app view** (a `WebContentsView` layered over or beside it) that loads only a bundled local HTML file with
its own narrow preload. The main process owns layout and every state transition; the app view only renders
what it is told and reports button presses.

```
 call window (BrowserWindow, Meet web contents = win.webContents, session = main session)
 ├── Meet page   https://meet.google.com   no preload, sandbox, popups denied, navigation limited
 └── app view    local file only, own preload, own non-persistent session, sandbox
      states: opening | slow | load-error | crashed | ok (view hidden)
```

**Why this shape (versus the alternatives).**

| Alternative | Verdict |
|---|---|
| A. Local page as the top-level page, Meet embedded in it (iframe or `<webview>`) | Rejected. NFR-07 requires the **top-level** page origin to be `https://meet.google.com` for media permissions, so an embedded Meet frame would be refused; and ADR-0001 forbids `<webview>`. |
| B. Inject DOM into the Meet page | Rejected. Injecting into a page the app does not control is the fragility ADR-0002 already calls the riskiest point, breaks on a crashed renderer, and violates the *Wrapper, not a rewrite* project rule. |
| C. A separate frameless overlay window | Rejected. Two top-level windows must be kept aligned by hand across move, resize, minimize, full screen and the taskbar; they appear as separate windows to the OS. |
| D. No app UI: rely on Meet's own errors and OS notifications | Valid fallback if the design is cut back; it cannot show a crash or load failure (a crashed page draws nothing), so it drops the design's F2 and crashed flows. Not chosen because the design and FR-16 scenarios call for them. |
| **E. Second web contents in a child view (chosen)** | Survives a Meet crash (separate process), keeps Meet's contents free of any bridge, and needs only main-process layout code. |

**Host window (preferred): `BrowserWindow` with a child `WebContentsView`, not `BaseWindow` with two
views.** Updated 2026-10-01: with the strip removed, the app view only ever **covers the whole content
area** (panels) or is **hidden**, so Meet's bounds never need to be set independently of the child view.
The earlier reason to consider `BaseWindow` (shrinking Meet beside a strip) is gone; what remains
unverified is only whether a `BrowserWindow` can host the child view at all (below).
- *For `BrowserWindow`:* device release on close (below) and the design's need for Meet's own unload
  objection to be consulted when the window closes (section 3b), which the window does for its own
  `webContents`.
- *Fallback, only if `BrowserWindow` cannot host the child view [U]:* `BaseWindow` with **two**
  `WebContentsView`s. That fallback then makes two things **mandatory**: (1) the **device-release
  gate** (explicit `close()` of both web contents in `closed`; FR-16 manual scenario on every release), and
  (2) a different close mechanism, because a `BaseWindow` close does not consult a child view's unload
  objection and `will-prevent-unload` is documented as not respected for `BrowserView` (unverified for
  `WebContentsView`); see section 3b.

Rationale for the preference, unchanged:
FR-16 requires that closing the call window releases the camera, microphone and capture. Electron's
`BaseWindow` documentation states that when a `WebContentsView` is added to a `BaseWindow` and the window is
closed, the view's `webContents` "are not destroyed automatically" and closing them is the app's
responsibility, else they leak. A `BrowserWindow` owns and destroys **its own** `webContents`, so the
privacy-critical Meet contents is released by the window closing, and only the small app view needs manual
cleanup. Chosen also so a forgotten cleanup can leak a local status page, not a live camera. Verification
status:
- Verified in Electron docs (fetched 2026-09-30): `WebContentsView` takes `webPreferences` and has
  `setBounds` and a read-only `webContents`; `View` has `addChildView`, `removeChildView`, `setBounds`,
  `setVisible`; `BaseWindow.contentView` exists; the not-destroyed-automatically warning above;
  `webContents` events `render-process-gone` (`details.reason`), `did-fail-load` (`errorCode`,
  `isMainFrame`), `unresponsive`, `will-navigate`; `contents.close()` and `contents.reload()`.
- **Unverified [U]:** the docs page for `BrowserWindow` does not itself document `contentView` or
  `addChildView` (it states `BrowserWindow extends BaseWindow`, so the members are expected to be
  inherited). The implementer confirms on the pinned Electron 44.4.3 with a real build. **If a
  `BrowserWindow` cannot host the child view, fall back to `BaseWindow` with two `WebContentsView`s and
  explicit `webContents.close()` on both in the window's `closed` handler, then re-run the device-release
  check (FR-16 manual scenario) as a release gate.**
- **Unverified [U]:** behaviour of a child view during Meet's HTML full screen (the app view is hidden
  whenever Meet is showing, so the expected case is no visible difference; the exact full-screen event
  and result must still be checked); screen-reader behaviour across two web contents in one window;
  keyboard focus hand-off (main calls `focus()` on the right contents: the app view when a panel appears,
  Meet when the panel gives way).

### Layout and state ownership (main process)

- **Layout.** Main sets the app view's bounds and recomputes on the window's resize, maximize, restore and
  full-screen events. Panel states (opening, slow, load-error, crashed): the app view covers the whole
  content area, so no click reaches Meet. No panel (`ok`): the app view is hidden and Meet fills the area.
  There is no partial-height state.
- **States and their sources.** `opening` on window creation; `slow` from a single one-shot timer
  (10 s per the design), cleared on finish-load, failure or destroy (no recurring timer); `load-error`
  from `did-fail-load` with `isMainFrame` true, ignoring the Chromium aborted-load code (-3, a superseded
  navigation, not a failure; [U], verify); `crashed` from `render-process-gone` on the **Meet** contents.
  A blocked navigation or popup does **not** change the state (it is routed, section 3c). Only main
  decides the state; the app view cannot change it. The design's "automatic retry when the network returns" needs a
  network signal that is being cut and is **not designed**.
- **Actions.** Try again and Reload call `reload()` (or reload the Meet address) on the Meet contents and
  return to `opening`. **Close** (offered in `slow`, `load-error` and `crashed`, where there is no live page
  to object) **destroys the window directly**, with no probe and no dialog. The design draws the close and
  Exit confirms (SC-2) as **native OS dialogs**, not app-view states; their mechanics are in section 3b.
  Destroy-on-close otherwise stays exactly as in section 3.
- **If the app view's own renderer dies** the panels cannot be drawn. Aligned with the design (F11): main logs
  a warning (never page content) and leaves the window as it is; if the Meet page is also dead the user sees
  a **blank window that they can close** (no dialog: nothing can object). Main does **not** recreate the
  view or raise a notification. (Recreating the view once is a possible improvement, not designed; raise it
  with the owner only if this proves likely in practice.)
- **Cleanup.** In the window's `closed` handler main calls `close()` on the app view's web contents and drops
  every reference; on `render-process-gone` of Meet it never leaves the crashed contents' devices assumed
  released without the manual check.
- **Picker lifecycle on a dying page.** On `render-process-gone` of the Meet contents, or on any teardown of
  the Meet page (window `closed`, a navigation that replaces the requesting frame), main: (1) closes the
  open source picker, if any; (2) **denies** the pending display-capture request (the handler's callback is
  invoked with no source, exactly once; a callback already used is never invoked again); (3) drops the
  picker's references. A source is **never** handed to a page that is gone. With the modal picker closed,
  the call window is no longer blocked, so the crashed panel's **Close** (CW-4) is reachable. The picker's
  own answer handler checks that the request is still pending and the window is not destroyed before it
  returns anything; a late selection after teardown is dropped.

### Security constraints for the app view

These are hard requirements, checked on the options the view is **created with** (as for the Meet view) and
by tests where reachable:

| Constraint | Value |
|---|---|
| `contextIsolation` | `true` |
| `sandbox` | `true` |
| `nodeIntegration` | `false` |
| Content | one bundled local HTML file loaded with `loadFile`; no remote URL, ever |
| Navigation | none: `will-navigate` (and frame navigation) always `preventDefault()`; `setWindowOpenHandler` returns `deny`; no `openExternal` from this view |
| Session | its own **non-persistent** partition, **not** the main session, so it shares no cookies or storage with Google and is unaffected by the Meet permission handlers; every permission request on that session is denied |
| Network | nothing to load; an implementer may additionally cancel every non-`file:` request on that session (defence in depth, optional) |
| CSP | a strict policy in the HTML (no inline script, no remote sources) |
| Preload | its own file (never shared with the main window's or the Settings window's preload), exposing only the surface below |
| Inputs rendered | text only, via `textContent`. Every value from main is an enum, a number (error code) or the display address main constructs. **No string taken from the Meet page is ever sent to the view**, so the Meet page cannot inject text into app UI |
| Outputs | a fixed enum of actions; main validates the value **and** that it is legal in the current state |
| What it never receives | the Meet URL's path, query or fragment beyond a display address main constructs (for example `meet.google.com/abc-defg-hij`), cookies, tokens, message or chat content, or screen thumbnails |
| Meet's own contents | unchanged: no preload, no bridge, and the app view is a **sibling**, not the Meet page's embedder, so NFR-07's "top-level origin is Meet" holds for the Meet contents |

**IPC surface (provisional, drawn from the design; see [ipc-contract.md](ipc-contract.md)):** one
main-to-view state channel and one view-to-main action channel, nothing else.

## 3b. Close, Exit and tray with a call window (mechanics; P1, P2, P3 owner-approved 2026-10-01)

The Meet design ([03](../design/03-meet-flows.md) §0 and F5 to F7, [06](../design/06-meet-shared-components.md),
[08](../design/08-meet-open-questions.md), [09](../design/09-meet-proposed-amendments.md)) proposed three
behaviours. **The owner approved all three on 2026-10-01 and they are now in the requirements** (FR-07,
FR-16). This section fixes the mechanics so that they cannot break the quit-path rules. P1 is approved as
option A (confirm on a live call, no Settings switch); delivery of P1 and P2 still depends on Spike B
proving the live-call signal, and without it they never show a dialog (failure direction, below).

| # | Behaviour (approved) | Requirement | Touches |
|---|---|---|---|
| P1 | Native confirm "Close the call window?" when the window is closed during a **live call** | FR-16 "Closing during a live call" | FR-16 "closing destroys it" |
| P2 | Native confirm "Exit Google Chat Desktop?" on tray Exit during a **live call** | FR-07 Exit | FR-07 (Exit is the only quit) |
| P3 | Tray entry **"Show call window"**, first in the menu, present in **every** call-window state; no tray tooltip change | FR-07 | FR-07 menu contents ("at minimum", so additive) |

### Three different questions, three different signals (do not conflate)

| Term (design 03 §0) | Signal | Used for | Missing or wrong signal means |
|---|---|---|---|
| Call window exists | certain: the app owns it | one-window rule; P3 entry | cannot be missing |
| Meeting page on screen | the address plus the app's own panel state, **by exclusion** (section 3) | second-link routing | counts as a meeting page: focus and notify, never navigate away |
| **Live call** | **Meet's page objects to being unloaded** (`beforeunload`), observed only at a close attempt | P1, P2 | treated as **not live**: no dialog, the window closes or the app exits |

The earlier idea of guessing a live call from the page address or from `isCurrentlyAudible()` is **dropped**:
neither signals a live call reliably. The only signal is the page's own objection.

### Rules for any of P1 and P2

1. **A confirm must never block OS shutdown or `before-quit`.** `before-quit` sets `isQuitting`
   (the `before-quit` handler in `src/main/index.js`) and is also what an OS shutdown reaches [U on Windows and
   Linux]. It never calls `preventDefault()` and never shows a dialog. Confirms are **asynchronous**
   dialogs, never a synchronous event-loop-blocking one.
2. **Intercept, then destroy; never hide.** Answering "close" **destroys** the window; there is no path
   that hides it, since a hidden call keeps the camera and microphone live.
3. **`isQuitting` wins.** Every close handler below yields when `isQuitting` is true, **and** the
   `will-prevent-unload` handlers then override any objection synchronously, or the quit would be
   silently cancelled (see "Quitting is unconditional" below).
4. **No new quit path.** A confirm only adds a question in front of the existing tray Exit
   (the *Quit only from the tray* project rule).
5. **Guard the lifecycle.** At most one confirm at a time. A second **close** request while one is open is
   ignored (the open confirm already represents it). **Exit is never ignored** (it is the only quit path):
   tray Exit while P1 ("Close the call window?") is open **dismisses P1 and shows P2** ("Exit Google Chat
   Desktop?"); tray Exit while P2 is already open **focuses P2**. A dismissed P1 is treated as "Keep window
   open" (nothing destroyed). The answer handler checks `isDestroyed()` first, and a dismissed dialog's
   answer is discarded.

   | Open confirm | New request | Outcome |
   |---|---|---|
   | none | close | probe; P1 only if live |
   | none | Exit | probe with `exitProbe`; P2 only if live |
   | P1 | close | ignored (P1 stays) |
   | P1 | Exit | P1 dismissed, P2 shown |
   | P2 | close | ignored (P2 stays) |
   | P2 | Exit | P2 focused |
6. **A close is never silently swallowed** (design invariant I1). Every app-initiated close ends in exactly
   one of: window destroyed; confirm shown and answered; or, with the picker open, the picker raised and
   flashed.

### Mechanism on the preferred `BrowserWindow` path (all steps [U] until Spike B)

Meet is `win.webContents`. Electron documents that the window `close` event fires **before** the DOM
`beforeunload`/`unload` events, and that `will-prevent-unload` "triggers when a `beforeunload` handler
attempts to cancel page unload" and that calling `event.preventDefault()` in it lets the page unload despite
the handler. `contents.close({ waitForBeforeUnload: true })` fires `beforeunload` first and does not close if
the page prevents the unload. The sequence for a user close (title-bar X, Alt+F4, taskbar close):

1. `close` handler runs. It yields if `isQuitting` or if this is the destroy that follows an answer.
2. **Picker open?** Block the close: raise and focus the picker and `flashFrame` **the picker window**
   (never the main window). The call window stays; the attempt was not silent.
3. Otherwise start a **one-shot timeout** (design I3; proposed 3 s, owner may change) and let the close
   proceed, so Chromium runs Meet's `beforeunload`.
4. **Page does not object** → the window is destroyed; clear the timer. No dialog.
5. **Page objects** → `will-prevent-unload` fires on the Meet contents. **Always registered from window
   creation**, so an objection is never left with no listener (a page objection with no listener would
   otherwise cancel the close silently). The handler clears the timer and shows the async SC-2 confirm (if
   P1 is approved; if not, it destroys). **"Close window"** overrides the objection and **destroys** the
   window; **"Keep window open"** does nothing further (window stays, focused). The handler does not call
   `event.preventDefault()` itself, because the dialog is asynchronous and the event handler returns first;
   the override is `destroy()`, which skips unload. (A synchronous `preventDefault()` is the documented
   way to ignore an objection at once and is usable only for a no-dialog path.)
6. **Hung page** (no answer within the timeout) → treated as **not live**; the window is destroyed.
7. **No user activation:** a browser engine honours an unload objection only after the user has interacted
   with the page (design I6). A user who never clicked in the call window produces no objection, so it is
   the "signal missing" case: closed without a dialog.
8. **Failure direction:** a missing or unobservable signal always means **no dialog**, the window closes.
   The cost is one unguarded close; the opposite error would prompt at the end of every call.

**The override applies only to app-initiated closes** (design I4). `will-prevent-unload` may also fire for
navigations the page starts itself (a Meet reload or link) [U]. The handler acts only while an app-initiated
close is in progress: a flag set in step 3 and **consumed by the FIRST objection after step 3 only**. Once
that objection has been handled (the dialog is showing, or the override done), the flag is cleared, so a
page-initiated `will-prevent-unload` that arrives while the async dialog is open is **not** treated as
app-initiated. The one-shot close timeout is cleared on every outcome, including the window's **`closed`**
event (so it can never fire on a destroyed window). For anything else the handler must not override.

**Quitting is unconditional, so it is app-initiated: the objection is always overridden.** `app.quit()`
closes all windows first, and a window whose `beforeunload` objection is not overridden **cancels the quit**.
Without a rule the failure is silent and dangerous: with `isQuitting` true the call window's `close` handler
yields, Meet objects, `will-prevent-unload` fires, nothing overrides, the quit is cancelled, and
`isQuitting` stays true, so the main window's next X **destroys** the main window instead of hiding it,
breaking the *Quit only from the tray* project rule and close-to-tray. Rules:
1. While `isQuitting` is true, the `will-prevent-unload` handler on **every** window that can host a
   page (the call window's Meet contents, and the main window's contents) calls `event.preventDefault()`
   **synchronously** (no dialog, no async step), letting the page unload. This covers Exit after P2 is
   rejected or option C, an OS shutdown during a live call and any other quit. (A second launch does not
   quit the resident app: the second **process** exits itself and the resident app only focuses its main
   window, FR-08; the resident app's quit paths remain tray Exit and OS shutdown only.)
2. **If a quit is nevertheless cancelled** (some path still stops it), `isQuitting` is **reset to false**
   (on the quit-cancelled outcome, or a guarded timeout after `before-quit`) so close-to-tray works again.
   Never leave `isQuitting` true after a quit that did not happen. [U] how to observe a cancelled quit
   in Electron 44.4.3; the implementer proves it with a test that quits with an objecting stub page.
3. `before-quit` itself still never calls `preventDefault()` and never shows a dialog.
**Unverified and important:** what Electron does with a page-initiated `beforeunload` objection when nothing
handles it. If it is a **silent block**, the design's premise that Meet's own "Leave site?" protection stays
is false, and the user would see a reload or navigation do nothing. Spike B must observe it and report to the
designer and owner.

### Exit (P2) is a close attempt

The tray Exit handler, if a call window exists and `isQuitting` is not yet set, runs the **same path** as a
user close with an `exitProbe` flag, and is **only** run when the app is about to quit anyway (never for OS
shutdown or any path that does not end in quitting):
- **Not live** (no objection, hung, no activation, signal missing) → the call window is destroyed and
  `app.quit()` follows on its `closed`; no dialog.
- **Live** → the async confirm "Exit Google Chat Desktop?"; **Exit** overrides the objection (destroy) and
  `app.quit()`; **Cancel** (default, Escape) clears `exitProbe` and leaves the window and app untouched.
- **No call window** → `app.quit()` as today.
- **Exit while a confirm is open** follows rule 5: P1 open → P1 dismissed and P2 shown; P2 open → P2
  focused. Exit is never silently ignored. If the dismissed P1 had a probe in flight, the Exit path
  starts its own `exitProbe` and consumes the objection (the single-flag rule below still holds).
  **Stale notification click:** the "call already open" notification (section 3) may be clicked after the
  call window was destroyed. The click handler checks `isDestroyed()` and, if the window is gone, does
  **nothing** (a no-op: no new window, no main-window focus, no error); the notification's meaning
  expired with the call.
**Picker open during the probe (design I5):** the probe first **closes the picker and denies its pending
display-capture request** (nothing is shared, no source chosen), then probes the call window. The
picker-open block of step 2 does not apply to the probe. Because the probe destroys a non-objecting window before the quit, it is correct only because the
quit is then unconditional.

### Fallback path (`BaseWindow` with two views, if section 3a's layout forces it) (all [U])

A `BaseWindow` close does not consult a child view's `beforeunload`. The probe becomes
`meetView.webContents.close({ waitForBeforeUnload: true })` on the Meet view: if the page prevents the
unload the contents are not closed, otherwise they are destroyed and the window follows. The electron docs
note that `will-prevent-unload` prevention is **not respected for `BrowserView`** and it is unverified for
`WebContentsView`. If the event is not delivered, "objects" and "hung" cannot be told apart, so live-call
detection is unavailable and, by the failure direction above, **P1 and P2 never show a dialog**. The owner
should know that this fallback may silently remove the point of P1 and P2.

### P3: "Show call window"

Present while a call window exists, in any state, first in the tray menu; no tooltip is added (dropped
from the design). The menu is rebuilt (`refreshMenu`, event-driven, not from the blink tick, so NFR-06
holds) when the call window is created and destroyed. The handler restores, raises and focuses the call
window, **except that when the source picker is open focus goes to the picker** (the window that can take
input); the main window is never touched. See [tray-lifecycle.md](tray-lifecycle.md).

### Source picker rules (from design 05; provisional with it)

- The picker is a **modal child of the call window** (Electron window `parent` plus `modal`), so the call
  window is blocked while it is open.
- A close attempt on the call window raises, focuses and flashes the **picker** (step 2 above).
- Tray "Show call window" and a second Meet link (meeting page case) focus the **picker**.
- **The picker flash is `flashFrame` on a non-main window.** The FR-14 `attention.stop()` must not touch it:
  the attention module targets only the main window (never enumerates all windows), and the picker flash
  clears on its own focus. Whether one `flashFrame(true)` on an already-focused window is visible is [U].

## 3c. Links and popups from inside the call window (design F10, OQ-3 — decided 2026-10-01)

**Owner decision: option A.** A link the call window would otherwise block (a popup request, or a
navigation to anything other than `meet.google.com` / `accounts.google.com`) is routed, and nothing is
drawn in the window (the strip of the earlier design is removed):

1. The popup is **denied** (no window is created) or the navigation is **blocked** (the call window stays
   on its page), exactly as before.
2. The target goes through `classifyExternalUrl` and the scheme gate (section 2, rule 4): `http`, `https`
   or `mailto` → `shell.openExternal`; any other scheme or unparseable value → not opened.
3. A target that is a **Meet link** is not sent to the system browser. Working default (not owner-decided):
   it follows the second-link rule of section 3, which, with a meeting page on screen, focuses the window
   and shows the "call already open" notification and does not navigate. (A Meet link inside a Meet page is
   plausible, for example in the in-call chat.)
4. The state of the call window and of the app view does not change; the user stays in the call, and the
   system browser comes to the front through the OS.

Consistency with the project rule: it says the call window "denies its own popups" (kept: no popup window
exists) and "every other URL still goes to the system browser" (kept for `http`, `https`, `mailto`); the
scheme allow-list is a further narrowing. No navigation of the call window is widened, so the
two-host navigation limit is unchanged.

## 4. Permissions (NFR-07)

The session is shared, so the handlers see requests from the **main window and the call window alike**
and must decide by origin, not by window.

- **Rule:** camera, microphone and display capture are granted only when **both** the requesting origin and
  the top-level page origin equal `https://meet.google.com` exactly. Refuse: `http://meet.google.com`, any
  other origin including `https://chat.google.com`, a Meet frame embedded in a non-Meet page, and a
  non-Meet frame embedded in a Meet page.
- **Both handlers.** `configurePersistentSession` in `src/main/session.js` **already installs both** a
  request and a check handler (added by the BUG-01 change), and both currently grant only `notifications`
  (chat origin, plus a dev loopback origin) and `clipboard-sanitized-write` (chat origin only, BUG-02),
  denying every other permission. The Meet media
  gate below **extends** those two handlers; it does not add a check handler. Electron notes that most web APIs do a
  check and then a request if the check is denied, so a request-only policy is incomplete.
- **Inputs available** (Electron session docs, fetched 2026-09-30): the check handler receives
  `webContents` (which **may be null**), the permission name, `requestingOrigin` and a `details` object that
  can carry `securityOrigin`, `embeddingOrigin` (for cross-origin subframes), `requestingUrl`,
  `isMainFrame` and, for media, **`mediaType` (singular: `video`, `audio` or `unknown`)**. The **request**
  handler's details use the plural `mediaTypes`; the two handlers differ, so the gate must not share one
  parser. Fail closed: a null `webContents`, a missing origin or an `unknown` media type is a denial. How to
  derive "top-level page origin" in each handler (from `webContents.getURL()` versus
  `details.embeddingOrigin`) is an implementer decision that the NFR-07 matrix (seven requesting/top rows)
  must pin down in tests.
- Permission names to gate (to be confirmed by the implementer against Electron's permission list, not
  asserted here): the camera/microphone permission (`media`) and `display-capture`. Any other permission
  keeps today's behaviour.
- **The effective gate for screen capture is `setDisplayMediaRequestHandler`, not these two handlers.**
  `getDisplayMedia` is served by that handler (section 5), so the permission handlers'
  `display-capture` rule is defence in depth and must not be relied on as the only barrier. Both are
  origin-gated, and the display-media handler is tested on its own.
- **Notifications unchanged (NFR-07).** The main window's notifications permission is now granted to the
  chat origin only, in both handlers; the Meet gate must leave that behaviour exactly as it is (test:
  `Notification.permission` and a notification still work in the main window after the change).
- **Clipboard (BUG-02, fixed).** The handlers grant `clipboard-sanitized-write` to the chat origin only
  (separate `clipboardOrigins` allowlist); all other clipboard permissions stay denied. Adding the Meet media
  grant must not widen any of this.

## 5. Screen share and the source picker

- Electron requires `session.setDisplayMediaRequestHandler()` for `getDisplayMedia` (ADR-0004). It is
  session-wide, so it must first apply the same origin gate: a request whose frame origin is not exactly
  `https://meet.google.com`, or whose top-level page is not, is denied without showing a picker.
- Otherwise the handler opens the **app's own picker** and returns a source only after the user selects
  one; cancel denies the request. **The app never selects a source automatically.** Sources come from
  `desktopCapturer` in the main process. Thumbnails contain live screen content: they are sent only to the
  picker window, never logged, persisted or sent elsewhere.
- The picker is a new UI surface. **It is being wireframed separately; this document does not design it.**
  It should follow the Settings window pattern (own local HTML, own preload, no third-party origin); the
  provisional IPC is in [ipc-contract.md](ipc-contract.md) and is subject to the wireframe.
- **Linux: the OS picker may replace the app picker, only if Spike B shows it works; the user always
  chooses explicitly; a silent or pre-selected source is never allowed on any platform.** This is the
  amended project rule (mirrored in the overview), so there is no rule conflict; what remains is technical.
  What "defer to the OS picker" means concretely, and what is and is not known:
  - **It is not `useSystemPicker`.** Electron documents that option as **experimental and available for
    macOS 15+ only**, and says that when the system picker is available "the media request handler will not
    be invoked". It is not the Linux mechanism and must not be relied on there.
  - **The Linux mechanism is `desktopCapturer.getSources`.** Electron documents that it "only returns a
    single source on Linux when using Pipewire". Whether that call is what raises the xdg-desktop-portal
    dialog (so the one returned source is the user's own choice in that dialog) is **not stated in the
    docs [U]**. That is the thing to prove.
  - **Consequence for the app picker under PipeWire.** If `getSources` itself raises the portal dialog, an
    app picker in front of it would make the user choose twice (portal, then a one-entry app list). So on
    PipeWire the coherent design is: the handler calls `getSources`, returns the single source, and shows
    **no app picker**. On a session where `getSources` enumerates without any dialog, the app picker is used.
  - **What Spike B must demonstrate on a real Wayland/PipeWire desktop, for the single returned source to
    count as an explicit choice and not a pre-selection:** (1) the OS dialog appears on **every** share
    start (no remembered choice or restore token that skips it silently); (2) cancelling the dialog denies
    the request and returns nothing; (3) the app shows no picker of its own and pre-selects nothing; (4) the
    source Meet receives is the one the user chose. If (1) fails (the source is returned without a
    dialog), returning it would be a pre-selection, which is forbidden: screen share on that setup is then
    unavailable until the owner decides.
  - **X11 sessions:** the design position is the **app picker**. X11 has no portal-mediated capture, so
    `getSources` enumerates screens and windows normally and the app lists them; the user chooses in the
    app's picker. How to detect the session type at runtime (session environment versus Chromium's
    reported platform) and whether an X11 session ever reaches the portal are Spike B observations [U].
  - **Windows:** always the app picker.
  - If Spike B shows the Linux OS path cannot meet (1) to (4), the app picker is used on Linux too and the
    wireframe covers it (per FR-16). **Until Spike B has passed on Linux, Linux uses the app picker**
    (recommended default, 2026-10-01); the OS-picker path is switched on only by a passing result.

## 6. Verification and release

The `[manual-only]` scenarios in FR-16 need a real Meet call with real devices and are **re-run on every
release** on the platform being claimed, exactly as sign-in is under ADR-0001. A release that has not
re-verified Meet says so in its release notes (see [packaging-release.md](packaging-release.md)). Windows
verification does not establish Linux. If no Linux machine or VM with a camera or virtual camera exists,
Linux Meet stays unverified (ADR-0004 Spike B).

## Open questions and assumptions

1. **Spike B (Linux screen share):** can the OS-picker path meet conditions (1) to (4) in section 5 on a
   real Wayland/PipeWire desktop, and what does an X11 session do? If not, the app picker is used there too.
2. **Spike B (Meet itself):** does Meet load, sign in, and run camera, microphone and screen share in
   Electron 44.4.3 on Windows and on Linux?
3. **Redirects:** should `will-redirect` into a Meet URL from the main window be intercepted like
   `will-navigate`? NFR-07 does not require it. Assumption: not required now; revisit if Chat is observed
   to redirect.
4. **Non-web schemes — DECIDED by the owner 2026-10-01:** only `http`, `https` and `mailto` are opened in
   the OS; any other scheme is not opened (section 2, rule 4; requirements FR-16, NFR-07), and the
   *Electron security baseline* project rule now carries the allow-list. Open implementation point: the existing
   handlers in `index.js` currently pass every URL to `shell.openExternal` and must be changed
   (implementer, `security-engineer` review).
5. **Assumption:** the "call already open" notification follows the sound setting (section 3).
6. **Design rule adopted:** the source picker is a modal child of the call window; a close attempt raises,
   focuses and flashes it; tray "Show call window" focuses it; its flash is not touched by
   `attention.stop()` (section 3b).
7. **Owner:** confirm that the app-owned local view of section 3a is within the
   *Electron security baseline* project rule. Proposed one-line addition: "the call window may also host one app-owned
   view that loads bundled local content only, with its own sandboxed preload exposing a fixed, narrow IPC
   surface and no navigation".
8. **DECIDED 2026-10-01:** P1, P2, P3 of section 3b and A3 (the two-branch second-link rule of section 3)
   are approved. **Still open (owner):** the timeout for a hung page (proposed 3 s, to be fixed after
   Spike B measures it).
9. **DECIDED 2026-10-01:** links from inside the call window open in the system browser (section 3c). **Still
   open (owner):** a Meet link clicked inside the call window (section 3c, point 3, working default), and
   whether a non-web-scheme link needs any on-screen cue (currently none).
10. **Implementer:** the `BrowserWindow` plus child view arrangement of section 3a is unverified on 44.4.3;
    the fallback is `BaseWindow` with two views and explicit cleanup of both.
11. **Done:** NFR-07 now has a table row for the duplicate-`q` refusal (a recommended default, owner
    acknowledgement outstanding), a scheme table, and the app view's hardening assertion.
12. **Spike B, close mechanics** (cross-reference: the design's open question on the premise of invariant
    I4, that Meet's own "Leave site?" may be a **silent block** in Electron): does Meet's page object to
    unload during a call; does `will-prevent-unload` fire on window close for `win.webContents`; what
    happens to a page-initiated objection with nothing handling it (a silent block falsifies I4); does a
    quit started while an objecting Meet page is open get cancelled (section 3b, quitting rule). If the
    fallback layout is forced, does `will-prevent-unload` fire for a `WebContentsView` at all.
13. **DECIDED (orchestrator default 2026-10-01, owner to be told):** tray Exit is never ignored while a
    confirm is open (section 3b, rule 5).
</architecture>

<topics>
- [Requirements FR-16 and NFR-07](../business/requirements.md) — the authority for behaviour and the security matrix.
- [ADR-0004](../adr/0004-desktop-shell-technology-and-electron-retention.md) — Spike B and the fallback options.
- [IPC Contract](ipc-contract.md) — the Meet contents (no bridge), the app view channels and the provisional picker channels.
- [Tray & Lifecycle](tray-lifecycle.md) — how the call window relates to close-to-tray, Show/Hide, the tray entry and FR-14.
- [Overview](overview.md) — the window model this adds to.
- [Meet design](../design/03-meet-flows.md) — flows, wireframes and open questions being reviewed in parallel.
</topics>
