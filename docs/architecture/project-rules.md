# Project Rules

<overview>
Seven standing rules that the other documents cite by name (rendered as *Italic Name* project rule). They
are decisions of the maintainer, stated here so each document can point at one place. Where a design
document and a rule differ, the rule wins.
</overview>

<rules>
## Wrapper, not a rewrite

The app loads Google Chat as it is and adds only what a browser tab cannot do (tray, native
notifications, window state). It does not scrape the page, inject UI or script into Chat or Meet, or
re-implement Chat features. The only added page surface is the preload's narrow, write-only signals
(see [IPC Contract](ipc-contract.md); the smart-copy selection check is the one decided read, see the
security baseline). Anything that would read or drive the page is a separate,
explicit maintainer decision.

## Electron security baseline

Chat, Meet and the Google app pages opened from links are untrusted third-party content.

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`; no
  `<webview>` tag.
- The preload exposes only a small named function surface through `contextBridge`; never
  `ipcRenderer` itself.
- Popups and navigation are checked against an allow-list (widened for the duration of a sign-in only, see the fourth
  exception below); external links open in the system browser
  and only for the `http`, `https` and `mailto` schemes.
- First exception: a Google Meet link whose origin is exactly `https://meet.google.com` (no other
  port, no userinfo, no lookalike host) opens in the app-owned call window. That window denies its own
  popups, and its permissions are scoped to Meet.
- Second exception (maintainer decision 2026-10-04, UI-04): an `https` link whose hostname is exactly one on the
  fixed Google-app allow-list in [Google App Windows](google-app-windows.md) section 2 (no port, no
  userinfo, no suffix or wildcard matching; `www.google.com/url?q=` unwrapped once) opens in an app-owned
  window that shares the signed-in session, so the user does not sign in again; a Chat conversation link
  (exact origin `https://chat.google.com`, conversation path shape) opened from a Google app window loads in the
  main window, a Chat attachment/download link from the main window goes to the save dialog, and every other
  Chat-origin address goes to the system browser. These windows are created with `contextIsolation`,
  `sandbox`, no `nodeIntegration`, no `webviewTag` and **no preload**, and have no bridge. Their navigation and
  popups are checked against the same exact-host list plus `accounts.google.com` (in-window use only);
  anything else goes to the system browser by the scheme rule above. `drive.usercontent.google.com` is never a
  link, popup or direct-navigation target: it is followed only as a server-redirect hop from a Drive/Docs page
  (the Download endpoint, path exactly `/download`). `forms.gle` is followed only if its redirect lands on a
  listed host. Permissions are not widened beyond `clipboard-sanitized-write` and `fullscreen`, granted only when
  both the requesting and the top-level origin are `docs.google.com` or `drive.google.com`. Downloads (app windows
  and the main window) always show a save dialog and are never opened automatically; an app-window download is
  checked on its final URL and every redirect step (against the nav list, the Download endpoint and the
  initially empty **download-chain hosts** list), and a refusal is shown to the user. `*.googleusercontent.com`
  is never a navigation target. Extending any list needs evidence and a maintainer decision.
- Third addition (maintainer decision 2026-10-04, UI-05): the **main Chat window's existing preload** may carry **one**
  narrow, one-way channel for smart copy (`smartcopy:signal`, see [IPC Contract](ipc-contract.md) and
  [Smart Copy](smart-copy.md)). The preload listens internally (nothing new exposed through `contextBridge`), reads the
  selection only far enough to decide "non-empty and not inside an editable field", and sends a payload-free signal
  that main validates (sender, main frame, exact chat origin, exact shape, rate limit) before acting. It sends no
  page text and never logs any. This is the narrow exception to *Wrapper, not a rewrite* for reading the page; it is
  not a licence for further page reads: **a link-address payload on this channel is not authorised** (it needs maintainer
  approval and a change to this rule). Google app windows and the Meet call window still get **no preload**; Google app
  windows therefore get no copy-on-select (right-click link copy only).
