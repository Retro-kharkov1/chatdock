# Requirements — Google Chat Desktop Wrapper

## Purpose

A personal-use Electron desktop application that wraps the existing Google Chat web app
(`https://chat.google.com/app/chat/SPACE_ID`) so it behaves like a native desktop chat client:
stays logged in, delivers OS-level notifications for new messages even when the window is
closed/hidden, and lives in the system tray instead of quitting on close.

This is a **single-user personal utility**. It is scoped, specified, and will be tested
accordingly — not as a multi-user or distributable product, even though installers for two
platforms are produced.

**Target platforms: Windows and Linux only.** macOS was dropped from scope by explicit owner
decision — see [ADR-0003](../adr/0003-packaging-and-code-signing-approach.md): macOS notifications
require a code-signed app (confirmed against `electronjs.org/docs/latest/api/notification`), the
owner does not use macOS, and paying for an Apple Developer Program membership (US $99/year) to
make a platform work that nobody will run was not justified.

## Scope

**In scope:**
- Electron shell that loads the Google Chat web app in a native window.
- Google account authentication that persists across restarts/reboots (no repeated login).
- OS-native notifications for new Google Chat messages, delivered even when the window is
  closed to tray, landing on the specific conversation/message when clicked (see FR-05).
- Close-to-tray behavior; tray icon with a context menu; explicit Quit/Exit action.
- Single-instance enforcement (a second launch focuses the existing instance instead of opening
  a second window).
- Window size/position/state persistence across restarts.
- Installers for Windows and Linux.
- Start automatically at OS login (FR-10).
- Notification sound control, independent of the page's own settings (FR-11).
- Manual notification mute ("quiet hours") via the tray menu (FR-12).

**Out of scope:**
- Any reimplementation of chat functionality (message list, composer, search, threads, etc.) —
  all of that is rendered by the existing Google Chat web app inside the wrapper.
- Direct integration with the Google Chat REST/RPC API, Google Workspace Events API, or any
  Google API client — the wrapper drives the existing web UI; it does not talk to Google's APIs
  directly. (Revisit only if the DOM/web-notification-bridge approach in FR-05 proves unable to
  detect new messages reliably — see FR-05's mechanism note and ADR-0002's fallback.)
- Multi-account support, multi-window/tabs, or switching between different Chat spaces/URLs
  beyond the one configured entry URL.
- Auto-update infrastructure (not requested; can be added later as a separate requirement).
- Mobile builds.
- Accessibility/localization work beyond what Chromium/the Google Chat web app already provides.
- Automated code signing/notarization pipeline setup — see NFR-05 for what distribution actually
  looks like given the constraints established below.

## Functional Requirements

### FR-01 — Launch and initial window
The application launches a single native window that loads
`https://chat.google.com/app/chat/SPACE_ID` as its start URL. The window is resizable, has a
sensible default size on first launch (e.g. 1200×800), and is not a fixed/fullscreen-only window.

```gherkin
Feature: Application launch
  Scenario: First launch with no prior state
    Given the application has never been run on this machine
    When the user starts the application
    Then a single window opens
    And the window loads https://chat.google.com/app/chat/SPACE_ID
    And the window is resizable
```

### FR-02 — Window state persistence
The window's size, position, and maximized/normal state are persisted to local application
storage and restored on the next launch. If the persisted position falls outside all currently
connected displays (e.g. a monitor was disconnected), the window falls back to the default size
centered on the primary display rather than opening off-screen.

```gherkin
Feature: Window state persistence
  Scenario: Restore previous window geometry
    Given the user resized and moved the window in a previous session
    And then closed the application via Quit
    When the user relaunches the application
    Then the window opens at the same size and position as when it was last closed

  Scenario: Persisted position is now off-screen
    Given the persisted window position is outside all currently connected displays
    When the user relaunches the application
    Then the window opens at the default size, centered on the primary display
```

### FR-03 — Google account authentication
The user can sign in to their Google account through the normal Google sign-in flow rendered
inside the application window. See the **Risks & Open Questions** section: whether this flow
completes without modification is a verified, documented risk, not an assumption.

