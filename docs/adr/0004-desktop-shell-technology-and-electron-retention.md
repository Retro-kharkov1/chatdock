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
  [FR-16 and NFR-07](../business/requirements.md) (owner-approved 2026-09-30; the *Electron security baseline*
  project rule carries the matching single exception, see [Project Rules](../architecture/project-rules.md)). Design:
  [meet-call-window.md](../architecture/meet-call-window.md).
- **Notification content and deep link**: the notification shows the chat name, and clicking it opens
  that chat. Now FR-05b and FR-05c step 2 (conditional on Spike C and an owner decision); FR-05a (a toast
  appears at all) is unconditional. Analysed here because the evidence below undercuts ADR-0002's design
  for it. Design candidates: [notifications.md](../architecture/notifications.md).

Standing requirements: [requirements.md](../business/requirements.md) FR-01..FR-16, NFR-01..NFR-08;
Windows + Linux installers (ADR-0003); the *Wrapper, not a rewrite* project rule ([Project Rules](../architecture/project-rules.md)).

### Facts about the current code (as decided: the state BEFORE the BUG-01 fix, kept as the input to this decision)

These describe the code when this ADR was written (2026-09-30). The BUG-01 fix has since changed several of
them; see "Progress since this ADR was written" below and the architecture docs for what the code does now.

- The only permission handler granted `notifications` and denied every other permission, with no
  `setPermissionCheckHandler`. Camera and mic were refused.
- No `setDisplayMediaRequestHandler` in `src/main`; per Electron docs `getDisplayMedia` needs one (still true).
- Every `window.open` went to `shell.openExternal` (still true; the Meet routing is design only).
- No `flashFrame` call existed; the only attention signals were the FR-14 tray-image swap and the Windows
  overlay icon. S2 was at least partly an unimplemented feature, not proof of an Electron limit.