- Fourth exception (sign-in mode, FR-19, see [Sign-in Flow](sign-in-flow.md); **design, not shipped**): **only while a
  sign-in is in progress**, the main window's navigation allow-list is widened to any acceptable `https` origin, so a
  single-sign-on or second-step page of the user's identity provider can load in the window and the sign-in does not
  die in the system browser. The mode starts when the main frame commits on exactly `https://accounts.google.com`, or
  commits on an acceptable origin after a navigation chain that passed through it (a returning user redirected straight
  to the provider), and ends when it commits on the Chat origin, after 10 minutes without a main-frame commit, after 30
  minutes in total, after 40 cross-origin main-frame commits, or when the user chooses "Back to Chat" (tray entry, or
  the button of the one-per-sign-in notice shown when a redirect is cancelled); each of these **four aborts** returns
  the window to the Chat start URL, overriding the page's `beforeunload`. A destroyed window or a quit only clears
  the timers. Accepted only: `https`,
  no userinfo, no non-default port, no IP literal (including obfuscated forms), no `localhost`, `*.localhost`, `*.local`
  or trailing-dot host, no host with an `xn--` (internationalised) label; single-label intranet hosts are accepted
  (risk: a hostile redirect can reach a page on the user's own network, bounded by TLS validation, inert pages and the
  limits). Never loaded in the main window during the mode, keeping their normal routing: `meet.google.com`, every
  Google application host in `googleLink.js`, `forms.gle`, `drive.usercontent.google.com` and
  `*.googleusercontent.com`. The window's native title shows the registrable domain first, then the full host, while
  the mode is on. The widening is
  **navigation only**: permissions stay on their exact chat-only lists; every main-window download is cancelled (with
  a sign-in-worded blocked notice that offers no "Open in browser") during the mode; the main window's preload (and the service-worker preload) exposes **no bridge
  and installs no listener on any origin other than the Chat origin** (it checks `location.origin` against a hard-coded
  constant), the notification-bridge injection, the unread-title listener and the load-time unread seeding run only on
  the Chat origin, and every app IPC channel accepts only a Chat-origin sender (the sign-in origin is no longer accepted
  on `notification:clicked`). *The origin gates (see [IPC Contract](ipc-contract.md) "Origin gating"), the mode itself, the download rule, the
  title and the tray entry all ship.* Popups stay denied and go to the system browser. No new window, `webPreferences` or drawn
  surface is created (the only additions are a native window title, one conditional tray entry and one native notice per sign-in), and nothing is
  logged beyond the URL scheme. This exception does not extend the allow-list for any other window, and a longer-lived
  or per-organisation allow-list needs evidence and a maintainer decision.
- Screen sharing: the user always chooses the source explicitly; nothing is pre-selected. The
  application's own picker is used on Windows and Linux; the Linux OS picker is out of scope.
- Never log, persist elsewhere or transmit cookies, tokens, credentials, message text, or sender and
  chat names.

## Hidden window must stay live

Closing the window hides it; the page keeps running at normal speed so messages still arrive and
notifications still fire. Background throttling must not delay or drop them. This is verified by
hiding the window and receiving a real message, not by reasoning.

## Quit only from the tray

The close (X) button hides the window and never quits. Only the tray's Exit entry (and OS shutdown)
terminates the process. There is no in-page Exit control.

## Verify on a real desktop

Anything that depends on the OS (notifications, tray, autostart, installers) is verified on a real
desktop session, not only by unit tests or reasoning. Reports state which platforms were actually
checked.

## Installers are part of done

A release is not done until the installers have been built and run. Release notes state plainly that
the artifacts are unsigned and what the user will see (Windows SmartScreen warning), see
[Packaging & Release](packaging-release.md).

## Design scaled to the wrapper

Almost all of the UI is the wrapped site's own. Design work (wireframes, mockups) is done only for
surfaces the shell itself must draw, such as the Settings window, the screen-share source picker,
the Help window (a local, script-free page with no preload) and the copy hint.
Native dialogs and tray entries get a wording spec, not mockups. The application draws no further
surfaces (views, strips, banners, panels) beyond what a requirement explicitly calls for.
</rules>
