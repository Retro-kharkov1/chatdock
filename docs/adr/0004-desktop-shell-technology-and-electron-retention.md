# ADR-0004: Desktop shell — no migration now; retain Electron and reopen on defined triggers

**Date**: 2026-09-30
**Status**: Proposed, pending spikes (see "Spikes"). The decision below is conditional; it is not final until the spikes report.
**Deciders**: tech-lead (proposal), owner (decision pending). Tracker item UI-02.
**Amends**: [ADR-0001](0001-google-sign-in-strategy.md) (its Tauri escalation clause is replaced by "Escalation triggers" below). Does not supersede it.
**Touches**: [ADR-0002](0002-notification-delivery-mechanism.md) piece 2 and its fallback (see "Notification requirement").

## Context

The owner asked: if Electron cannot do the job, find an alternative. Open on Windows 11 (BUG-01,
diagnosed separately by `electron-developer`):

- **S1** — notification sound plays but no toast appears while the window is hidden.
- **S2** — the icon does not flash.

Owner observation, which matters for diagnosis: notifications **started appearing after diagnostic
activity** on the affected machine. So S1 may be intermittent or state-dependent (OS notification
state, app identity, page state) rather than a fixed defect. This ADR does not assume Electron is at
fault, and does not assume it is not.

New asks:
- **Meet in-app**: Google Meet calls inside the app with camera, mic and screen share. Now
  [FR-16 and NFR-07](../business/requirements.md) (owner-approved 2026-09-30; the space rule
  `electron-security-baseline` carries the matching single exception). Design:
  [meet-call-window.md](../architecture/meet-call-window.md).
- **Notification content and deep link**: the notification shows the chat name, and clicking it opens
  that chat. Now FR-05b and FR-05c step 2 (conditional on Spike C and an owner decision); FR-05a (a toast
  appears at all) is unconditional. Analysed here because the evidence below undercuts ADR-0002's design
  for it. Design candidates: [notifications.md](../architecture/notifications.md).

Standing requirements: [requirements.md](../business/requirements.md) FR-01..FR-16, NFR-01..NFR-08;
Windows + Linux installers (ADR-0003); the space rule `wrapper-not-a-rewrite`.

### Facts about the current code (verified in the repo, 2026-09-30; an **input** that dates quickly: the code is being changed, e.g. new attention and app-identity modules, so re-check before relying on any line below)

- `src/main/session.js:46-48` — the only permission handler grants `notifications` and denies every
  other permission; there is no `setPermissionCheckHandler`. Camera and mic are refused today.
- No `setDisplayMediaRequestHandler` in `src/main`; per Electron docs `getDisplayMedia` needs one.
- `src/main/index.js:338-339` — every `window.open` goes to `shell.openExternal`.
- No `flashFrame` call in `src/main`. The only attention signals are the FR-14 tray-image swap
  (`trayBlink.js`) and the Windows overlay icon (`tray.js:133`). S2 is at least partly an
  unimplemented feature, not proof of an Electron limit.
- The notification bridge wraps `window.Notification` (ADR-0002 piece 2).

## Evidence, by candidate

Tags: **[P]** primary doc, **[S]** secondary or third-party, **[U]** not verified.

**One standard for the third-party source.** Most negative evidence about Tauri, and the sign-in
claim in its favour, come from a single project (`ankurk91/google-chat-tauri`, its README and
`docs/Notes.md`). It is treated as **[S] in both directions**: every finding from it is a lead that
needs a spike, none is a verdict, and its sign-in claim is not relied on for any decision. Even
discounted this way, no alternative shows evidence of beating Electron, and the burden of proof lies
on migration.

### Electron (correctly configured)

- Windows toasts need a Start Menu shortcut with an AppUserModelID and ToastActivatorCLSID; Linux
  uses libnotify (Desktop Notifications Spec). These are the documented **API-level** facts. [P]
  https://www.electronjs.org/docs/latest/tutorial/notifications
  That a toast actually appears from a hidden window on this machine is **not established**: BUG-01
  is a live failure on Windows, and Linux delivery has never been verified in this repo. [U]