```gherkin
Feature: Google sign-in
  Scenario: First-time sign-in
    Given the application is freshly installed and not yet signed in
    When the user completes the Google sign-in flow (credentials, and 2FA if enabled) inside the
      application window
    Then the Google Chat web app loads the user's conversations
    And no separate external browser window was required to complete the sign-in
```

### FR-04 — Session persistence across restarts and reboots
Once signed in, the user is not asked to sign in again on subsequent application launches,
including after a full machine reboot, unless the Google session itself has been explicitly
revoked (e.g. the user signed out of that Google account from another device/security settings)
or expired server-side.

```gherkin
Feature: Session persistence
  Scenario: Restart the application after signing in
    Given the user has successfully signed in
    When the user quits the application (via the tray Exit action) and relaunches it
    Then the application shows the signed-in Chat view directly
    And no sign-in prompt is shown

  Scenario: Reboot the machine after signing in
    Given the user has successfully signed in
    When the machine is rebooted and the application is launched again
    Then the application shows the signed-in Chat view directly
    And no sign-in prompt is shown

  Scenario: Session was revoked server-side
    Given the user's Google session was revoked from another device
    When the application is launched
    Then the application shows the Google sign-in flow again
    (this is expected/correct behavior, not a defect)
```

### FR-05 — System notifications for new messages, landing on the specific conversation when clicked
When a new Google Chat message arrives for the signed-in user, the application delivers an
OS-native notification (Windows Action Center / Linux notify-send-compatible), regardless of
whether the application window is currently visible, minimized, or hidden to the tray.
Notifications are **not** delivered while the window is open and focused on the relevant
conversation (matching normal chat-app behavior — no notification for a conversation the user is
actively looking at). Notifications are suppressed entirely while the app's mute setting (FR-12)
is on, and are delivered silently (no sound) while the app's sound setting (FR-11) is off.

The notification shows the sender's name and a message preview, consistent with what the Google
Chat web app itself would show via the browser Notifications API.

**Clicking a notification does two things, both required** — this is a sharpened requirement (the
owner's own words: "on clicking, jump into the chat *to that message*"), not satisfied by focusing
the window alone:
1. The application window is brought to focus (restored from the tray if hidden).
2. The application is showing the **specific conversation the notification was for**, with that
   message visible — not whatever conversation happened to be open before the window was hidden.

If the specific conversation cannot be determined (a named, logged, degraded case — see
[notifications.md](../architecture/notifications.md)), the window still comes to focus, but this is
an explicitly degraded outcome, not the target behavior, and must be visibly logged so it is never
mistaken for the feature working correctly.

While the window is hidden/minimized and there are unread messages, the tray icon shows a visible
unread indicator (e.g. a badge overlay); the indicator clears once the user has viewed the
relevant conversation(s).

```gherkin
Feature: System notifications
  Scenario: New message while window is hidden to tray
    Given the application is running with the window hidden to tray
    And the user is signed in
    When a new Google Chat message arrives for the signed-in user
    Then an OS-native notification is shown with the sender's name and a message preview
    And the tray icon shows an unread indicator

  Scenario: New message while window is open but unfocused on another app
    Given the application window is open but another application has OS focus
    When a new Google Chat message arrives
    Then an OS-native notification is shown

  Scenario: New message while the user is actively viewing that conversation
    Given the application window is open, focused, and showing the conversation the message
      belongs to
    When a new message arrives in that conversation
    Then no OS-native notification is shown for that message

  Scenario: Clicking a notification lands on the specific message, not just any window focus
    Given the window is hidden to tray
    And a new message arrives in conversation "B" while conversation "A" was the last one open
    And an OS-native notification is shown for that message in conversation "B"
    When the user clicks the notification
    Then the application window is restored/focused
    And the application is showing conversation "B" specifically, not conversation "A"
    And the message that triggered the notification is visible in that conversation
    And the tray unread indicator is cleared for conversation "B"

  Scenario: Notifications suppressed while muted (FR-12)
    Given the user has enabled "Mute notifications" from the tray menu
    When a new Google Chat message arrives while the window is hidden
    Then no OS-native notification is shown
    And the tray unread indicator still updates (mute silences notifications, not the unread count)

  Scenario: Notification sound off (FR-11)
    Given the user has turned off "Notification sound" from the tray menu
    And "Mute notifications" is not enabled
    When a new Google Chat message arrives while the window is hidden
    Then an OS-native notification is still shown
    And it is delivered without sound
```

**Resolved (was an open question), and corrected after real-machine testing:** the web version of
Google Chat already requests browser Notification permission and calls the standard Web
Notifications API when the tab is backgrounded; Electron bridges `Notification()` calls from a
background/hidden `BrowserWindow` to the OS notification center, provided the renderer stays alive
**and Google Chat's own `document.visibilityState` check reports the window as actually hidden**.
That second condition was missed in the original design: an earlier revision of this mechanism set
`backgroundThrottling: false` believing it was required to keep the hidden page's JS running, but
that flag has the side effect of pinning `visibilityState` at `"visible"` — which made Google Chat
believe the window was always visible and suppress every notification while hidden. This was caught
in the owner's real test (a colleague's message produced no notification) and traced by
`electron-developer`; see [ADR-0002](../adr/0002-notification-delivery-mechanism.md) Revision 3 for
the full incident and root cause. **Corrected mechanism**: `backgroundThrottling` is left at
Electron's default — this project's pinned Electron version (44.4.3) was empirically confirmed to
keep a hidden page's JS/timers running at normal speed without that flag, so no override is needed,
and the page reports its visibility honestly. See [notifications.md](../architecture/notifications.md)
for the full mechanism and its Page Visibility dependency, and [ADR-0002](../adr/0002-notification-delivery-mechanism.md)
for the historical Electron issue `#31016` this design originally (and, it turned out,
unnecessarily) guarded against, now kept only as a documented, currently-inactive fallback. Also see
that doc for the click-to-conversation mechanism and its own named fallback if Google Chat's page
turns out not to wire click-to-navigate on its own `Notification` objects.

