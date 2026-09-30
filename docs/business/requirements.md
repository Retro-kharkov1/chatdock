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
  closed to tray, opening that conversation when clicked (target; conditional on an open owner decision — see FR-05).
- Close-to-tray behavior; tray icon with a context menu; explicit Quit/Exit action.
- Single-instance enforcement (a second launch focuses the existing instance instead of opening
  a second window).
- Window size/position/state persistence across restarts.
- Installers for Windows and Linux.
- Start automatically at OS login (FR-10).
- Notification sound control, independent of the page's own settings (FR-11).
- Manual notification mute ("quiet hours") via the tray menu (FR-12).
- Blinking tray icon and flashing taskbar button while there are unread messages and the window is
  not focused (FR-14).
- Google Meet calls opened from Chat in an app-owned call window, with camera, microphone and screen
  share (FR-16, NFR-07).
- A dedicated Settings window consolidating start-at-login, notification sound, mute, and icon
  blinking (FR-15).

**Out of scope:**
- Any reimplementation of chat functionality (message list, composer, search, threads, etc.) —
  all of that is rendered by the existing Google Chat web app inside the wrapper.
- Direct integration with the Google Chat REST/RPC API, Google Workspace Events API, or any
  Google API client — the wrapper drives the existing web UI; it does not talk to Google's APIs
  directly. (Revisit only if the DOM/web-notification-bridge approach in FR-05 proves unable to
  detect new messages reliably — see FR-05's mechanism note and ADR-0002's fallback.)
- Multi-account support, multi-window/tabs, or switching between different Chat spaces/URLs
  beyond the one configured entry URL. (The Meet call window of FR-16 is the one accepted exception
  to "one window"; it does not open other Google hosts in-app.)
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

### FR-05 — System notifications for new messages, landing on the conversation when clicked
*Amended 2026-09-30 (owner decisions). FR-05 is now three parts with different certainty. Part A is
unconditional. Parts B and C partly depend on ADR-0004 Spike C and on an owner decision that has not
been made (see "Open question"). The parts are stable sub-IDs: FR-05a, FR-05b, FR-05c.*

**Priority: Must (all three parts).**