- `win.flashFrame()` supports Windows, Linux, macOS; `win.setOverlayIcon()` Windows only. [P]
  https://www.electronjs.org/docs/latest/api/browser-window
- `getDisplayMedia` needs `session.setDisplayMediaRequestHandler()`; on Linux with PipeWire only one
  source is returned. [P] https://www.electronjs.org/docs/latest/api/desktop-capturer ,
  https://www.electronjs.org/docs/latest/api/session
- Google's OAuth policy forbids sending an OAuth request to an embedded user-agent "under the
  developer's control" (can insert scripts, reroute requests, access cookies). It names no framework,
  so Electron, WebView2 and Tauri are all in the category; it targets third-party OAuth, and
  first-party sign-in in a wrapper falls to undocumented heuristics. [P]
  https://developers.google.com/identity/protocols/oauth2/policies
  ADR-0001 records the sign-in evidence (works today; a sibling project broke).
- Meet lists Chrome, Firefox, Edge and Safari as supported and is silent on embedded browsers. Meet
  in Electron is **not a documented, supported configuration**; behaviour [U]. [P] for the list.
  https://support.google.com/meet/answer/7317473
- Chat notification mechanics **[S]**, re-checked verbatim against `docs/Notes.md` (measured there
  on Ubuntu with real messages, in a Tauri webview and, for the URL, a stock browser):
  - "Real ones arrive through `ServiceWorkerRegistration.showNotification` … with neither an
    `onclick` nor a listener … the real handler is the service worker's own `notificationclick`,
    which the page cannot reach."
  - The `tag` is `<per-message id>/<sender user id>`, "so it names the *sender*, not the
    conversation."
  - "the document URL never moves off `chat.google.com/u/0/app/home` while you walk between
    conversations."
  - The note does **not** say what that service-worker handler does on click. It may focus a client
    and route to the conversation; that is [U].
  https://raw.githubusercontent.com/ankurk91/google-chat-tauri/main/docs/Notes.md
  Whether Electron surfaces service-worker notifications to the OS is [U].

### Tauri v2 (WebView2 on Windows, WebKitGTK on Linux)

- Engines: WebView2 (Chromium) on Windows, `webkit2gtk` on Linux, version varies by distro. [P]
  https://v2.tauri.app/reference/webview-versions/
- Notification plugin: desktop and mobile; on Windows fully correct only for installed apps (dev shows
  the PowerShell name and icon); actions mobile only; whether web `Notification` is bridged is not
  documented. [P]/[U] https://v2.tauri.app/plugin/notification/
- Window API: `requestUserAttention` (flashes window and taskbar on Windows; urgency on Linux),
  `setOverlayIcon` (Windows), `setBadgeCount` (unsupported on Windows). [P]
  https://v2.tauri.app/reference/javascript/api/namespacewindow/
- Bundles: NSIS/MSI; AppImage, deb, rpm. [P] https://v2.tauri.app/distribute/
- WebKitGTK denies media permission requests unless the embedder handles `permissions-request`;
  WebRTC and `getDisplayMedia` needed a custom WebKitGTK build and X11 in one discussion, undated in
  the fetched text. [S] https://github.com/tauri-apps/tauri/discussions/8426
- From the ankurk91 project notes [S]: web notifications "drop silently" on WebView2 and are denied on
  WebKitGTK; WebRTC absent from **Ubuntu's** WebKitGTK build; a hidden page is "inert" (Chat's router
  and the unread DOM do not run); a notification click cannot open the right conversation.
  Sign-in works per its README [S].
  https://github.com/ankurk91/google-chat-tauri

### Native .NET WebView2 host (WinForms/WPF), Windows only

- `CoreWebView2.NotificationReceived` lets the host render non-persistent web notifications and report
  shown/clicked/closed; unhandled ones use WebView2's UI. Non-persistent only, so whether Chat's
  service-worker notifications reach it is [U]. [P]
  https://learn.microsoft.com/microsoft-edge/webview2/concepts/overview-features-apis#browser-features