### FR-06 — Close-to-tray
Clicking the window's close (X) button hides the window (does not destroy the application
process, does not quit). The application keeps running in the background and continues to
receive and surface notifications per FR-05 while hidden.

```gherkin
Feature: Close-to-tray
  Scenario: Click the window close button
    Given the application window is open
    When the user clicks the window's close (X) button
    Then the window is hidden
    And the application process keeps running
    And the tray icon remains visible

  Scenario: Notifications continue after close-to-tray
    Given the window was closed via the X button (hidden to tray)
    When a new Google Chat message arrives
    Then an OS-native notification is shown (per FR-05)
```

### FR-07 — Tray icon and context menu
A tray icon is present whenever the application is running. Right-clicking it opens a context
menu with, at minimum:
- **Show/Hide Google Chat** — toggles the window's visibility (mirrors double-click on the tray
  icon). Earns its place because close-to-tray (FR-06) removes the taskbar window as the way to
  bring it back on some platforms/configurations, so the tray needs its own explicit way back in.
- **Start at login** — checkbox toggle; see FR-10.
- **Notification sound** — checkbox toggle; see FR-11.
- **Mute notifications** — checkbox toggle; see FR-12.
- **Exit** — the only action that actually terminates the application process.

The application does **not** provide a way to quit from within the web page itself (no in-page
Exit control) — Exit is reachable only via the tray context menu, per the owner's explicit
requirement.

Left-clicking (or double-clicking, per platform convention — see NFR-01) the tray icon toggles
window visibility, mirroring the menu's Show/Hide entry.

```gherkin
Feature: Tray context menu
  Scenario: Open the tray menu
    Given the application is running
    When the user right-clicks the tray icon
    Then a context menu appears containing at least "Show/Hide Google Chat" and "Exit"

  Scenario: Exit via tray menu is the only way to quit
    Given the application window is hidden to tray
    When the user selects "Exit" from the tray context menu
    Then the application process terminates
    And the tray icon disappears

  Scenario: Window close (X) does not terminate the process
    Given the application window is open
    When the user clicks the window's close (X) button
    Then the application process is still running (verifiable via OS process list)
    And selecting "Exit" from the tray menu is still required to terminate it
```

**Resolved (was an open question):** the original draft of this document left "mute notifications"
and "start on login" out as unrequested speculative scope. The owner has since explicitly asked for
both, plus notification sound control — see FR-10, FR-11, FR-12 below, now reflected in the menu
table above.