- The notification bridge wrapped `window.Notification` (ADR-0002 piece 2) only.

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
title / unread state via `page-title-updated`, or DOM scraping. This collides with the *Wrapper, not a rewrite*
project rule (see [Project Rules](../architecture/project-rules.md); ADR-0002 Alternative 2 was rejected for exactly this reason). That is an
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
   project-rule change (Meet links as the single exception to "external links open in the system
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
  - **Linux screen-share picker (owner default 4, now in the *Electron security baseline* project rule):** on Linux only, the OS's own
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

### Progress since this ADR was written (status stays Proposed)

- **Spike A (BUG-01), Windows: substantially answered by the implementer** (Electron 44.4.3, Windows 11,
  verified by reading the OS toast store; harness only, **not confirmed against a real signed-in Chat**):
  the page `new Notification()` produces a real toast; `ServiceWorkerRegistration.showNotification()`, from
  the page or from Chat's own service worker, produces **none**. The cause is therefore in the
  service-worker notification path, not in OS suppression or app identity alone. Dev and packaged builds
  shared one AUMID; that is fixed.
- **Mechanism M2 is feasible on 44.4.3 and implemented:** a service-worker preload
  (`session.registerPreloadScript({ type: 'service-worker' })`) patches the worker's `showNotification`
  through `contextBridge.executeInMainWorld`, forwards it over `ServiceWorkerMain.ipc` (validated by the
  worker's scope origin, chat only), and the main process re-raises it as an Electron `Notification`. The
  page-side call is forwarded the same way, and an unread-count fallback (M3) covers the unmatched case. So
  **trigger T2 has not fired**: BUG-01 was not an Electron limitation, and the ADR-0002 fallback was not
  needed as the only route. Electron is retained.
- **Trade-off accepted for now:** the original `showNotification` is not called, so Chat's worker
  `notificationclick` handler and `getNotifications()` never fire; a toast click only brings the window
  forward (FR-05c step 1).
- **Still open:** Spike C on a real Chat (what the payload carries; whether the chat name is in the title;
  whether the `tag` names a sender or a conversation; what `(N)` counts), so FR-05b and FR-05c step 2 remain
  the owner's decision; a real click on a real toast on real Chat; Spike B (Meet): Windows and WSLg-Linux harness parts done,
  owner part and the native-Linux portal/camera checks open (see "Spike B result" below); Linux delivery never verified.
  Details: [notifications.md](../architecture/notifications.md).

### Spike B result (Windows 11, Electron 44.4.3 / Chromium 152.0.7977.130; 2026-10-01; living section)

**Scope of evidence.** Throwaway harness [spike/meet/](../../spike/meet/README.md) (not product code), mirroring
the call-window config: `persist:google-chat` imported from `session.js`, the app's desktop UA,
`contextIsolation` on, `nodeIntegration` off, `sandbox` on, no preload, media granted only to
`https://meet.google.com` (request and check), explicit picker only. The table below is the **Windows** run. The
Linux half was first skipped on the mistaken belief that no Linux host existed; the Linux target is **WSL2 with WSLg
on the owner's workstation** (owner decision 2026-09-30), and it was run on 2026-10-02: see "Spike B, Linux half
(WSLg)" below. Nothing below was observed in a real signed-in Meet call; that part needs the owner
(checklist in the harness README, about 5 minutes). "Stand-in page" means a local page served under the real
`https://meet.google.com` origin, not Meet itself.

| # | Question | Result | Evidence | Status |
|---|---|---|---|---|
| 1 | Meet loads, takes the session or sign-in? | `meet.google.com/new` in a fresh harness profile redirected to `accounts.google.com/v3/signin/identifier`, and the Google sign-in identifier page rendered normally (no "browser not secure" page) with the app UA. Whether the password / 2-step steps complete, and whether the existing product session is accepted, is not known. | `out/real-meet.png`, `auto-results.json` `realMeet` | Page load observed; **sign-in and existing session need owner** |
| 2 | Start/join, camera and mic? | From origin `https://meet.google.com`: `getUserMedia({audio,video})` succeeded with real devices (mic "Default - Microphone (HSW249B)", camera "motorola edge 50 neo (Windows Virtual Camera)"), tracks `live`; Windows ConsentStore showed webcam and mic `inUse`. The same call from `accounts.google.com` is denied (`NotAllowedError`). Starting or joining an actual meeting was not done. | `probeMeet`, `devicesWhileCaptured`, `probeAccounts` | getUserMedia **observed**; real call **needs owner** |
| 3 | Screen share via explicit picker? | Works **only from a non-elevated process**. Picker shown on each of 3 share starts; choosing screen gave a live track (`displaySurface: monitor`), choosing a window a live track (`window`); Cancel rejects with `AbortError: Invalid capture constraints`. From an **elevated** (Administrator) process both fail with `NotReadableError: Could not start video source` and Chromium logs `CreateForMonitor/CreateForWindow failed hr 0x80070005` (cause = elevation is the only difference tried, not proven). The picker click was simulated by the test driver, so what a person sees is for the owner to confirm. | `display_screen`, `display_window`, `displayCancelled`, runs elevated vs. `explorer.exe`-launched | **Observed** (driver-clicked picker); visual check needs owner |
| 4 | Camera/mic released on destroy? | After `win.destroy()` of a window holding live camera and mic tracks, ConsentStore `LastUsedTimeStop` was set within 1 s for both (every run in which it was checked). Only `destroy()` was measured, not the X button; the LED was not seen. | `release`, `devices+3s/+10s` log lines | **Observed** (OS-level); LED/X-button path needs owner |
| 5 | beforeunload / `will-prevent-unload` | Stand-in page with an unconditional `beforeunload` handler: with **no** `will-prevent-unload` listener, `win.close()`, `contents.close({waitForBeforeUnload:true})`, a page `location.reload()` and `app.quit()` are all **silently blocked** (no dialog, no event; for `app.quit()` `before-quit` fires, `will-quit` never does, window and process stay). A listener that does not call `preventDefault()` behaves the same. A listener calling `preventDefault()` lets close (65 ms), reload and quit proceed. The window-close block also occurred with `navigator.userActivation.hasBeenActive === false`. So design invariant I4's "may be a silent block" is **true on this Electron**: an unregistered listener means a Meet objection cancels close and quit with no UI, which supports the always-registered handler and the `isQuitting` reset in the design. Whether real Meet registers `beforeunload` during a call was not observed. | `unload[]`, `quit` in `auto-results.json` | Mechanics **observed on stand-in**; real Meet **needs owner** (README steps 4, 5) |
| 6 | Permission names delivered | `getUserMedia`: request handler gets `media` with `details.mediaTypes` `["audio","video"]`; check handler gets `media` with `details.mediaType` `video`/`audio` (or none), and `speaker-selection` (no mediaType). `getDisplayMedia`: request handler gets `media` with **empty** `mediaTypes`, then the display-media handler is called; **`display-capture` was delivered to neither handler** in this run. Origins arrive with a trailing slash (`requestingOrigin`, `securityOrigin`, `request.securityOrigin` are `https://meet.google.com/`); `requestingUrl` is the full URL. | `permissionLog` | **Observed** |

**Consequences for the design (for tech-lead).**
- The permission allowlist cannot rely on the name `display-capture`; the screen-share gate is the display-media
  handler plus an origin test, and `media` with empty `mediaTypes` must be allowed for that origin or the flow is
  untested without it. Normalise origins (`new URL(x).origin`); a literal compare with `https://meet.google.com` fails
  on the trailing slash (the harness hit exactly this).
- `setDisplayMediaRequestHandler` also fired with `userGesture: false`; the product handler should deny a request with no
  user gesture (a suggestion, not tested against Meet).
- `speaker-selection` is checked by Meet's device code and is denied by this config; whether Meet needs it
  (output-device choice) is unknown, owner run will show it in the log.
- `desktopCapturer.getSources` took 3.3 to 8.2 s here with 10 to 15 sources and WGC "not capturable" noise for
  some windows; the picker needs a loading state and must not block the close path.
- Never run the product elevated if Meet screen share matters; worth a line in the release notes.
- Observed oddity, cause unknown: after a completed `app.quit()` in the harness (screen share used earlier in the same
  process) the main process stayed alive and even `process.exit(0)` scheduled from `will-quit` did not end it. Not
  investigated; the implementer's quit-with-call test (meet-call-window.md section 3b) should check it.

### Spike B, Linux half (WSL2 + WSLg, Ubuntu 24.04, Electron 44.4.3 / Chromium 152.0.7977.130; 2026-10-02)

**WSLg is not a native Linux desktop.** It is a Weston (Wayland) compositor plus Xwayland projected to Windows over
RDP, with no GPU/DRM render node, no camera, no GNOME/KDE shell. Findings about the OS screen-share portal, camera,
tray, notifications and window-manager behaviour do **not** transfer to a real desktop; findings about Electron/
Chromium logic (permission names, `will-prevent-unload`, release of audio capture, UA) very likely do.
Environment: `wsl -l -v` showed `Ubuntu-24.04` (WSL2); WSLg 1.0.73.2; `DISPLAY=:0` and `wayland-0` both present,
`XDG_SESSION_TYPE` empty; PulseAudio at `/mnt/wslg/PulseServer` (`RDPSource`, `RDPSink`); `/dev/video*` absent. Same
harness, run non-interactively (`--mode=auto`, picker clicks simulated by the driver) once with
`--ozone-platform=x11` and once with `--ozone-platform=wayland`. Setup and limits:
[verify-on-linux-wslg.md](../development/verify-on-linux-wslg.md). Real signed-in Meet was **not** driven (owner).

| # | Question | Linux (WSLg) result | Evidence | Status |
|---|---|---|---|---|
| 1 | Meet loads with the app UA | `meet.google.com/new` redirected to `accounts.google.com/v3/signin/identifier`, page rendered ("Sign in", no "browser not secure" page) on x11 and wayland. UA `Mozilla/5.0 (X11; Linux x86_64) ... Chrome/152.0.7977.130 Safari/537.36`. Whether sign-in completes: not known. | `realMeet`, `probeMeet.ua` | Page load **observed**; sign-in **needs owner** |
| 2 | `getUserMedia` | **No camera in WSLg**: `getUserMedia({audio,video})` rejects `NotFoundError: Requested device not found` (no `/dev/video*`; `enumerateDevices` lists only audioinput/audiooutput). **Audio only works** from the meet origin (track label "Default", `live`); the same call from `accounts.google.com` is `NotAllowedError`, as on Windows. Camera on Linux is **not tested**. | `probeMeet`, `probeAccounts` | Mic **observed**; camera **untestable here** |
| 3a | `getDisplayMedia` via the app picker, X11 | Works: `getSources` 30 ms returned 2 screens + windows; picker shown on every start; screen gave a live `monitor` track, window a live `window` track; Cancel rejects `AbortError: Invalid capture constraints` (identical to Windows). | `display_screen/_window`, `displayCancelled`, `sourceKinds` | **Observed** (driver-clicked) |
| 3b | `getDisplayMedia` via the app picker, Wayland | Works for screens only: `getSources` took ~3.0 s and returned `screen` x2, **no windows**; screen gave a live `monitor` track; the window option did not exist. Cancel as above. | `sourceKinds`, `getSourcesMs`, `sourceKindAvailable_window: false` | **Observed**; no window share under Wayland in WSLg |
| 3c | OS picker (xdg-desktop-portal ScreenCast) | **Not testable in WSLg.** `xdg-desktop-portal` + `-gtk` run but expose no ScreenCast interface; installing `xdg-desktop-portal-wlr` failed with "Compositor doesn't support zwlr_screencopy_manager_v1" (Weston lacks it), then removed again. Electron's `useSystemPicker` is documented macOS-only (<https://www.electronjs.org/docs/latest/api/session>), so on Linux the portal path would be Chromium's PipeWire capturer behind `getSources` under Ozone Wayland, which this environment cannot exercise. Whether the portal lets the user choose explicitly, and whether nothing is pre-selected, is **unknown**. | `wlr.log`, `gdbus introspect` (no ScreenCast), `session` doc | **Unverified: needs a native GNOME/KDE host** |
| 4 | Release on destroy | `win.destroy()` of a window holding a live mic track: PulseAudio `source-outputs` went 1 -> 0 within 1 s (x11 and wayland), stayed 0 for 12 s. Camera: none exists. LED/X-button path not seen. | `release` (`pactl list short source-outputs`) | Mic **observed**; camera **untestable** |
| 5 | beforeunload / `will-prevent-unload` | **Same as Windows.** Without a listener (or with a log-only one) `win.close()`, `contents.close({waitForBeforeUnload})`, page `location.reload()` and `app.quit()` are silently blocked (`before-quit` only, window stays); a listener calling `preventDefault()` lets close (about 50 ms), reload and quit proceed (`will-quit` reached). Also blocked with no user activation. Identical on x11 and wayland. Windows' odd "process survives after quit" did **not** reproduce: the harness process exited (exit 0). | `unload[]`, `quit` | **Observed** on stand-in page; real Meet needs owner |
| 6 | Permission names delivered | Same as Windows: `getUserMedia` request gets `media` with `mediaTypes` (`["audio"]` seen; `["audio","video"]` was not seen because the combined call has no camera to ask for); check handler gets `media` with `mediaType` `video`/`audio`, plus `speaker-selection`; `getDisplayMedia` request gets `media` with **empty** `mediaTypes`, then the display-media handler; **`display-capture` was not delivered**. Origins with trailing slash. | `permissionLog` | **Observed** |

**What this changes.**
- The Linux app picker works on X11 and (screens only) on Wayland-in-WSLg, so the app picker stays the Linux default,
  as [FR-16](../business/requirements.md) now specifies (the Linux OS-picker option was removed from scope on
  2026-10-02). **The condition for allowing the OS picker on Linux
  ("it works and the user still chooses explicitly") was NOT met or refuted: it could not be tested.** Do not enable
  it until checked on native GNOME (Wayland) and KDE with PipeWire.
- Wayland window sharing and the ~3 s `getSources` latency in WSLg may be WSLg artefacts or real Ozone-Wayland
  behaviour; unknown. The picker still needs the loading state noted above.
- Permission handling and the unload/quit design (always-registered `will-prevent-unload`, `isQuitting` reset) apply
  on Linux unchanged.
- The harness gained Linux device probes (`pactl`, `/dev/video*`), an audio-only `getUserMedia` probe and tolerance
  for a missing window source kind; Windows behaviour is unchanged.

**Not run:** Linux on a native desktop (portal picker, camera, X-button/LED path, tray, notifications); the `BrowserWindow` + child `WebContentsView` arrangement and `will-prevent-unload` on a
`WebContentsView` (the harness uses `win.webContents` only); real signed-in sign-in, join, share and X-button close.
Re-verify on every Electron or Meet change, as for sign-in.

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
  the *Wrapper, not a rewrite* project rule.
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