- `ScreenCaptureStarting`, `PermissionRequested`, `NewWindowRequested` events exist. [P]
  https://learn.microsoft.com/microsoft-edge/webview2/reference/win32/icorewebview2_27
- Cookies persist in a user data folder the host owns. [P]
  https://learn.microsoft.com/microsoft-edge/webview2/concepts/user-data-folder
- The runtime is **Evergreen and system-provided** (included in Windows 11; the host checks for it on
  older systems); it is not bundled by the app. [P]
  https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution
- Engine is Edge, a listed Meet browser: closest to a supported configuration, embedded behaviour [U].
- Google sign-in in an embedded WebView2: block reports exist [S], no primary source. Spike.
- No Linux story; a second codebase would be needed, contradicting ADR-0003.

### Installed Chrome/Edge PWA of Google Chat (zero code)

- Google documents a Chat standalone app (Chrome 73+; Windows, ChromeOS, macOS; Linux only in the
  uninstall section). **"Chrome … does need to be open to use the Chat standalone app."** "Launch at
  startup" is in `chrome://apps`. The page is silent on notifications, badges and Meet. [P]
  https://support.google.com/chat/answer/9455386
- Edge PWAs: notifications go to the OS notification centre under the PWA's name and icon; the Badging
  API puts a badge on the Windows taskbar icon. [P]
  https://learn.microsoft.com/microsoft-edge/progressive-web-apps/how-to/notifications-badges ,
  https://learn.microsoft.com/microsoft-edge/progressive-web-apps/whats-new/pwa
- Badging is installed-app only and "not Baseline"; Linux behaviour not established. [P] partial, [U]
  https://developer.mozilla.org/en-US/docs/Web/API/Badging_API
- Background behaviour with all windows closed: **only** a 3CX vendor thread (Chrome needs a window or
  background mode; Edge Startup Boost keeps delivering). [S], no primary source found.
  https://www.3cx.com/blog/docs/pwa-push-notifications/
- Real browser: sign-in and Meet are first-party. No tray, no quit-only-from-tray, no in-app
  mute/sound, no installer.

### Not evaluated

Neutralino (OS webview, no bundled Chromium; Linux gtk-webkit2 [P], notification and WebRTC support
not established, https://neutralino.js.org/docs/), Wails (OS webviews by design; v3 docs returned
403, not read), CEF, Qt WebEngine, NW.js. **Not evaluated; no evidence they beat Electron.** They
are not rejected on merit.

## Notification requirement (FR-05 second outcome) — consequences for Electron itself

The [S] findings above undercut ADR-0002 piece 2, which assumes that (a) Chat calls a page-level
`Notification`, so wrapping the constructor sees it, and (b) Chat's own click handler navigates to
the conversation. If Chat notifies via service-worker `showNotification`:
- the constructor wrapper may never see the notification (also a candidate cause of S1);
- there is no page-side click handler to lean on, and the payload carries no conversation identifier
  (only a sender-scoped tag). The service worker's own `notificationclick` handler may still focus
  and route to the conversation when the click is delivered to it [U]; if it does, deep linking
  depends on the shell delivering the click to the service worker rather than on the payload.
  Spike C must establish which of the two holds.

Getting the chat name and a correct deep link would then need a **second source**: the document
title / unread state via `page-title-updated`, or DOM scraping. This collides with the space rule
`wrapper-not-a-rewrite` (ADR-0002 Alternative 2 was rejected for exactly this reason). That is an
**owner decision**, not a tech-lead one: either accept a bounded scrape/title source for this one
purpose, or accept generic content and window-focus-only click. ADR-0002 Revision 3's documented
fallback (a main-process notification from `page-title-updated`) provides only generic text
("N new messages") and window focus, and it never identifies the conversation. Every alternative
shell has the same problem, and the Tauri notes report it as unsolved there too.

## Decision matrix

OK = meets the need per primary evidence. Risk = plausible, unproven or needs work. No = cannot.
API-level claims are marked OK only where a primary doc backs them; delivery claims are Risk.