#### FR-05a — A native notification appears at all (unconditional)
When a new Google Chat message arrives for the signed-in user, the application shows an OS-native
notification (Windows Action Center / Linux notify-send-compatible) **while the window is hidden to
the tray, minimized, or visible but not focused** (FR-14's definition of "not focused"). This is the
core of the whole application and is required regardless of how the open question below is decided;
today it is a live failure on Windows (ADR-0004, BUG-01).

Rules that bound it (unchanged from before):
- No notification for a conversation the user is actively looking at (window focused and showing that
  conversation).
- Suppressed entirely while Mute (FR-12) is on; delivered without sound while Notification sound
  (FR-11) is off.
- The tray icon shows a visible static unread indicator (e.g. a badge overlay) **whenever at least one
  conversation is unread, independent of window focus** — it stays after the window gains focus and
  clears only when no unread conversation remains (clearing rules per conversation are the Chat
  page's own). The tray has **one global icon**, so the indicator is global. FR-14's blink and flash
  are separate and are tied to the not-focused condition.

#### FR-05b — Notification content (target; conditional on Spike C and the owner's answer)
The owner requires the notification to show **which chat the message is from**: the chat name (the
sender's name for a direct message) as the title and the message text as the body. A notification
showing only generic text (for example "N new messages") does not meet this part.

#### FR-05c — Click behaviour
Clicking a notification does two things:
1. **(Unconditional)** The application window is brought to the front and given focus, **including
   when it was hidden to the tray or minimized** (restored from the tray if hidden).
2. **(Conditional on Spike C and the owner's answer)** The application shows **that conversation** —
   not whichever conversation happened to be open before. The owner's words are "open that chat".
   Scrolling to the specific message is **not** required; see the stretch question below.

**Degraded outcome — defined.** If the conversation cannot be determined, the window still comes to the
front and focused (step 1), and the app writes a **warning-level entry to its persistent application
log** stating that a notification click could not be resolved to a conversation. "Visibly" means
findable in that log by the owner or a tester; no on-screen message is required. It must never be
silent, so a degraded click is never mistaken for the feature working.

#### What applies under each owner answer
| Element | Under (a) — bounded second source accepted | Under (b) — generic content, focus-only click |
|---|---|---|
| FR-05a delivery | Applies | Applies |
| FR-05b content (chat name title, message body) | Applies | **Does not apply**; generic text is the accepted content and this document is amended |
| FR-05c step 1 (bring forward, from tray/minimized) | Applies | Applies |
| FR-05c step 2 (open that conversation) | Applies | **Does not apply**; amended |
| Degraded-outcome logging | Applies to any unresolved click | Not needed — the focus-only click is then the standard behaviour, not a degradation |

Until the owner answers, the conditional scenarios below are the **target** and are written as such; a
test author must not treat a failure of a conditional scenario as a regression before Spike C reports.

```gherkin
Feature: System notifications
  # Tags: [automatable] = unit/integration test with a stubbed notification source and stubbed
  # handlers. [manual-only] = needs the real OS toast to be displayed or clicked on a real desktop.
  # ---- FR-05a: unconditional ----
  Scenario: [manual-only] A notification appears for a new message while hidden to tray
    Given the application is running with the window hidden to tray
    And the user is signed in and "Mute notifications" is off
    When a new Google Chat message arrives for the signed-in user
    Then an OS-native notification is shown
    And the tray icon shows an unread indicator

  Scenario: [manual-only] A notification appears while the window is minimized
    Given the application window is minimized
    When a new Google Chat message arrives
    Then an OS-native notification is shown

  Scenario: [manual-only] A notification appears while the window is visible but not focused
    Given the application window is visible but another application has OS focus
    When a new Google Chat message arrives
    Then an OS-native notification is shown

  Scenario: [automatable] No notification for the conversation being viewed
    Given the application window is open, focused, and showing the conversation the message
      belongs to
    When a new message arrives in that conversation
    Then no OS-native notification is shown for that message

  Scenario: [automatable] Notifications suppressed while muted (FR-12)
    Given the user has enabled "Mute notifications" from the tray menu
    When a new Google Chat message arrives while the window is hidden
    Then no OS-native notification is shown
    And the tray unread indicator still updates (mute silences notifications, not the unread count)

  Scenario: [automatable] Notification sound off (FR-11)
    Given the user has turned off "Notification sound" in the Settings window (FR-15)
    And "Mute notifications" is not enabled
    When a new Google Chat message arrives while the window is hidden
    Then an OS-native notification is still shown
    And it is delivered without sound

  Scenario: [automatable] The tray indicator is global and observable
    Given the tray icon shows the unread indicator because conversations "A" and "B" are unread
    When conversation "B" has been viewed and "A" is still unread
    Then the tray icon still shows the unread indicator
    When conversation "A" has also been viewed
    Then the tray icon returns to its normal (non-unread) icon

  # ---- FR-05c step 1: unconditional ----
  Scenario: [manual-only] Clicking a notification brings the window forward from the tray
    Given the window is hidden to tray and an OS-native notification is shown
    When the user clicks the notification
    Then the window is restored, brought to the front and focused

  Scenario: [manual-only] Clicking a notification brings the window forward from minimized
    Given the window is minimized and an OS-native notification is shown
    When the user clicks the notification
    Then the window is restored, brought to the front and focused

  # ---- FR-05b: conditional on Spike C + owner answer (a) ----
  Scenario: [manual-only] [conditional - applies under (a)] Title names the chat and body is the message
    Given a new message arrives in the direct message with "Olena"
    When the OS-native notification is shown
    Then its title is "Olena" and its body is the message text

  Scenario: [manual-only] [conditional - applies under (a)] Notification in a group space names the space
    Given a new message arrives in the group space "Team Alpha" from a sender "Olena"
    When the OS-native notification is shown
    Then its title identifies the chat ("Team Alpha", with or without the sender's name)
    And its body is the message text

  # ---- FR-05c step 2: conditional on Spike C + owner answer (a) ----
  Scenario: [manual-only] [conditional - applies under (a)] Clicking opens that conversation, not just any focus
    Given the window is hidden to tray
    And a new message arrives in conversation "B" while conversation "A" was the last one open
    And an OS-native notification is shown for that message
    When the user clicks the notification
    Then the window is restored and focused
    And the application is showing conversation "B", not conversation "A"

  Scenario: [manual-only] [conditional - applies under (a)] Click opens the conversation from a minimized window
    Given the window is minimized and a notification is shown for a message in conversation "B"
    When the user clicks the notification
    Then the window is restored, focused and showing conversation "B"

  Scenario: [automatable] [conditional - applies under (a)] Unresolvable conversation is a logged degraded outcome
    Given an OS-native notification is shown for a message
    And the specific conversation cannot be determined
    When the user clicks the notification
    Then the window is brought to the front and focused
    And a warning-level entry is written to the application's persistent log stating the click could
      not be resolved to a conversation
```

**Open question (owner decision; not decided here) — how to reach the right conversation.** ADR-0004
states the choice the owner will face once Spike C reports (what Chat's notification actually carries,
and whether a conversation identifier is reachable without scraping):
- **(a)** accept a bounded second source for this one purpose (the document title / unread state, or
  reading the page) — which touches the space rule `wrapper-not-a-rewrite`; or
- **(b)** accept generic notification content and a click that only brings the window forward.

Sub-questions: if only the sender is known and the message is in a group space, is a sender-only title
acceptable, or must the space name be shown? **Stretch question:** should a click also scroll to the
specific message, or is opening the chat enough? (The owner said "open that chat"; scrolling is
excluded unless the owner asks for it.)

#### History — superseded mechanism notes (not normative)
*Kept so a reader does not re-derive them. The current mechanism is undecided; these describe what was
believed and what happened, and the downstream architecture docs that cite them are listed as
superseded in the [change log](#change-log).*

- **Earlier design, corrected after real-machine testing.** The design assumed Google Chat calls the
  standard Web Notifications API when the tab is backgrounded and that Electron bridges those calls to
  the OS while the renderer stays alive **and** Chat's own `document.visibilityState` reports the
  window as hidden. An earlier revision set `backgroundThrottling: false`, which pins `visibilityState`
  at `"visible"`, so Chat suppressed every notification while hidden. Caught in the owner's real test
  and traced by `electron-developer`; see [ADR-0002](../adr/0002-notification-delivery-mechanism.md)
  Revision 3. `backgroundThrottling` is left at Electron's default (empirically confirmed on the pinned
  Electron 44.4.3).
- **2026-09-30 finding (secondary evidence, unverified in this repo).** Chat very likely raises its
  real notifications through a **service worker** (`ServiceWorkerRegistration.showNotification`), not
  a page-level `Notification`. Risks, not facts: the shell's wrapper around the page `Notification`
  may never see them and the current shell never displays service-worker notifications (a candidate
  cause of BUG-01, ADR-0004 Spike A); the `tag` may identify the sender, not the conversation, and the
  page URL may not change per conversation; the service worker's own click handler may or may not route
  to the right conversation and the page cannot reach it. What Chat's notification carries is
  ADR-0004 **Spike C**.

### FR-06 — Close-to-tray
Clicking the **main Chat window's** close (X) button hides the window (does not destroy the
application process, does not quit). The application keeps running in the background and continues to
receive and surface notifications per FR-05 while hidden. This behaviour applies to the main window
only: the Meet call window (FR-16) is **destroyed** when closed, not hidden, and the Settings window
keeps its own behaviour (FR-15). Neither of them quits the application.

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
- **Show/Hide Google Chat** — toggles the **main Chat window's** visibility (mirrors double-click on
  the tray icon). While a Meet call window (FR-16) is open it acts on the main window only and never
  hides or closes the call (working assumption, pending the owner — see FR-16). It earns its place
  because close-to-tray (FR-06) removes the taskbar window as the way to bring it back on some
  platforms/configurations, so the tray needs its own explicit way back in.
- **Mute notifications** — checkbox toggle; see FR-12. This is the **only** preference checkbox
  that remains on the tray menu — see FR-15's "Tray menu vs. Settings window" decision for why
  Start at login and Notification sound were moved to the Settings window instead.
- **Settings…** — opens the Settings window (see FR-15), where Start at login, Notification sound,
  and Icon blinking (FR-14) are managed.
- **Exit** — the only action that actually terminates the application process.

The build/version diagnostic line (FR-13) is also part of this menu, placed last after a
separator — it is not a preference control and is listed separately in FR-13.

The application does **not** provide a way to quit from within the web page itself (no in-page
Exit control) — Exit is reachable only via the tray context menu, per the owner's explicit
requirement.

Left-clicking (or double-clicking, per platform convention) the tray icon toggles
the main window's visibility, mirroring the menu's Show/Hide entry.

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
both, plus notification sound control — see FR-10, FR-11, FR-12 below. Of the three, only **Mute
notifications** is reflected in the tray menu list above; Start at login and Notification sound are
managed exclusively from the Settings window introduced by FR-15 (a later, explicit owner decision
that superseded an earlier draft keeping all three on the tray menu — see FR-15).

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
Windows. The Linux packages must also satisfy **NFR-08** (install path and executable name without
spaces; the `.deb` declares its audio runtime dependency).

```gherkin
Feature: Distribution installers
  Scenario: Windows installer
    Given a release build has been produced
    Then a Windows installer artifact (e.g. NSIS .exe or equivalent) exists for that release

  Scenario: Linux installer
    Given a release build has been produced
    Then a Linux AppImage artifact exists for that release
    And a Linux .deb package artifact exists for that release
    And the Linux install path, executable name and .deb dependency declaration satisfy NFR-08
```

### FR-10 — Start automatically at OS login
The application can be configured to launch automatically (into the tray, not with the window
forced open) when the user logs into the OS. Toggled from the Settings window's "Start at login"
checkbox (see FR-15 — this control lives in Settings only, not the tray menu), which reflects the
actual current OS-level state (not just an in-app preference that could drift from reality).

```gherkin
Feature: Start at login
  Scenario: Enable start at login
    Given the Settings window is open and "Start at login" is currently unchecked
    When the user checks "Start at login" in the Settings window
    Then the OS is configured to launch the application automatically on the next login
    And the Settings window shows "Start at login" as checked

  Scenario: Disable start at login
    Given "Start at login" is currently checked
    When the user unchecks it in the Settings window
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
The Settings window's "Notification sound" checkbox (see FR-15 — this control lives in Settings
only, not the tray menu) controls whether OS-native notifications play sound, independent of
whatever sound-related setting Google Chat's own web page has (the wrapper's setting takes
precedence for notifications delivered through this app). Persisted across restarts.

```gherkin
Feature: Notification sound control
  Scenario: Turn notification sound off
    Given "Notification sound" is currently checked (default: on)
    When the user unchecks it in the Settings window
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

Mute notifications is the one preference that appears **both** on the tray menu and in the Settings
window (FR-15) — see FR-15's "Two-way sync" clause for exactly how the two controls stay in
agreement, including while both are visible/open at the same time.

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

### FR-14 — Attention indicator on unread: blinking tray icon and flashing taskbar button
**Priority: Must.** *Amended 2026-09-30 (owner decision): extended from "tray blink while hidden" to
"tray blink and taskbar flash whenever the window is not focused". Earlier wording is superseded, not
kept alongside.*

While the main Chat window is **not focused** and there is at least one unread message (this uses
FR-05's unread state; the static indicator itself is focus-independent, see FR-05a), the application draws attention on two
surfaces at once:
1. **Tray icon** — alternates between its normal icon and its unread icon, the way classic desktop
   messengers did ("blink until you look"), instead of only showing a static badge.
2. **Taskbar button** — flashes (Windows `flashFrame`) until the window gains focus.

**"Not focused" — defined precisely.** The main Chat window is not focused when it is any of:
hidden to the tray; minimized; or visible but without OS input focus (behind other windows, or another
application has focus). "Focused" means the main Chat window has OS input focus. The Settings window
and the Meet call window (FR-16) are separate windows: having focus in one of them does **not** make
the main Chat window focused, so a new message still triggers the indicator (working assumption — see
the open question at the end of this section).

**Start/resume condition:** both indicators (re)start on **every new-message-arrival event** that
occurs while the main window is not focused, not only the first message that takes unread from 0 to ≥1.
Precisely:
- The first unread message (unread count 0 → ≥1) starts them.
- Any **subsequent** new message that arrives while the window is still not focused also (re)starts
  them — **even if they had already stopped** because the window gained focus and then lost it again
  without the user viewing the relevant unread conversation.
- A new message that arrives while the tray icon is **already blinking** is a no-op for the blink
  state itself and must not create a second timer — see NFR-06. The taskbar flash is likewise
  re-requested without stacking.

  Decision rationale: the owner's stated intent is to have the shell "draw my eye when messages
  arrive". An attention signal tied to the *arrival event*, not to a stale "still have something
  unread" fact, is what serves that. The owner extended it to the taskbar button because a window
  that is open but buried behind other windows is the common real case, and a tray icon alone does
  not reach it.

**Dependency on FR-05.** The arrival event that starts the indicators is only as good as the
detection mechanism behind FR-05a, which is itself undecided (service-worker notifications, ADR-0004
Spikes A and C). If per-message arrival cannot be detected reliably, the **acceptable degraded
trigger** is: the global unread count **increases** while the window is not focused. That still starts
both indicators; what it loses is the "new message while unread was already above zero" precision when
a read and an unread cancel out between two observations. Any implementation must state which trigger
it uses.

**Stop condition — decided. This is the single, authoritative definition of when the indicators
stop; NFR-06 does not redefine it, it only specifies the timer mechanics.** Both indicators stop on
**any of three** triggers, never on a timer and never after a fixed number of cycles:
1. **The main window gains OS input focus.** Being restored, shown or brought to the front without
   receiving focus does **not** stop them (this reverses the earlier "becomes visible" rule). Once
   focused, they stop regardless of:
   - which conversation the window is showing — they stop even if it shows a conversation other than
     the one the unread message belongs to;
   - whether unread messages remain for a different conversation — FR-05's separate static unread
     indicator keeps reflecting whatever unread state remains, unaffected by this stop event.
2. **The unread count returns to zero while the window is still not focused** (for example the
   messages were read on another device and Google Chat's synced read state reaches this client).
   Driven by the same unread-count fact FR-05 tracks, not by elapsed time.
3. **A setting changes mid-indicator.** If "Icon blinking" (`blinkOnUnread`) is turned off, or "Mute
   notifications" (`notificationsMuted`) is turned on, while an indicator is active, it stops
   immediately as a direct effect of the setting change, independent of whether unread messages
   remain. NFR-06's QA scenario list exercises this trigger. (The existing implementation applies it in
   `applySetting`; the architecture doc describing that is listed as superseded in the
   [change log](#change-log).)

This is deliberately a **lower bar** than FR-05's "viewed" condition (which requires the user to have
actually looked at the specific conversation before its unread contribution clears). The indicators'
only job is to get the window in front of the user's eyes, which gaining focus already satisfies;
FR-05 tracks whether content was actually read. Gaining focus and then losing it again without
viewing the conversation does not, by itself, restart them — that takes a **new** message arrival.

**Interaction with mute (FR-12) — decided:** while "Mute notifications" is on, the tray icon does
**not** blink, but the static unread indicator still shows (FR-05). Mute means "don't poke me";
blinking is poking. The unread state must not be lost because notifications are muted. Turning mute
on while an indicator is active is stop trigger 3.

**Working assumption (not an owner decision): mute also suppresses the taskbar flash.** The owner
decided mute for the tray blink; extending it to the flash follows the same "don't poke me" logic but
was not stated. Pending the owner's confirmation.

**Mute turned OFF while unread messages exist and the window is not focused — working assumption:**
turning mute off does **not** start the indicators by itself, because they are tied to an arrival
event (see the rationale above); they start on the **next** arrival. The static unread icon is
unaffected either way. The same applies when "Icon blinking" is turned back on.

**What alternates:** the tray icon cycles between the existing **normal** icon and the existing
**unread** icon at approximately 1 second (1000 ms) per phase. No new icon art is introduced.

**User-switchable — decided:** the "Icon blinking" setting (FR-15) turns the attention indicator on or
off independently of the underlying unread indicator (not optional — FR-05 always requires *some*
unread signal). When off, unread messages still show the static unread icon; the tray alternation
stops **and the taskbar button does not flash** (turning it off mid-flash stops the flash — stop
trigger 3). **Working assumption, pending the owner:** "Icon blinking" governs **both** the tray blink
and the taskbar flash; a separate flash setting is not provided.

```gherkin
Feature: Attention indicator on unread (tray blink and taskbar flash)
  # Tags: [automatable] = state logic tested with the flash request and tray-image swap stubbed.
  # [manual-only] = the real visible taskbar flash on a real desktop.
  Scenario: [manual-only] The real taskbar button visibly flashes and stops on focus (Windows)
    Given the window is hidden, minimized or behind other windows on a real Windows desktop
    When a new message arrives with blinking enabled and mute off
    Then the taskbar button visibly flashes
    When the window is focused
    Then the flashing stops

  Scenario: [automatable] Indicators start when an unread message arrives while hidden to tray
    Given the application window is hidden to tray
    And there are currently no unread messages
    And icon blinking is enabled (FR-15) and "Mute notifications" is off
    When a new Google Chat message arrives
    Then the tray icon begins alternating between its normal and unread icon states
    And the taskbar button flashes on Windows

  Scenario: [automatable] Indicators start when the window is minimized
    Given the application window is minimized
    And icon blinking is enabled and "Mute notifications" is off
    When a new Google Chat message arrives
    Then the tray icon begins alternating
    And the taskbar button flashes on Windows

  Scenario: [automatable] Indicators start when the window is visible but behind other windows
    Given the application window is visible but another application has OS focus
    And icon blinking is enabled and "Mute notifications" is off
    When a new Google Chat message arrives
    Then the tray icon begins alternating
    And the taskbar button flashes on Windows

  Scenario: [automatable] No indicator while the window is focused
    Given the application window is visible and has OS input focus
    When a new Google Chat message arrives in a conversation other than the one shown
    Then the tray icon does not blink
    And the taskbar button does not flash

  Scenario: [automatable] Gaining focus stops both indicators
    Given the tray icon is blinking and the taskbar button is flashing
    When the main window gains OS input focus
    Then the tray icon stops blinking immediately
    And the taskbar button stops flashing
    And neither resumes on its own after any fixed delay or cycle count

  Scenario: [automatable] Becoming visible without focus does not stop the indicators
    Given the tray icon is blinking and the window is hidden to tray
    When the window is restored to visible but does not receive OS input focus
    Then the tray icon is still blinking
    And the taskbar button is still flashing

  Scenario: [automatable] Gaining focus while showing a different conversation still stops the indicators
    Given the indicators are active due to an unread message in conversation "B"
    And conversation "A" is the conversation shown when the window gains focus
    When the user focuses the window (still showing conversation "A", not "B")
    Then both indicators stop
    And the static unread indicator for conversation "B" remains visible per FR-05

  Scenario: [automatable] Indicators resume when a new message arrives after they had stopped, with unread pending
    Given the window gained focus and then lost it again without the user viewing the relevant
      unread conversation
    And both indicators stopped when it gained focus
    And the unread count is still greater than 0
    When a new Google Chat message arrives while the window is not focused
    Then the tray icon begins alternating again
    And the taskbar button flashes again

  Scenario: [automatable] A new message while the tray icon is already blinking does not spawn a second timer
    Given the tray icon is currently blinking due to unread messages
    When another new Google Chat message arrives while the window is still not focused
    Then the tray icon continues alternating at the same interval
    And no additional/duplicate blink timer is created (see NFR-06)

  Scenario: [automatable] Unread count returns to zero while the window is not focused
    Given both indicators are active due to unread messages
    And the window remains not focused throughout this scenario
    When the unread count drops to zero
    Then the tray icon stops blinking and the taskbar button stops flashing immediately
    And this happens without the window ever gaining focus

  Scenario: [automatable] Indicators do not stop on their own over time
    Given both indicators are active due to unread messages
    When an extended period passes with the window still not focused
    Then the tray icon is still blinking and the taskbar button is still flashing

  Scenario: [automatable] [working assumption for the flash] Muted — no blink, no flash, but unread state still visible
    Given "Mute notifications" is enabled
    And there are unread messages while the window is not focused
    Then the tray icon does not blink
    And the taskbar button does not flash
    And the tray icon still shows the static unread indicator (per FR-05)

  Scenario: [automatable] Muting while the indicators are active stops them
    Given both indicators are active
    When the user turns "Mute notifications" on
    Then the tray icon stops blinking and the taskbar button stops flashing immediately

  Scenario: [automatable] Blinking disabled by user preference
    Given "Icon blinking" is turned off in Settings (FR-15)
    And there are unread messages while the window is not focused
    Then the tray icon shows the static unread indicator
    And the tray icon does not alternate
    And the taskbar button does not flash [working assumption: one setting governs both]

  Scenario: [automatable] Turning "Icon blinking" off while the indicators are active stops both
    Given both indicators are active
    When the user turns "Icon blinking" off in Settings
    Then the tray icon stops blinking and the taskbar button stops flashing immediately
    And the static unread indicator remains

  Scenario: [automatable] [working assumption] Turning mute off does not start the indicators retroactively
    Given "Mute notifications" is on and there are unread messages while the window is not focused
    When the user turns "Mute notifications" off
    Then neither indicator starts by itself
    And the next new message arriving while the window is not focused starts both indicators

  Scenario: [automatable] No unread messages — no indicators
    Given there are no unread messages
    Then the tray icon shows its normal (non-blinking, non-unread) state
    And the taskbar button is not flashing
```

**Platform note:** the taskbar flash is required on Windows. Electron's `flashFrame` also exists on
Linux (a window-manager urgency hint whose visible effect depends on the desktop environment); Linux
is best-effort and its real behaviour is verified on a real Linux desktop, not assumed.

**Scope note:** this requirement extends FR-05's existing unread indicator; it does not change when a
message counts as "unread" or how that indicator clears — those rules are FR-05's, unchanged.

**Working assumptions pending the owner (not decisions):** (1) "Icon blinking" governs both the tray
blink and the taskbar flash; (2) mute also suppresses the flash; (3) turning mute or blinking back on
does not start the indicators until the next arrival; (4) while the user is in the Meet call window
(FR-16) or the Settings window, a new chat message still triggers the indicators, because the main
Chat window is not focused. The owner may instead want the flash independently switchable.

### FR-15 — Settings window
A dedicated Settings window consolidates preference management in one place, replacing the
tray context menu's role as the only place some of these are reachable, and giving the newly
added icon-blinking preference (FR-14) somewhere to live without growing the tray menu further.

**Covers, at minimum:** Start at login (FR-10), Notification sound (FR-11), Mute notifications
(FR-12), Icon blinking (FR-14).

**Open question (owner), from FR-14:** if the "Icon blinking" setting also governs the taskbar flash
(working assumption), its label must say so, because "Icon blinking" no longer describes what it does;
if the flash gets its own setting, this window gains a control and needs a wireframe from
`ux-ui-designer`. Not decided here; FR-15 is otherwise unchanged.

**Tray menu vs. Settings window — decided by the owner directly (supersedes the earlier draft):**
an earlier draft of this document kept all three existing tray checkboxes (Start at login,
Notification sound, Mute notifications) unchanged, on the reasoning that removing UX the owner
already relies on without asking first is against standing practice. That reasoning was sound, so
rather than guess, the owner was asked directly which way to resolve it — and decided the opposite
of the earlier draft's default:
- **Mute notifications** is the **only** setting that keeps its tray-menu quick-toggle. It is the
  one preference realistically toggled in the moment (silence notifications right now), which is
  exactly what a one-click tray checkbox is for.
- **Start at login** and **Notification sound** are removed from the tray menu and are now
  **Settings-window-only** controls — these are "set occasionally, not reacted to in the moment"
  preferences, and belong with the rest of Settings rather than splitting the same class of control
  across two places.
- **Icon blinking** (FR-14) was already Settings-only in the original design and remains so — the
  owner's own framing of this feature ("so that all this can be managed... instead of an
  ever-growing tray menu") is the reason new preferences go to Settings, not the tray, from here on.

The tray menu therefore carries exactly one preference checkbox (Mute notifications) plus a new
**"Settings…"** entry that opens this window. See FR-07 for the resulting tray menu contents.

The build/version diagnostic line (FR-13) is **not** moved into Settings — it is a diagnostic
display, not a user preference, and stays where FR-13 already placed it (last entry in the tray
menu). See "Read-only version/About line" below for the separate, Settings-window-only About line
this design also introduces.

**No native OS application menu — decided.** `ux-ui-designer` proposed adding a native OS
application-menu entry point (a `Settings…` item under a standard app menu, with an `Ctrl+,`
accelerator) as a second way to open Settings, and correctly flagged it as unauthorized by any
requirement pending ratification. **Decision: rejected — Settings opens only from the tray menu, and
no application menu is present at all.** Rationale:
- The owner never asked for a second entry point to Settings; the tray menu's existing
  "Settings…" entry (see above and FR-07) is sufficient.
- Electron installs a default application menu (including a default Quit/Exit item) unless it is
  actively suppressed — introducing an application menu, even for a single harmless item, creates
  the single most likely way to reintroduce a second quit path into this application, which
  directly conflicts with the "Exit is reachable only via the tray context menu" requirement (see
  FR-07, "the application does **not** provide a way to quit from within the web page itself... Exit
  is reachable only via the tray context menu, per the owner's explicit requirement"). A carefully
  hand-built menu template that omits Quit is a weaker guarantee than the surface not existing at
  all.
- This is therefore a testable requirement, not an implementation detail left to be remembered: the
  application must actively suppress/set an empty (`null`) application menu on both Windows and
  Linux, rather than relying on Electron's default being harmless.

**How it is opened:** via the new "Settings…" entry in the tray context menu (FR-07). It is a real
application window (not a submenu), can be brought to front again if already open (no duplicate
Settings windows), and can be closed independently of the main Chat window (closing Settings does
not close or hide the Chat window, and vice versa).

**When changes take effect — decided:** immediately, with no Save/Cancel step. This matches the
already-existing behavior of the tray's Mute checkbox (FR-12 applies the moment it's toggled) and
is the right level of ceremony for a single-user personal utility — a Save/Cancel/dirty-state flow
is overhead this app's usage pattern (owner adjusts their own settings occasionally) doesn't
justify.

**Persistence:** settings are persisted to the same local, machine-scoped preference storage
already used by FR-10/FR-11/FR-12 (no new storage mechanism introduced by this requirement).

**Two-way sync for Mute notifications — the only setting present in both places:** Mute
notifications appears both as a tray-menu checkbox (FR-12) and as a Settings-window control. Both
read and write the exact same underlying persisted value — never two independently-tracked copies
that can drift apart. Precisely:
- **Toggling Mute from the tray menu while the Settings window is open:** the Settings window's
  Mute control updates to reflect the new state immediately (while Settings remains open), without
  requiring the user to close and reopen it.
- **Toggling Mute from the Settings window:** the underlying persisted value updates immediately.
  The tray menu is a native OS context menu that is not simultaneously open while the user is
  interacting with the Settings window (it closes on selection or on losing focus, per normal
  native-menu behavior on both target platforms), so there is no "both open at once" case in that
  direction to reconcile visually — but the tray menu's Mute checkbox always reflects the current
  persisted value the next time the tray menu is opened, with no stale/cached copy.
- In both directions, the update to the persisted value is synchronous with the user's action —
  there is no scenario where reading the value from one surface returns the pre-toggle state after
  the other surface has already changed it.

**Read-only version/About line — ratified.** The design (`docs/design/`) adds a read-only
version/About line inside the Settings window; this addition is **approved**, with scope kept
deliberately narrow:
- It shows only the app name and version number as static, read-only text — no build timestamp, no
  dev-vs-packaged distinction, and no separate data source from what FR-13 already tracks.
- It does **not** duplicate FR-13's diagnostic detail (build timestamp, packaged-vs-source). FR-13's
  tray line exists for a specific diagnostic moment (distinguishing exactly which build is running
  while troubleshooting, per its origin story); a Settings About line serves a different, more
  casual moment (a user checking "what version is this" during normal use, in the conventional
  place a desktop app puts that information) and is cheap enough — one static label, no new state,
  no new persistence — that the overlap with FR-13 is not worth blocking over.
- If FR-13's diagnostic line is ever removed or changed, this About line is not required to change
  with it — they are independent, sourced from the same `app.getVersion()`-equivalent value but
  serving different purposes.

**First run, no saved preferences:** the Settings window (and the tray menu's Mute checkbox) show
these defaults, matching the defaults FR-10/11/12 already establish plus the new FR-14 default:
- Start at login: off
- Notification sound: on
- Mute notifications: off
- Icon blinking: on (the feature exists specifically to be seen; defaulting it off would mean most
  users never discover it)

**A setting the app cannot honour on the current platform:** this is not hypothetical — FR-10
already implements Start-at-login differently per platform (native OS API on Windows, a
hand-written autostart file on Linux), and both currently work. The general rule this requirement
establishes, so it holds for this and any future platform-limited setting: the Settings window
must never let a toggle silently no-op. For every setting, either (a) it is actually implemented
for the current platform (as FR-10 already is for both Windows and Linux today), or (b) if a
future setting genuinely has no platform-specific implementation, its control is shown disabled
with a visible reason, rather than appearing togglable while doing nothing. Today, all four
settings in scope (FR-10/11/12/14) are fully implemented on both Windows and Linux, so case (b)
does not currently apply to any control — this clause exists to bind the behavior for whenever
that changes, not to describe a present gap.

```gherkin
Feature: Settings window
  Scenario: Open Settings from the tray menu
    Given the application is running
    When the user selects "Settings…" from the tray context menu
    Then the Settings window opens
    And it shows the current state of Start at login, Notification sound, Mute notifications, and
      Icon blinking

  Scenario: Opening Settings again while it is already open
    Given the Settings window is already open
    When the user selects "Settings…" from the tray context menu again
    Then no second Settings window opens
    And the existing Settings window is brought to front

  Scenario: A change in Settings takes effect immediately
    Given the Settings window is open
    When the user turns "Icon blinking" off
    Then the change applies immediately, with no separate Save action required
    And a subsequent unread message while the window is hidden does not blink the tray icon

  Scenario: Mute stays in sync — toggled from the tray while Settings is open
    Given the Settings window is open, showing "Mute notifications" as unchecked
    When the user toggles "Mute notifications" on from the tray menu
    Then the Settings window's "Mute notifications" control immediately reflects the checked state,
      without the user closing and reopening Settings

  Scenario: Mute stays in sync — toggled from Settings, reflected in the tray on next open
    Given "Mute notifications" is currently unchecked in both the tray menu and the Settings window
    When the user checks "Mute notifications" in the Settings window
    Then the persisted Mute value updates immediately
    And the next time the tray context menu is opened, its "Mute notifications" checkbox shows
      checked

  Scenario: Start at login and Notification sound are Settings-only
    Given the application is running
    When the user opens the tray context menu
    Then the menu does not contain a "Start at login" checkbox or a "Notification sound" checkbox
    And both settings are only changeable from the Settings window

  Scenario: First run with no saved preferences
    Given the application has never been run on this machine (no persisted settings exist)
    When the user opens the Settings window for the first time
    Then Start at login is off, Notification sound is on, Mute notifications is off, and Icon
      blinking is on

  Scenario: Settings persist across restarts
    Given the user changed one or more settings in the Settings window in a previous session
    When the application is relaunched and the user opens the Settings window
    Then it shows the same values as when the application was last closed

  Scenario: Read-only version/About line shows the current version
    Given the Settings window is open
    Then it shows a read-only line with the app name and current version number
    And that line is not clickable and has no associated action

  Scenario: No application menu is present
    Given the application is running (window visible or hidden to tray, either state)
    Then no native OS application menu (e.g. a top-level "File"/"Edit"/app-name menu bar) is shown
      for the application on Windows or Linux
    And the only way to open Settings is the tray context menu's "Settings…" entry (FR-07)
    And the only way to quit the application is the tray context menu's "Exit" entry (FR-07) — no
      Quit/Exit item is reachable via any application menu, because no application menu exists
```

**Scope note:** layout, wording, and interaction design of the Settings window are explicitly out
of scope for this document — a `ux-ui-designer` owns that. This requirement specifies what must be
manageable, how it opens, when it takes effect, and where it persists, not what it looks like.

### FR-16 — Google Meet calls in an app-owned call window
**Priority: Must** (owner-requested 2026-09-30). **Status: delivery conditional on Spike B** — real
Meet inside Electron is an unsupported configuration and is **unverified**; see the verification
clause below and [ADR-0004](../adr/0004-desktop-shell-technology-and-electron-retention.md).

When the user opens a Google Meet call link from Chat, the call opens in an **app-owned call window**
instead of the system browser, and the call works inside it:
- **Camera, microphone and screen share must work** in the call window.
- **The Google login carries over** — the user is already signed in to Meet, with no second sign-in
  (the call window shares the app's signed-in session, FR-04).
- **Screen share uses the application's own source picker.** When Meet requests a screen or window
  to share, the application shows a picker listing the available sources and the user chooses one (or
  cancels). **The application never picks a source automatically**, under any circumstance.
- **Closing the call window destroys it** — it is never hidden or kept alive — which ends the call for
  this participant and **releases the camera, microphone and any screen capture**. It never quits the
  application and does not close or hide the main Chat window; the app stays resident per FR-06/FR-07.
  (FR-06's close-to-tray applies to the main window only.)
- **Only `https://meet.google.com` gets this treatment.** Every other link still opens in the system
  browser. The exact matching rule is in NFR-07.

**What counts as "a Meet link from Chat" (scope).** In scope: any Meet link the user activates inside
the main Chat window — a link in a message, Chat's own **Join / Meet buttons**, and calendar or
meeting cards rendered by Chat — whether the page opens it as a new window or navigates the main frame
to it (the main-frame case is intercepted, see NFR-07). Out of scope: a Meet link opened from outside
the application (another app, the OS, a browser); those are not the app's to route.

**Working defaults, pending the owner (assumptions, not decisions — the owner has not answered yet):**
- **One call window at a time.** Activating a second Meet link while a call window is open focuses the
  existing call window and does **not** open a second one or navigate the existing call away
  unprompted. **The user is told**, by a native OS notification reading "A call is already open. The
  new link was not opened." It is shown **regardless of mute**, because it is app status, not a chat
  message. Clicking it focuses the existing call window. It reuses the notification surface, so it
  adds no new UI and needs no extra wireframe. The action is never silent.
- **Linux with PipeWire:** the application relies on the operating system's own screen-share picker
  and does **not** show the app picker there (a second picker would be redundant); it still never
  chooses a source automatically. On Windows the app picker is always used. **This departs from the
  owner's stated decision that screen share uses "the app's own picker"**, so it is tied to Spike B:
  Spike B must verify that `setDisplayMediaRequestHandler` can defer to the portal picker without the
  app auto-choosing a source. If it cannot, the owner's original decision (the app's own picker on
  Linux too) stands and the wireframe must cover it.
- **Tray "Show/Hide Google Chat" acts on the main window only** while a call is open, and never
  hides or closes the call window.
- Attention indicators (FR-14) still fire while the user is inside the call window.

Each scenario is tagged **[automatable]** (unit/integration test, with real Meet replaced by a stub
page or stubbed handlers) or **[manual-only]** (needs a real Meet call, real devices and a real desktop).

```gherkin
Feature: Google Meet calls in an app-owned call window
  Scenario: [automatable] Open a Meet link from Chat
    Given the user is signed in and the main window shows a Chat message with a Meet link
      on https://meet.google.com
    When the user clicks the link
    Then a call window owned by the application is created for that URL
    And the system browser is not opened
    And the call window uses the same session as the main window (so no second sign-in is needed)

  Scenario: [automatable] Chat's own Join button and a calendar card open the call window
    Given the main window shows a Join button or a calendar card whose target is a Meet URL
    When the user activates it
    Then the call window is created and the system browser is not opened

  Scenario: [automatable] The main frame navigating to a Meet URL is intercepted
    Given the main window is about to navigate itself to a Meet URL
    Then the navigation is prevented in the main window
    And the call window is created for that URL instead

  Scenario: [manual-only] Login carries over in a real call
    Given the user is signed in to the application
    When a real Meet call link is opened
    Then the call loads signed in with no Google sign-in prompt

  Scenario: [manual-only] Camera and microphone work in a real call
    Given the call window is open on a real Meet call
    When the user enables camera and microphone
    Then the other participants receive the user's video and audio

  Scenario: [automatable] Screen share shows the app's own picker (stubbed display-media source)
    Given the call window requests display capture and a stubbed display-media source list is supplied
    Then the application's source picker is shown listing the stubbed sources
    And no source is returned to the page until the user selects one

  Scenario: [automatable] Cancelling the picker shares nothing (stubbed display-media source)
    Given the application's source picker is shown
    When the user cancels it
    Then the display-capture request is denied
    And no source was chosen automatically

  Scenario: [manual-only] Screen share of a real screen or window in a real call
    Given the call window is open on a real Meet call
    When the user picks a real screen or window in the app's picker
    Then that source is shared in the call

  Scenario: [manual-only] Linux with PipeWire uses the OS picker
    Given a Linux desktop using PipeWire
    When the user starts a screen share
    Then the operating system's picker is shown and the app's picker is not
    And no source is chosen without a user action

  Scenario: [automatable] Closing the call window destroys it and does not quit the app
    Given the call window is open and the main Chat window is hidden to tray
    When the user closes the call window
    Then the call window is destroyed (not hidden)
    And the application process keeps running
    And the tray icon remains visible
    And the main Chat window remains hidden

  Scenario: [manual-only] Closing the call window releases the devices
    Given a real call with camera on and a screen shared
    When the user closes the call window
    Then the camera indicator turns off and no capture indicator remains
    And the call has ended for this participant

  Scenario: [automatable] A second Meet link focuses the existing call window (working default)
    Given a call window is open
    When the user activates another Meet link
    Then the existing call window is focused
    And no second call window is created
    And a native OS notification "A call is already open. The new link was not opened." is shown,
      even if "Mute notifications" is on
    And clicking that notification focuses the existing call window

  Scenario: [automatable] Tray Show/Hide does not affect the call window (working default)
    Given a call window is open
    When the user chooses "Show/Hide Google Chat" from the tray
    Then only the main window is shown or hidden
    And the call window stays open

  Scenario: [automatable] A non-Meet link still goes to the system browser
    Given the main window shows a Chat message with a link to any other address
    When the user clicks the link
    Then the link opens in the system browser
    And no call window is created

  Scenario: [automatable] Lookalike host does not get the call window
    Given a link whose host is not exactly meet.google.com (the cases are in NFR-07)
    When the user clicks it
    Then it opens in the system browser and no call window is created
```

**Requires a wireframe.** The screen-share source picker is a **new UI surface** (what it lists, how a
source is previewed and chosen, cancel, empty and error states). It needs a wireframe from
`ux-ui-designer` before any implementation; this document does not design it and states only the
behavioural rules above. (Under the Linux/PipeWire working default the app picker is not shown there,
which the wireframe need not cover unless the owner reverses that default or Spike B shows the
portal picker cannot be deferred to.)

**Verification — every release.** Real Meet inside Electron is unverified today (ADR-0004 Spike B:
a real call with camera, microphone and screen share, on Windows and on Linux) and is not a
documented, supported configuration for Meet, so it can break on a user-agent or embedding change on
Google's side. Every **[manual-only]** scenario above must be **re-run by hand on every release**, on a
real desktop, stating which platform was actually tested (the same discipline as sign-in under
ADR-0001). A release that has not re-verified it must say so in its release notes.

**Open questions (owner):**
- If Spike B shows Meet does not work in Electron, what does the owner want? ADR-0004 lists Meet in the
  system browser (Linux only, or everywhere), a Windows-only in-app Meet, or accepting the limitation.
- Does a Linux machine (or VM with a desktop session and a camera or virtual camera) exist for the
  Linux half of Spike B? If not, Linux Meet stays unverified.
- Please confirm or change the four working defaults above (one call window, with the native
  "call already open" notification, shown regardless of mute, on a second link; OS picker on Linux/PipeWire; tray Show/Hide acts on the main window only; indicators
  fire during a call).
- **Spike B (Linux picker):** verify that `setDisplayMediaRequestHandler` can defer to the portal
  picker without the app choosing a source automatically. If not, does the owner accept the app's own
  picker on Linux (the original decision)?

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
- The Meet call window (FR-16) is governed by NFR-07 in addition; nothing in it relaxes the
  main window's baseline above.

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

### NFR-06 — Bounded cost of the blinking tray icon (ties to FR-14)
The app runs in the tray continuously, so a redraw timer that runs forever is a real, checkable
cost, not a theoretical one:
- Exactly one blink timer exists at any time (not one per unread conversation, not one that stacks
  up across repeated start/stop/resume cycles).
- The timer is created only when blinking actually starts or resumes (per FR-14's start/resume
  condition) and is fully cleared — not merely paused — the moment blinking stops, per **FR-14's
  stop condition** (this requirement does not redefine *when* blinking stops; it only specifies how
  the timer is disciplined once that moment is reached). When there is nothing to blink, there is no
  timer running and no recurring work being scheduled at all. A new message arriving while blinking
  is already active (see FR-14) must reuse the existing timer, not create an additional one.
- Each blink tick does only an icon-image swap (`tray.setImage()`-equivalent); it does not rebuild
  the context menu, re-read settings from disk, or do any work beyond changing the displayed icon.
- The taskbar flash (FR-14) is a single operating-system request that the OS itself keeps flashing
  until focus; the application adds **no** timer of its own for it, so it does not add to the
  one-timer budget above.
- The 1-second (1000 ms) alternation interval (FR-14) is the accepted cadence; it is not so
  aggressive that it can be mistaken for a resource issue (a 1 Hz timer with a single icon swap is
  negligible on both target platforms), and it is not adjustable per this spec — a configurable
  blink rate is not requested and is out of scope.

**Checkable mechanism — decided, so this is testable rather than aspirational:** the blink timer
is owned by a single module-level handle (e.g. a `blinkIntervalHandle` variable in the tray/icon
module) that is the sole reference to the running interval:
- **Start/resume** is a no-op if `blinkIntervalHandle` is already set (reuses the existing handle
  instead of calling `setInterval` again) — this is what prevents the "new message while already
  blinking" case in FR-14 from creating a second timer.
- **Stop** always calls the equivalent of `clearInterval(blinkIntervalHandle)` and then immediately
  sets the handle back to `null`/`undefined` — never leaves a cleared-but-still-referenced handle
  lying around, and never merely toggles a "paused" flag while the interval keeps running
  underneath.
- **QA verification, both required:**
  1. An automated unit/integration test spies on the `setInterval`/`clearInterval`-equivalent calls
     (or the handle-owning module's public start/stop functions) and asserts the call counts stay
     balanced — exactly one net-active timer — across a scripted sequence of at least 20 start/
     stop/resume cycles, stated in FR-14's focus terms (covering: first unread while not focused;
     window gains focus (stop); window loses focus again without the conversation being viewed;
     second unread arrives while not focused (resume); a message while already blinking; window
     restored to visible **without** focus (must not stop); mute on/off; "Icon blinking" on/off;
     and unread-count-returns-to-zero-while-not-focused per FR-14's second stop trigger). Alongside
     the timer counts it asserts, on every cycle, that the taskbar-flash request is made on each
     start/resume and cleared on each stop (no flash left running with no unread), and that a
     same-cycle repeat "new message while blinking" event triggers zero additional `setInterval` calls.
  2. A manual/exploratory pass on a real running build: repeat the same 20-cycle sequence, moving the
     window between hidden-to-tray, minimized, visible-behind-another-window and focused, and confirm
     (via a temporary debug log line on create/clear printing the handle's identity, or the OS
     process's active-timer/handle count if the runtime exposes one) that at most one blink timer is
     ever live at a time, that the taskbar button flashes and stops as FR-14 states, and that both
     reach zero once the sequence ends with no unread messages remaining.

### NFR-07 — Security of the Meet call window (ties to FR-16)
**Priority: Must.** Mirrors the amended space rule `electron-security-baseline` (owner decision
2026-09-30, UI-01), which is the authority if the two ever differ. FR-16 is the single exception to
"external links open in the system browser"; this requirement bounds it.

- **Exact origin match.** A link gets the call window only if, after normal URL parsing, its scheme is
  `https` and its hostname is **exactly** `meet.google.com`. No suffix, substring or wildcard matching.
  Host case is normalised by URL parsing (`MEET.GOOGLE.COM` is the same host). Anything that only
  *looks* like the host is refused: a trailing dot, userinfo tricks (`meet.google.com@evil.example`),
  lookalike hosts. Per the space rule, the origin must equal `https://meet.google.com`: an explicit
  port other than the default 443 is refused, and a URL carrying userinfo is refused.
- **Wrapper unwrapping.** Only a `https://www.google.com/url?q=<target>` wrapper is unwrapped, and only
  **once**. The wrapper's own URL must be exactly that host and path; the target must be a parseable
  URL and must then pass the exact test above on its own. A wrapper without `www`, a nested wrapper
  (the target is itself a wrapper), an unparseable `q`, and a wrapper whose target is `http` or any
  other host all go to the system browser. A wrapper-shaped URL on any other host is **not**
  unwrapped.
- **Call window hardening**, checked on the `webPreferences` the call window is **created with** (and
  on its live web contents where the test can reach them): `contextIsolation` on, `nodeIntegration`
  off, `sandbox` on; it shares the main session (so the login carries over); it denies its own popups;
  its navigation is limited to `meet.google.com` and `accounts.google.com`.
- **Main-window navigation.** A Meet URL that the **main window** tries to navigate itself to
  (`will-navigate`, not just a new-window request) is intercepted and treated exactly like a link
  click: prevented in the main window and routed by these rules. All other main-window navigation is
  **out of scope** of this requirement and unchanged.
- **Permissions scoped to Meet.** Camera, microphone and display-capture permissions are granted only
  when **both** the requesting origin and the top-level page's origin are exactly
  `https://meet.google.com`, enforced in **both** the permission-request handler and the
  permission-check handler. Every other case is refused: any other origin (including the main Chat
  window's own), `http://meet.google.com`, and a Meet frame embedded inside a page that is not Meet.
  The existing notifications permission for the main window is unchanged.
- **Screen share is never automatic** — it always goes through the app's own source picker (FR-16),
  except where the operating system's picker is relied on (Linux/PipeWire working default in FR-16).
- **Closing the call window never quits the app** (FR-06/FR-07).
- **Everything else is unchanged:** every other URL still goes to the system browser; the main window's
  NFR-04 baseline is untouched; session cookies and credentials are never logged, persisted or
  transmitted by this feature.

All scenarios below are **[automatable]** (URL classification and handlers are pure decisions and can
be tested without a real Meet). The real-call checks are the **[manual-only]** scenarios in FR-16.

```gherkin
Feature: Meet call window security
  Scenario Outline: [automatable] Only the exact Meet origin opens the call window
    When the user clicks the link "<url>"
    Then the outcome is "<outcome>"

    Examples:
      | url                                                                          | outcome        |
      | https://meet.google.com/abc-defg-hij                                         | call window    |
      | https://MEET.GOOGLE.COM/abc-defg-hij                                         | call window    |
      | https://meet.google.com:443/abc-defg-hij                                     | call window    |
      | https://www.google.com/url?q=https%3A%2F%2Fmeet.google.com%2Fabc-defg-hij    | call window    |
      | http://meet.google.com/abc-defg-hij                                          | system browser |
      | https://meet.google.com@evil.example/                                        | system browser |
      | https://meet.google.com:8443/abc-defg-hij                                    | system browser |
      | https://meet.google.com./abc-defg-hij                                        | system browser |
      | https://meet.google.com.evil.example/abc                                     | system browser |
      | https://evilmeet.google.com/abc                                              | system browser |
      | https://notmeet.google.com/abc                                               | system browser |
      | https://google.com/meet                                                      | system browser |
      | https://chat.google.com/                                                     | system browser |
      | https://google.com/url?q=https%3A%2F%2Fmeet.google.com%2Fabc-defg-hij        | system browser |
      | https://www.google.com/url?q=http%3A%2F%2Fmeet.google.com%2Fabc-defg-hij     | system browser |
      | https://www.google.com/url?q=https%3A%2F%2Fwww.google.com%2Furl%3Fq%3Dhttps%253A%252F%252Fmeet.google.com%252Fabc | system browser |
      | https://www.google.com/url?q=%%%not-a-url                                    | system browser |
      | https://www.google.com/url?q=https%3A%2F%2Fevil.example%2F                   | system browser |
      | https://evil.example/url?q=https%3A%2F%2Fmeet.google.com%2Fabc-defg-hij      | system browser |

  Scenario: [automatable] The main window navigating itself to a Meet URL is intercepted
    Given the main window attempts to navigate to https://meet.google.com/abc-defg-hij
    Then the navigation is prevented in the main window
    And the call window is created for that URL

  Scenario: [automatable] The call window is hardened, checked on creation
    When the call window is created
    Then the webPreferences it is created with have contextIsolation on, nodeIntegration off and
      sandbox on
    And it uses the main session
    And a popup opened from it is denied

  Scenario: [automatable] Call window navigation is limited
    Given the call window is open on a Meet call
    When the page attempts to navigate to a host other than meet.google.com or accounts.google.com
    Then the navigation is blocked

  Scenario Outline: [automatable] Media permissions only for the Meet origin
    When a page at "<requesting>" embedded in a top-level page at "<top>" requests camera, microphone
      or display capture
    Then the request result is "<request>"
    And the permission check for the same permission reports "<request>"

    Examples:
      | requesting                | top                       | request |
      | https://meet.google.com   | https://meet.google.com   | granted |
      | http://meet.google.com    | http://meet.google.com    | denied  |
      | https://chat.google.com   | https://chat.google.com   | denied  |
      | https://evil.example      | https://evil.example      | denied  |
      | https://meet.google.com   | https://chat.google.com   | denied  |
      | https://meet.google.com   | https://evil.example      | denied  |
      | https://evil.example      | https://meet.google.com   | denied  |

  Scenario: [automatable] No automatic screen source (stubbed display-media source)
    When Meet requests display capture
    Then the app's source picker is shown
    And no source is selected without a user action

  Scenario: [automatable] Closing the call window never quits
    Given the call window is the only visible window
    When it is closed
    Then the process keeps running and the tray icon remains
```

### NFR-08 — Linux install path and executable name; declared runtime dependency (ties to FR-09)
**Priority: Must.**

- The Linux **install path and the executable file name contain no space character.**
- **In scope, derived from the above:** the FR-10 Linux autostart entry's `Exec` path must refer to
  that space-free executable path (it follows automatically, but is checked). **In scope as a working
  assumption pending the owner:** the Linux **AppImage artifact file name** contains no space
  character. **Not covered:** the directory a user chooses to put an AppImage in, and the
  user-visible product name shown in window titles and launchers (it may contain spaces).
- The `.deb` package **declares its runtime audio dependency** in its dependency metadata, so
  installing it with the system package manager pulls in the library the application needs to run
  and play sound, instead of leaving the app to fail at launch on a clean system. Which package that
  is belongs to the implementer, who must state it; it is not named here.

```gherkin
Feature: Linux packaging
  Scenario: [automatable] Install path and executable name have no spaces
    Given a release .deb has been produced
    Then the install directory path declared for the application contains no space character
    And the application's executable file name contains no space character

  Scenario: [automatable] The AppImage artifact name has no spaces (working assumption)
    Given a release AppImage has been produced
    Then its file name contains no space character

  Scenario: [automatable] The deb declares its audio runtime dependency
    Given a release .deb has been produced
    When its control metadata is inspected
    Then its dependency list includes the package providing the runtime audio library

  Scenario: [automatable] The autostart entry points at the space-free executable
    Given "Start at login" is enabled on Linux (FR-10)
    Then the autostart .desktop file's Exec path contains no space character
    And it refers to the installed executable

  Scenario: [automatable] Install and launch on a clean Debian/Ubuntu system
    Given a clean Debian or Ubuntu system without the audio library preinstalled
    When the .deb is installed with the system package manager
    Then the audio dependency is installed with it
    And the application launches without a missing-library error

  Scenario: [manual-only] Sound plays on a real Linux desktop
    Given the .deb is installed on a real Debian or Ubuntu desktop with working audio output
    When a notification with sound enabled (FR-11) is delivered
    Then the sound is audible
```

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

### Resolved — blinking tray icon and Settings window (FR-14, FR-15)
Not part of the original scope; added on explicit owner request ("I want the tray icon to blink
when there are messages, like in the old days" / "so that all this can be managed — sound, icon
blinking, and so on"). Decided rather than left open: the attention indicator (tray blink and, since
2026-09-30, taskbar flash) stops only when the main window **gains focus** (never on a timer or blink
count, and no longer merely on becoming visible) and resumes on any subsequent new message that
arrives while the window is not focused, even if it had already stopped once — FR-14 holds the full
start/resume and stop conditions and is the single authority; muted unread state stays visible but
does not blink; Settings changes apply immediately with no Save/Cancel.

**Tray menu vs. Settings — superseded decision.** An earlier draft kept the tray menu's three
existing checkboxes (Start at login, Notification sound, Mute notifications) unchanged, reasoning
that the owner shouldn't have UX they rely on removed without being asked. Asked directly, the
owner decided the opposite: only **Mute notifications** keeps a tray quick-toggle; **Start at
login** and **Notification sound** are now Settings-window-only. Icon blinking was already
Settings-only in the original design and remains so. See FR-15's "Tray menu vs. Settings window"
clause for the full reasoning and FR-07 for the resulting tray menu contents.

## Traceability

| ID | Requirement |
|----|-------------|
| FR-01 | Launch and initial window |
| FR-02 | Window state persistence |
| FR-03 | Google account authentication |
| FR-04 | Session persistence across restarts/reboots |
| FR-05 | System notifications: FR-05a delivery, FR-05b content, FR-05c click (amended 2026-09-30) |
| FR-06 | Close-to-tray |
| FR-07 | Tray icon and context menu |
| FR-08 | Single-instance behavior |
| FR-09 | Distribution installers (Windows, Linux) |
| FR-10 | Start automatically at OS login |
| FR-11 | Notification sound control |
| FR-12 | Mute notifications ("quiet hours") |
| FR-13 | Build/version diagnostic line in the tray menu |
| FR-14 | Attention indicator on unread: blinking tray icon and flashing taskbar button (amended 2026-09-30) |
| FR-15 | Settings window |
| FR-16 | Google Meet calls in an app-owned call window (new 2026-09-30) |
| NFR-01 | Cross-platform parity, with explicit exceptions |
| NFR-02 | Resource usage for an always-running tray app |
| NFR-03 | Startup time |
| NFR-04 | Security posture of an embedded Google login |
| NFR-05 | Distribution/signing reality |
| NFR-06 | Bounded cost of the blinking tray icon |
| NFR-07 | Security of the Meet call window (new 2026-09-30) |
| NFR-08 | Linux install path, executable name and declared audio dependency (new 2026-09-30) |

### Traceability of the 2026-09-30 changes

| ID | Priority | Change | Traces to |
|----|----------|--------|-----------|
| FR-05a | Must (unconditional) | Split out: a native notification appears while hidden, minimized or unfocused (BUG-01 core) | ADR-0004 Spike A; FR-11, FR-12, FR-14 |
| FR-05b | Must (conditional) | Title = chat name, body = message text; applies under owner answer (a) only | ADR-0004 Spike C; ADR-0002 piece 2; space rule `wrapper-not-a-rewrite`; open question in FR-05 |
| FR-05c | Must (step 1 unconditional, step 2 conditional) | Click brings window forward from tray/minimized; step 2 opens that conversation under (a) only; degraded outcome logged | ADR-0004 Spike C; open question in FR-05 |
| FR-06, FR-07 | Must | Scoped: close-to-tray and tray Show/Hide act on the main window only | FR-16 |
| FR-09 | Must | Prose and Linux scenario now reference NFR-08 | NFR-08, NFR-05 |
| FR-10 | Must | Linux autostart `Exec` path must be the space-free executable path (checked under NFR-08); FR-10 text itself unchanged | NFR-08 |
| FR-14 | Must | Amended: taskbar flash added; condition "hidden" becomes "not focused"; stop on focus; degraded trigger stated; working assumptions on flash, mute and the setting | ADR-0004 (S2: `flashFrame` unimplemented), FR-05a, FR-12, FR-15, NFR-06 |
| FR-16 | Must (conditional on Spike B) | New: Meet in app-owned call window, own screen-share picker | ADR-0004 Spike B; space rule `electron-security-baseline`; NFR-07; wireframe from `ux-ui-designer` still to be produced; four working defaults pending the owner |
| NFR-07 | Must | New: exact-origin match, hardened call window, permissions scoped to Meet | Space rule `electron-security-baseline` (amended 2026-09-30, UI-01); NFR-04 |
| NFR-08 | Must | New: no spaces in Linux install path/executable name; deb declares audio dependency | FR-09, FR-10, NFR-05 |

## Change log

- **2026-09-30** — Owner decisions folded in. FR-05 sharpened (notification title/body content; click
  from tray or minimized opens that conversation) and marked doubtful in mechanism after the
  service-worker finding, with the deep-link approach left as an open owner question (ADR-0004
  Spike C). FR-14 reworked: taskbar flash added, trigger and stop changed from hidden/visible to
  not-focused/focused (the earlier "becoming visible stops blinking" rule is reversed). FR-16 and
  NFR-07 added for Meet in an app-owned call window (unverified in Electron, Spike B, re-verify each
  release). NFR-08 added for Linux packaging. Scope lists updated. FR-06 and FR-07 scoped to the
  main window; FR-09 references NFR-08. FR-01..FR-04, FR-08, FR-10..FR-13 and FR-15 otherwise
  unchanged.
- **2026-09-30 (review pass)** — After adversarial review: FR-05 split into FR-05a (unconditional
  delivery), FR-05b/FR-05c (conditional on Spike C and the owner's answer), with a table of what
  applies under each answer, the degraded-outcome logging defined, the tray unread indicator restated
  as a single global observable state, "with that message visible" dropped (the owner said "open that
  chat"), and the earlier mechanism text demoted to history. FR-14 gained a stated dependency on the
  FR-05 mechanism and a degraded trigger, working assumptions for the flash, and mute-off behaviour.
  FR-16 tagged scenarios automatable or manual-only, defined destroy-on-close and the scope of Chat's
  own Join buttons, and recorded four working defaults. NFR-06's QA sequence restated in focus terms.
  NFR-07's matrix widened. NFR-08 scoped. Stale "becomes visible" wording removed from the Risks
  section.

- **2026-09-30 (second review pass)** — FR-05a's static unread indicator made independent of focus
  (consistent with FR-14). FR-05 and FR-14 scenarios tagged automatable or manual-only. FR-16: a
  second Meet link now tells the user it was not opened; the Linux/PipeWire default is tied to a Spike
  B check and an open question because it departs from "the app's own picker". NFR-07's port/userinfo
  rule stated as the space rule's, without hedge. Design docs added to the superseded list; FR-15 gained
  the label question; FR-09 and FR-10 added to the changes table.

### Downstream docs superseded

These documents still describe rules this requirements document has changed. They are **not
authoritative where they conflict**; `tech-lead` is to update them after the owner approves this
document.
- [tray-lifecycle.md](../architecture/tray-lifecycle.md) — the blink start/stop rules ("hidden" /
  "becomes visible", including its `applySetting` and stop-condition sections) and the tray
  Show/Hide behaviour now conflict with FR-14 (focus-based, plus the taskbar flash) and FR-07.
- [notifications.md](../architecture/notifications.md) — the page-`Notification` bridge mechanism, the
  Page Visibility dependency and the click-to-conversation mechanism now conflict with FR-05 (three
  parts, the service-worker finding, conditional content and click).
- [00-settings-surface-spec.md](../design/00-settings-surface-spec.md) — the "Blink tray icon on
  unread" label (lines 127, 154, 171), the §9 tray-only blink state machine (hidden/visible triggers,
  no taskbar flash) and the mute note now conflict with FR-14. **Owner decision needed:** if the
  "Icon blinking" setting also governs the taskbar flash (working assumption), its label in FR-15 and
  the Settings window must change to say so (for example "Flash and blink on new message"); if the
  flash gets its own setting, FR-15 gains a control and needs a wireframe.
- [01-settings-wireframes.md](../design/01-settings-wireframes.md) — repeats the same label
  (lines 36, 76, 116, 138), the same "Blinks on a new message; stops…" helper text, and a state table
  whose stop trigger is "window becomes visible"; both conflict with FR-14. `02-rationale.md` cites
  the same rules (its proposed "FR-14" text) and needs the same check.
- To be checked by `tech-lead` for the same reason (not verified here): ADR-0002 piece 2 and its
  fallback (ADR-0004 already touches them), `ipc-contract.md`, and `packaging-release.md` (NFR-08).

Later design/test artifacts should cite these IDs directly (e.g. "implements FR-05", "covers
NFR-04") rather than re-describing the requirement.