### FR-08 — Single-instance behavior
Only one instance of the application can run at a time. If the user attempts to launch the
application while an instance is already running (e.g. double-clicking the desktop icon again,
or the OS auto-launching it at login while it's already open), the existing instance's window is
shown and focused instead of a second instance starting.

```gherkin
Feature: Single instance
  Scenario: Launch while already running, window hidden
    Given the application is already running with its window hidden to tray
    When the user attempts to launch the application again (e.g. via desktop shortcut)
    Then no second process starts
    And the existing instance's window is shown and focused

  Scenario: Launch while already running, window visible
    Given the application is already running with its window visible
    When the user attempts to launch the application again
    Then no second process starts
    And the existing instance's window is focused
```

### FR-09 — Distribution installers
Installable packages are produced for **Windows and Linux** (macOS is out of scope — owner
decision, see [ADR-0003](../adr/0003-packaging-and-code-signing-approach.md) and NFR-05). See
**NFR-05** for what "installer" realistically means per platform given the signing constraint on
Windows.

```gherkin
Feature: Distribution installers
  Scenario: Windows installer
    Given a release build has been produced
    Then a Windows installer artifact (e.g. NSIS .exe or equivalent) exists for that release

  Scenario: Linux installer
    Given a release build has been produced
    Then a Linux AppImage artifact exists for that release
    And a Linux .deb package artifact exists for that release
```

### FR-10 — Start automatically at OS login
The application can be configured to launch automatically (into the tray, not with the window
forced open) when the user logs into the OS. Toggled from the tray menu's "Start at login" checkbox,
which reflects the actual current OS-level state (not just an in-app preference that could drift
from reality).

```gherkin
Feature: Start at login
  Scenario: Enable start at login
    Given the application is running and "Start at login" is currently unchecked
    When the user checks "Start at login" from the tray menu
    Then the OS is configured to launch the application automatically on the next login
    And the tray menu shows "Start at login" as checked

  Scenario: Disable start at login
    Given "Start at login" is currently checked
    When the user unchecks it from the tray menu
    Then the OS is configured to no longer launch the application automatically
    And a subsequent login does not start the application

  Scenario: Application starts at login
    Given "Start at login" was enabled in a previous session
    When the OS user logs in
    Then the application launches directly into the tray (window hidden, not forced open)
    And the tray icon and menu are available as in any other launch
```

**Platform mechanism note:** Electron's `app.setLoginItemSettings()`/`getLoginItemSettings()` only
support Windows and macOS (confirmed against `electronjs.org/docs/latest/api/app`) — there is no
Linux support in Electron itself. Since macOS is out of scope, this leaves a genuine platform gap:
Windows uses the native Electron API directly; Linux requires a hand-written XDG autostart `.desktop`
file under `~/.config/autostart/` (a small, well-documented Linux desktop convention, not an
Electron feature) written/removed by the app on toggle. This is a real implementation difference
between the two platforms, not an oversight — see [tray-lifecycle.md](../architecture/tray-lifecycle.md).

### FR-11 — Notification sound control
The tray menu's "Notification sound" checkbox controls whether OS-native notifications play sound,
independent of whatever sound-related setting Google Chat's own web page has (the wrapper's setting
takes precedence for notifications delivered through this app). Persisted across restarts.

```gherkin
Feature: Notification sound control
  Scenario: Turn notification sound off
    Given "Notification sound" is currently checked (default: on)
    When the user unchecks it from the tray menu
    Then subsequent notifications are delivered silently (no sound), even if Google Chat's own
      page-level sound setting is on

  Scenario: Setting persists across restarts
    Given the user turned "Notification sound" off in a previous session
    When the application is relaunched
    Then "Notification sound" is still unchecked
```