| Criterion | Electron | Tauri v2 | .NET WebView2 host | Chat PWA | Neutralino / Wails / CEF / Qt / NW.js |
|---|---|---|---|---|---|
| Google sign-in | Risk: works today (ADR-0001); heuristics can tighten | Risk: author claims OK [S] | Risk: no primary source | OK: real browser | Not evaluated |
| Hidden-window notification, Windows | Risk: API OK [P]; live failure BUG-01; SW path [U] | Risk: WebView2 drops web notifications [S] | Risk: host can render; persistent path [U] | Risk: OS toast likely; needs browser running [S] | Not evaluated |
| Hidden-window notification, Linux | Risk: libnotify API [P]; never verified here | Risk: permission denied, page inert [S] | n/a | Risk: Linux support thin [U] | Not evaluated |
| Title shows chat name | Risk: depends on Chat's payload and SW path [U] | Risk: same payload | Risk: same payload | Risk: same payload | Not evaluated |
| Click opens that chat (FR-05) | No/Risk: no conversation id in payload [S]; needs owner-approved second source | No/Risk: reported unsolved [S] | Risk: `ReportClicked` exists [P], id still missing | Risk: likely native, via Chat's own service-worker `notificationclick` [U] | Not evaluated |
| Attention indicator | OK: `flashFrame`, overlay, tray swap [P] | OK: `requestUserAttention`, overlay [P] | OK: host code | Badge on Windows taskbar, not flash; no tray | Not evaluated |
| Meet: camera, mic, screen share | Risk: handlers + popup routing needed; Linux single PipeWire source [P]; behaviour [U] | Risk: WebRTC absent in Ubuntu's build [S]; other distros [U]; Windows [U] | Risk: Edge engine, events exist [P]; [U] | OK: supported browser | Not evaluated |
| Close-to-tray, quit only from tray | OK (implemented) | OK: tray API | OK: host code | No | Not evaluated |
| Start on login, sound, mute | OK (implemented) | OK: plugins | OK: host code | Partial: startup only | Not evaluated |
| Windows + Linux installers | OK, done | OK [P] | No Linux | n/a | Not evaluated |
| Maintenance | Low-Medium: existing code and tests, but Electron bumps track Chromium patch cadence | Medium: Rust, WebKitGTK per distro | Medium: C# app, Linux gap | Lowest, but a different product | Not evaluated |
| Migration cost | none | High: ~1,540 LOC main process, CI, 8 test files | High, Windows only | Discards the app | Not evaluated |
| Fixes S1 (no toast) | Only if cause is config or our bridge | Only if cause is Electron-specific; hidden-page risk in [S] | Only if cause is Electron-specific | Optional data point only: tells OS-level suppression from not-OS-level (its toast uses Edge's own identity) | Not evaluated |
| Fixes S2 (no flash) | Yes: unimplemented, one API call [P] | Same one-call gap [P] | Same | Badge, not flash | Not evaluated |

### Requirements not in the matrix

- **Engine-independent (host code in every candidate, so not a differentiator):** FR-02 window state,
  FR-08 single instance, FR-13 version line, FR-15 settings window. In a migration they are part of
  the rewrite cost; per-candidate support was not verified. [U]
- **FR-04 session persistence:** Electron partition (implemented); WebView2 user data folder [P];
  PWA browser profile; WebKitGTK not verified. [U]
- **NFR-02 idle CPU/memory:** a real Tauri/Neutralino advantage (no bundled Chromium); not measured
  here. [U] Electron's footprint is accepted per NFR-02's own wording.
- **NFR-04 security posture:** Electron's `contextIsolation`/`nodeIntegration:false` baseline is
  Electron-specific; Tauri has its own capability/permission model (the window API docs list
  per-command permissions). Not evaluated further. [U]

### Which symptoms each alternative would or would not fix

- **S2** is missing code, not an engine limit. No migration is needed; every host needs the same
  one-call addition.
- **S1** candidate causes, none confirmed: (1) Chat does not reach the page `Notification` (page
  visibility per ADR-0002 Rev 3, or the service-worker path above), the sound being Chat's own
  in-page audio: follows us to any host that hides the page, and Tauri's notes report worse
  behaviour; (2) Windows-side suppression or identity (Focus Assist, per-app settings, AUMID/shortcut
  mismatch; Tauri's docs describe the same installed-app dependency); (3) our own gating (mute,
  permissions). The owner's observation that toasts appeared after diagnostic activity points toward
  state-dependence, and is one more reason not to conclude an engine fault. Only a cause specific to
  Electron's Chromium integration would justify a move, and no evidence of one exists.

## Decision (proposed)

1. **No migration now. Retain Electron, and reopen the question if a trigger below fires.** Reasons:
   every requirement except Meet, the deep link and BUG-01 (hidden-window delivery, the FR-05
   core, which is a live failure) is implemented and tested on Electron; migration
   is a rewrite of ~1,540 lines plus CI to escape a bug whose plausible causes travel with us; no
   alternative has evidence of beating Electron, and the [S] evidence against Tauri, even
   discounted, gives no reason to prefer it. Retention is conditional on BUG-01 and the spikes.
2. **Chat PWA is not a candidate for the product** (fails FR-06/07/09/11/12/14/15). A PWA install is
   available to the owner as an **optional data point**: if a PWA toast appears with its window
   closed, OS-level suppression is less likely; if not, OS-level suppression is more likely. It does
   not separate Electron config from an Electron limitation, because a PWA toast uses Edge's own
   identity and path, not ours. It does not gate any work.
3. **Meet in-app is feasible in principle on Electron, subject to a spike.** Handler design,
   origin scoping and popup routing belong to the Meet FR and the tech design, not to this ADR. The
   space-rule change (Meet links as the single exception to "external links open in the system
   browser") has since been decided by the owner (2026-09-30, UI-01); see FR-16, NFR-07 and
   [meet-call-window.md](../architecture/meet-call-window.md).
4. **Escalation triggers** (replace ADR-0001's single Tauri trigger):
   - **T1, sign-in:** the block reproduces on the primary path and the cookie-import fallback both
     fail. Re-evaluate alternatives; Tauri's Meet-on-Linux status is then a spike question, not a
     known "no".
   - **T2, notification delivery:** BUG-01 is shown to be an Electron limitation. "Proven" means:
     a minimal reproduction on the affected machine, all three S1 causes above ruled out, **and**
     ADR-0002 Revision 3's fallback (main-process notification from `page-title-updated`, generic
     content only) tried and either failing or judged unacceptable by the owner. That fallback means
     "no supported workaround" is unlikely to hold for delivery itself; it may hold only for content
     and deep link quality. tech-lead declares it with `electron-developer`'s evidence; the owner
     ratifies.
   - **If a trigger fires and the alternative cannot deliver Meet on Linux** the options are the
     owner's: (a) Windows-only replacement shell with Electron kept for Linux; (b) drop in-app Meet
     on Linux (links open in the system browser); (c) drop Linux; (d) stay on Electron and accept
     the limitation.

## Spikes

Owner of the work: `electron-developer`, results reviewed by tech-lead. Time-box: **two working days
in total**; an unfinished spike is reported as such, not extended silently.

- **A, BUG-01 diagnosis** (already under way): the candidate causes above, including whether a
  service-worker notification reaches the OS from our window and why toasts appeared after
  diagnostic activity. Leads from the earlier investigation, **reproduced in harnesses but not
  confirmed against a real signed-in Chat**: `ServiceWorkerRegistration.showNotification()` shows no
  toast in Electron 44.4.3 on Windows; the bridge wraps only `window.Notification`; dev and packaged
  builds share one AUMID and the toast header reads "Electron"; a synthetic toast click produced `close`,
  not `click`. Spike A must therefore also use a **real** click on a real toast, and must say whether
  `flashFrame` has any visible effect on a window hidden to tray (the taskbar button may not exist).
- **B, Meet in Electron:** a real call with camera, mic and screen share on Windows and on Linux.
  Meet in a wrapper is an unsupported configuration, so this is **re-verified on every release**,
  as sign-in is under ADR-0001.
  - **If B shows Meet does not work in Electron:** that is an **owner decision**, not a trigger this
    ADR pre-decides. The candidate shells are unproven for Meet as well, so option (a) is not
    obviously better; realistic options are B1 Meet opens in the system browser (on Linux or
    everywhere), B2 the owner accepts a Windows-only in-app Meet, or B3 accept the limitation.
    tech-lead brings the spike evidence to the owner.
  - **Linux screen-share picker (owner default 4, now in the space rule):** on Linux only, the OS's own
    picker may replace the app's picker **if B shows it works**; the user always chooses explicitly and a
    silent or pre-selected source is never allowed on any platform. `useSystemPicker` is documented as
    experimental and macOS 15+ only, so it is not the mechanism; Electron documents that
    `desktopCapturer.getSources` "only returns a single source on Linux when using Pipewire". B must show, on
    a real Wayland/PipeWire desktop, that the OS dialog appears on every share start (no remembered choice
    skips it), cancel denies, the app shows no picker and pre-selects nothing, and the source Meet receives
    is the user's choice; and what an X11 session does (design position: app picker). Conditions in full:
    [meet-call-window.md](../architecture/meet-call-window.md) §5. If they fail, the app picker is used.
  - **Call-window arrangement:** B also checks that a `BrowserWindow` can host the app-owned child
    `WebContentsView` of [meet-call-window.md](../architecture/meet-call-window.md) §3a on Electron 44.4.3
    (the `BrowserWindow` docs page does not itself document `contentView`), and that closing the window
    releases camera, microphone and capture.
  - **Linux availability:** no Linux machine is known to be available for B. The two-day time-box
    **assumes one** (a VM or a spare machine with a desktop session and a camera or virtual camera).
    If none exists, the Linux half of B is reported as "not run", the Windows half proceeds, and
    Linux Meet stays [U]. The owner should say whether such a machine exists.
- **C, notification payload:** what Chat's notification carries (title, tag, data) and whether any
  conversation identifier is reachable without scraping. Feeds the owner's decision on a second
  source.

## Alternatives considered

Tauri, a .NET WebView2 host and the PWA were evaluated (see the matrix) and are not chosen now:
high migration cost, no evidence of gain, unresolved Linux and notification risks. Neutralino,
Wails, CEF, Qt WebEngine and NW.js were **not evaluated**; no evidence they beat Electron.

## Consequences

### Positive
- No rewrite; the implemented requirements and test net stay.
- BUG-01 is diagnosed on its merits instead of being masked by a platform change.
- The notification-deep-link problem is surfaced as an explicit owner decision.

### Negative
- Electron ships its own Chromium: larger installers and a patch cadence to follow.
- Meet in a wrapper is unsupported by Google and can break on UA/embedding changes; verified per
  release.
- The deep-link requirement may be unattainable without a second source that touches
  `wrapper-not-a-rewrite`.
- Linux screen share is limited to one PipeWire source.

### Risks
- Retention is conditional: if T1 or T2 fires, this ADR is superseded by a new one.
- Every [U] and [S] item is a lead, not a fact; the spikes above are the way to close them.

## Sources

Primary: electronjs.org (notifications, browser-window, session, desktop-capturer), v2.tauri.app
(webview-versions, plugin/notification, window API, distribute), learn.microsoft.com (WebView2
overview-features-apis, icorewebview2_27, user-data-folder, distribution; Edge PWA notifications-
badges, whats-new), support.google.com (Meet 7317473, Chat 9455386),
developers.google.com/identity/protocols/oauth2/policies, developer.mozilla.org Badging API,
neutralino.js.org/docs. Secondary: github.com/ankurk91/google-chat-tauri (README, docs/Notes.md),
github.com/tauri-apps/tauri/discussions/8426, 3cx.com PWA push notes. Fetched 2026-09-30. Not read:
Wails v3 docs (403), a Chrome-authored PWA background-mode page (404), Badging support table for
Linux.