**Scope note:** this controls whether a notification plays sound (best-effort — the Web
Notifications API's `silent` option is a hint honored by Chromium/the OS, not a hard on/off Electron
itself fully controls on every platform, per Electron's own notification docs), not which sound
file plays. Custom notification sounds are not requested and are out of scope.

### FR-12 — Mute notifications ("quiet hours")
The tray menu's "Mute notifications" checkbox, when checked, suppresses all new-message OS
notifications entirely until unchecked. The tray unread indicator (FR-05) continues to update while
muted — muting silences notifications, it does not hide that messages arrived.

```gherkin
Feature: Mute notifications
  Scenario: Enable mute
    Given "Mute notifications" is currently unchecked
    When the user checks it from the tray menu
    Then no new OS-native notification is shown for messages arriving after that point
    And the tray unread indicator still updates when new messages arrive

  Scenario: Disable mute
    Given "Mute notifications" is currently checked
    When the user unchecks it from the tray menu
    Then OS-native notifications resume for messages arriving after that point
```

**Design decision — "quiet hours" and "mute" are the same feature, deliberately.** The owner's
ask named both terms; this spec treats them as one manual, persistent-until-toggled tray checkbox
rather than a scheduled time-window feature (e.g. "silence 22:00–08:00 automatically"). Rationale:
a scheduled quiet-hours UI (time pickers, per-day schedules, timezone handling) is real added
complexity disproportionate to a single-user personal utility, when a manual toggle achieves the
practical need the owner described ("a tray menu entry to temporarily silence notifications") with
far less surface. If the owner later wants a scheduled version, that is a distinguishable follow-up
requirement, not assumed here.

### FR-13 — Build/version diagnostic line in the tray menu
The tray context menu shows a disabled (non-clickable), visually de-emphasized line identifying the
exact build that is currently running: the app version, whether it is a packaged install or a dev
run from source, and a build timestamp. Placed last in the menu, after a separator, so it never
competes with the actual controls above it.

**Origin:** owner request, made mid-investigation of the FR-05 notification failure recorded in
[ADR-0002](../adr/0002-notification-delivery-mechanism.md). Diagnosing that failure lost a full
round to manually working out whether a colleague's installed build and a dev run from source were
even running the same code — a bare `app.getVersion()` does not answer that, since it is identical
across every dev run and every packaged release sharing the same `package.json`.

```gherkin
Feature: Build/version diagnostic line
  Scenario: Packaged install shows a build identifier
    Given the application is running from an installed (packaged) build
    When the user opens the tray context menu
    Then the last entry shows the app version, the word "packaged", and a build timestamp
    And that entry is disabled (not clickable)

  Scenario: Dev run shows a distinguishable build identifier
    Given the application is running from source (not packaged)
    When the user opens the tray context menu
    Then the last entry shows the app version, the word "source", and a build timestamp

  Scenario: Version line changes after a rebuild
    Given the application was rebuilt or re-packaged after the last run
    When the application is relaunched and the user opens the tray context menu
    Then the build timestamp shown is different from the previous run's, without any manual update
```

**Scope note:** the build timestamp is derived at runtime from the entry file's filesystem mtime
(see [tray-lifecycle.md](../architecture/tray-lifecycle.md)), not from a git commit hash or a
build-time string injection — this repo has neither wired up, and the mtime already satisfies the
owner's actual need ("can I tell this is the current build") without adding new build tooling.

## Non-Functional Requirements

### NFR-01 — Cross-platform parity, with explicit exceptions
Core behavior (FR-01 through FR-12) works equivalently on **Windows and Linux** (the two in-scope
platforms — macOS dropped, see ADR-0003), with the following platform differences accepted rather
than treated as defects:
- **Start-at-login mechanism differs** (FR-10): Windows uses Electron's native
  `app.setLoginItemSettings()`; Linux has no such Electron API and uses a hand-written XDG
  autostart `.desktop` file instead. Both achieve the same user-visible outcome.
- Distribution/signing parity is explicitly NOT claimed — see NFR-05 (Windows ships unsigned,
  triggering a SmartScreen warning; Linux has no equivalent concept for either of its AppImage/deb
  targets).

### NFR-02 — Resource usage for an always-running tray app
Since the application is expected to run continuously in the background:
- Idle CPU usage (window hidden, no new messages) stays negligible (no busy-polling; rely on
  event-driven notification delivery per FR-05's mechanism).
- Memory footprint is consistent with a single-page Chromium-backed Electron app (roughly in
  line with one Chrome tab of Google Chat), not materially higher due to the wrapper itself.
- No requirement is made to reduce memory below what Google Chat's own web app already uses in
  a browser tab — the wrapper does not need to out-perform the underlying site.

### NFR-03 — Startup time
From launch to the signed-in Chat view being visible (session already persisted per FR-04),
the window shows content within a time comparable to opening a new browser tab to an
already-authenticated site on the same machine — no added multi-second delay attributable to
the wrapper itself (excluding Google Chat's own page load time, which is outside this
application's control).

### NFR-04 — Security posture of an embedded Google login
Because the application embeds a full Chromium renderer showing a real Google sign-in page:
- The application does not intercept, log, modify, or transmit anything typed into the Google
  sign-in form — it is rendered by Google's own page, unmodified, inside a standard
  `BrowserWindow` (not a scriptable `<webview>` with injected content scripts on the auth pages).
- Session credentials (cookies/local storage) are persisted using Electron's standard
  `session.partition` /  `userData` storage mechanism local to the machine, not transmitted
  anywhere outside the normal Google Chat traffic.
- The application does not disable Chromium's standard web security, context isolation, or
  Node integration in the renderer that loads Google Chat (`contextIsolation: true`,
  `nodeIntegration: false`) — this is a baseline Electron hardening expectation, not a
  discretionary nice-to-have, precisely because the same window also handles a real login form.

### NFR-05 — Distribution/signing reality (ties to FR-09)
See the corresponding item in Risks & Open Questions for the full justification. Summary of what
is actually achievable for the two in-scope platforms:
- **Windows**: an installer (e.g. NSIS `.exe`) can be built and is functional without
  code-signing; unsigned, it will show a SmartScreen "unknown publisher" warning on first run.
  Signing requires a code-signing certificate, which is a separate, explicit decision — not
  assumed to be in scope unless the owner acquires one.
- **Linux**: both an AppImage and a `.deb` package are built, neither requiring any code signing.
  The `.deb` targets Debian/Ubuntu, the distro family the owner actually runs; AppImage runs
  anywhere without installation.
- **macOS is out of scope** — an explicit owner decision, recorded in
  [ADR-0003](../adr/0003-packaging-and-code-signing-approach.md). Confirmed directly against
  Electron's own docs (`https://www.electronjs.org/docs/latest/api/notification`): macOS requires
  an application to be code-signed for notifications to appear at all — an unsigned build there
  wouldn't just show a warning, it would silently lose FR-05 entirely on that platform. Signing
  requires an Apple Developer Program membership (US $99/year). The owner does not use macOS, so
  paying that recurring cost to make a platform work that nobody runs was not justified — this is
  the stated cause of the scope decision, not an oversight, and is preserved here so a future
  reader doesn't need to re-derive it.

## Risks & Open Questions

### Risk 1 — Google's embedded-webview OAuth policy (affects FR-03)
Google enforces a documented policy blocking sign-in when it detects an "embedded user agent"
(commonly surfaced as the `disallowed_useragent` error, or the user-facing message "This browser
or app may not be secure"). This policy specifically targets embedded WebView-style controls
(Android WebView, Electron's `<webview>` tag, CEF-based embeds, and similar) rather than every
Chromium-based application: [Google's own announcement](https://developers.googleblog.com/upcoming-security-changes-to-googles-oauth-20-authorization-endpoint-in-embedded-webviews/)
and third-party coverage ([Auth0](https://auth0.com/blog/google-blocks-oauth-requests-from-embedded-browsers/))
confirm the block is driven by user-agent/embedding heuristics, not a blanket ban on all
non-browser software.

Verified evidence that this is **not a hard blocker** for this specific requirement:
- Existing, actively-used Electron-based Google Chat wrapper projects on GitHub (e.g.
  [`ankurk91/google-chat-electron`](https://github.com/ankurk91/google-chat-electron),
  [`iWorkforces/GogChat`](https://github.com/iWorkforces/GogChat)) successfully support Google
  sign-in and are built the same way FR-01/FR-03 describe: a plain Electron `BrowserWindow`
  loading `chat.google.com` directly (not a `<webview>` tag), typically combined with setting a
  standard desktop Chrome `User-Agent` string on that window so it does not present as an
  embedded/WebView client to Google's detection.
- Conversely, projects that DO hit the block are consistently ones using Electron's `<webview>`
  tag or an unmodified Electron user agent for a third-party "Sign in with Google" OAuth consent
  popup flow (e.g. the [`agentify-sh/desktop` issue](https://github.com/agentify-sh/desktop/issues/11),
  [`ChatGPT-Orchestra` issue](https://github.com/VadimAlekseyevich/ChatGPT-Orchestra/issues/65)) —
  a different flow from directly loading `accounts.google.com`'s own first-party sign-in page,
  which is what happens when Google Chat itself prompts an unauthenticated user to sign in.

**Conclusion for this spec:** FR-03 is written as achievable, on the condition that the
implementation loads Google Chat/Google sign-in in a plain `BrowserWindow` (never a `<webview>`
tag) with a standard desktop Chrome `User-Agent` string set on that window/session. This is a
build-time configuration choice for `tech-lead`/the implementer to apply, not a requirement this
document can guarantee in the abstract — if Google tightens the detection further after this
spec is written, FR-03 may need to fall back to a system-browser-based login handoff (open the
user's default browser for the Google login step, then hand the resulting session back to the
Electron app), which is a materially different and more complex flow. Flagging this now so a
failure to sign in during implementation is understood as "the documented risk materialized,"
not a fresh surprise.

### Risk 2 — Resolved: macOS dropped from scope rather than solved (affects FR-09/NFR-05)
Confirmed via [electron-builder's own documentation](https://www.electron.build/docs/features/code-signing/notarization/)
and current guidance ([Forasoft, 2026](https://www.forasoft.com/blog/article/the-pain-of-publishing-electron-apps-on-macos-303)):
macOS notarization requires Apple's `notarytool`, which requires macOS itself and an active Apple
Developer Program membership; it cannot be run from Windows or Linux (a macOS GitHub Actions runner
would have covered the host requirement, but the membership cost remains either way). This was
originally framed as a cross-platform build-tooling problem to solve. It is now resolved
differently: the owner decided macOS isn't a target platform at all (see NFR-05, ADR-0003), so
there is no longer a three-platform signing problem to solve — only Windows' (unsigned, accepted)
and Linux's (no signing concept) remain, and neither needs a multi-machine build story.

### Resolved — start-on-login (FR-10)
Originally left as an open question ("not requested; natural companion feature but not assumed").
The owner has since explicitly asked for it — see FR-10.

### Resolved — notification sound / mute (FR-11, FR-12)
Originally left as an open question ("not specified; OS defaults assumed, no in-app override"). The
owner has since explicitly asked for both an independent sound toggle and a manual mute — see FR-11
and FR-12, including the design decision that "quiet hours" and "mute" are treated as one feature
(a manual toggle, not a scheduled time window) and the stated rationale for that choice.

### Resolved — build/version diagnostic line (FR-13)
Not part of the original scope; added when the owner ran into a real diagnostic need mid-incident
(distinguishing a colleague's installed build from a dev run from source while investigating the
FR-05 notification failure) — see FR-13 and [ADR-0002](../adr/0002-notification-delivery-mechanism.md).

## Traceability

| ID | Requirement |
|----|-------------|
| FR-01 | Launch and initial window |
| FR-02 | Window state persistence |
| FR-03 | Google account authentication |
| FR-04 | Session persistence across restarts/reboots |
| FR-05 | System notifications for new messages, landing on the specific conversation when clicked |
| FR-06 | Close-to-tray |
| FR-07 | Tray icon and context menu |
| FR-08 | Single-instance behavior |
| FR-09 | Distribution installers (Windows, Linux) |
| FR-10 | Start automatically at OS login |
| FR-11 | Notification sound control |
| FR-12 | Mute notifications ("quiet hours") |
| FR-13 | Build/version diagnostic line in the tray menu |
| NFR-01 | Cross-platform parity, with explicit exceptions |
| NFR-02 | Resource usage for an always-running tray app |
| NFR-03 | Startup time |
| NFR-04 | Security posture of an embedded Google login |
| NFR-05 | Distribution/signing reality |

Later design/test artifacts should cite these IDs directly (e.g. "implements FR-05", "covers
NFR-04") rather than re-describing the requirement.
