# Requirements — Google Chat Desktop Wrapper

## Purpose

A personal-use Electron desktop application that wraps the existing Google Chat web app
(`https://chat.google.com/`) so it behaves like a native desktop chat client:
stays logged in, delivers OS-level notifications for new messages even when the window is
closed/hidden, and lives in the system tray instead of quitting on close.

This is a **single-user personal utility**. It is scoped, specified, and will be tested
accordingly — not as a multi-user or distributable product, even though installers for two
platforms are produced.

**Target platforms: Windows and Linux only.** macOS was dropped from scope by explicit maintainer
decision — see [ADR-0003](../adr/0003-packaging-and-code-signing-approach.md): macOS notifications
require a code-signed app (confirmed against `electronjs.org/docs/latest/api/notification`), the
maintainer does not use macOS, and paying for an Apple Developer Program membership (US $99/year) to
make a platform work that nobody will run was not justified.

## Scope

**In scope:**
- Electron shell that loads the Google Chat web app in a native window.
- Google account authentication that persists across restarts/reboots (no repeated login).
- OS-native notifications for new Google Chat messages, delivered even when the window is
  closed to tray, opening that conversation when clicked (target; conditional on an open maintainer decision — see FR-05).
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
- Google Meet calls opened from Chat in an app-owned call window that contains only the Meet page, with
  camera, microphone and screen share through the application's own source picker (FR-16, NFR-07); native
  confirmations before closing the window or exiting during a live call, a native dialog if the Meet page
  crashes, and a tray entry to bring the call window forward (FR-07, FR-16).
- External links open in the system browser only for `http`, `https` and `mailto`; any other scheme is not
  opened (FR-16, NFR-07).
- Links to Google services (Drive, Docs, Calendar and so on) opened in app-owned windows that share the signed-in
  session, and a Chat conversation link loaded in the main window (FR-17).
- Smart copy: right-click on a link copies its URL and releasing the mouse after selecting text copies the
  selection (main Chat window only), each with a short hint next to the cursor (FR-18).
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
  beyond the one configured entry URL. (The accepted exceptions to "one window" are the Meet call window of
  FR-16 and the per-link Google app windows of FR-17 (2026-10-04), which open only the fixed Google host list.)
- Auto-update infrastructure (not requested; can be added later as a separate requirement).
- Mobile builds.
- Accessibility/localization work beyond what Chromium/the Google Chat web app already provides.
- Automated code signing/notarization pipeline setup — see NFR-05 for what distribution actually
  looks like given the constraints established below.

## Functional Requirements

### FR-01 — Launch and initial window
The application launches a single native window that loads
`https://chat.google.com/` as its start URL. The window is resizable, has a
sensible default size on first launch (e.g. 1200×800), and is not a fixed/fullscreen-only window.

```gherkin
Feature: Application launch
  Scenario: First launch with no prior state
    Given the application has never been run on this machine
    When the user starts the application
    Then a single window opens
    And the window loads https://chat.google.com/
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

Accounts that sign in through the organisation's own identity provider (single sign-on) are covered by FR-19.

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
*Amended 2026-09-30 (maintainer decisions). FR-05 is now three parts with different certainty. Part A is
unconditional. Parts B and C partly depend on ADR-0004 Spike C and on a maintainer decision that has not
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

#### FR-05b — Notification content (target; conditional on Spike C and the maintainer's answer)
The maintainer requires the notification to show **which chat the message is from**: the chat name (the
sender's name for a direct message) as the title and the message text as the body. A notification
showing only generic text (for example "N new messages") does not meet this part.

#### FR-05c — Click behaviour
Clicking a notification does two things:
1. **(Unconditional)** The application window is brought to the front and given focus, **including
   when it was hidden to the tray or minimized** (restored from the tray if hidden).
2. **(Conditional on Spike C and the maintainer's answer)** The application shows **that conversation** —
   not whichever conversation happened to be open before. The maintainer's words are "open that chat".
   Scrolling to the specific message is **not** required; see the stretch question below.

**Degraded outcome — defined.** If the conversation cannot be determined, the window still comes to the
front and focused (step 1), and the app writes a **warning-level entry to its persistent application
log** stating that a notification click could not be resolved to a conversation. "Visibly" means
findable in that log by the maintainer or a tester; no on-screen message is required. It must never be
silent, so a degraded click is never mistaken for the feature working.

#### What applies under each maintainer answer
| Element | Under (a) — bounded second source accepted | Under (b) — generic content, focus-only click |
|---|---|---|
| FR-05a delivery | Applies | Applies |
| FR-05b content (chat name title, message body) | Applies | **Does not apply**; generic text is the accepted content and this document is amended |
| FR-05c step 1 (bring forward, from tray/minimized) | Applies | Applies |
| FR-05c step 2 (open that conversation) | Applies | **Does not apply**; amended |
| Degraded-outcome logging | Applies to any unresolved click | Not needed — the focus-only click is then the standard behaviour, not a degradation |

Until the maintainer answers, the conditional scenarios below are the **target** and are written as such; a
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

  # ---- FR-05b: conditional on Spike C + maintainer answer (a) ----
  Scenario: [manual-only] [conditional - applies under (a)] Title names the chat and body is the message
    Given a new message arrives in the direct message with "Olena"
    When the OS-native notification is shown
    Then its title is "Olena" and its body is the message text

  Scenario: [manual-only] [conditional - applies under (a)] Notification in a group space names the space
    Given a new message arrives in the group space "Team Alpha" from a sender "Olena"
    When the OS-native notification is shown
    Then its title identifies the chat ("Team Alpha", with or without the sender's name)
    And its body is the message text

  # ---- FR-05c step 2: conditional on Spike C + maintainer answer (a) ----
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

**Open question (maintainer decision; not decided here) — how to reach the right conversation.** ADR-0004
states the choice the maintainer will face once Spike C reports (what Chat's notification actually carries,
and whether a conversation identifier is reachable without scraping):
- **(a)** accept a bounded second source for this one purpose (the document title / unread state, or
  reading the page) — which touches the *Wrapper, not a rewrite* project rule; or
- **(b)** accept generic notification content and a click that only brings the window forward.

Sub-questions: if only the sender is known and the message is in a group space, is a sender-only title
acceptable, or must the space name be shown? **Stretch question:** should a click also scroll to the
specific message, or is opening the chat enough? (The maintainer said "open that chat"; scrolling is
excluded unless the maintainer asks for it.)

#### History — superseded mechanism notes (not normative)
*Kept so a reader does not re-derive them. The current mechanism is undecided; these describe what was
believed and what happened, and the downstream architecture docs that cite them are listed as
superseded in the [change log](#change-log).*

- **Earlier design, corrected after real-machine testing.** The design assumed Google Chat calls the
  standard Web Notifications API when the tab is backgrounded and that Electron bridges those calls to
  the OS while the renderer stays alive **and** Chat's own `document.visibilityState` reports the
  window as hidden. An earlier revision set `backgroundThrottling: false`, which pins `visibilityState`
  at `"visible"`, so Chat suppressed every notification while hidden. Caught in the maintainer's real test
  and traced by the implementer; see [ADR-0002](../adr/0002-notification-delivery-mechanism.md)
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
- **Show call window** — present **only while a Meet call window (FR-16) exists**; first entry in the
  menu. Restores it if minimized, raises and focuses it, and never touches the main Chat window. When the
  screen-share source picker is open, focus goes to the picker (the window that can take input). Absent
  when no call window exists, so the menu is unchanged then. (Maintainer decision 2026-10-01, P3.) It earns its
  place because a call window buried behind other windows is otherwise reachable only through the OS
  window switcher, and the tray is pointer-only. Wording: [design 06](../design/06-meet-native-wording.md).
- **Show/Hide Google Chat** — toggles the **main Chat window's** visibility (mirrors double-click on
  the tray icon). While a Meet call window (FR-16) is open it acts on the main window only and never
  hides or closes the call (working default, not yet confirmed by the maintainer — see FR-16). It earns its place
  because close-to-tray (FR-06) removes the taskbar window as the way to bring it back on some
  platforms/configurations, so the tray needs its own explicit way back in.
- **Mute notifications** — checkbox toggle; see FR-12. This is the **only** preference checkbox
  that remains on the tray menu — see FR-15's "Tray menu vs. Settings window" decision for why
  Start at login and Notification sound were moved to the Settings window instead.
- **Settings…** — opens the Settings window (see FR-15), where Start at login, Notification sound,
  and Icon blinking (FR-14) are managed.
- **Exit** — the only action that actually terminates the application process. **While a live call exists
  it first asks for confirmation** (maintainer decision 2026-10-01, P2; a native OS dialog, wording in
  [design 06](../design/06-meet-native-wording.md)): if a call window exists, Exit first treats it as a
  close attempt; only when the call page objects to being closed (a *live call*, as defined in FR-16) does
  the dialog "Exit Google Chat Desktop?" appear, with **Exit** and **Cancel** (Cancel is the default and
  the Escape answer). With no call window, or a call page that does not object, Exit terminates the
  application at once. If the screen-share picker is open, it is closed as part of exiting and its request
  is denied (nothing is shared); if the user then cancels the Exit dialog, the picker stays closed.
  **Exit is never silently ignored:** if the close dialog of the call window (P1, FR-16) is open when Exit
  is chosen, P1 is dismissed (answered as "Keep window open") and P2 is shown; if the native P1 cannot be
  dismissed programmatically, P1 is focused and P2 is shown as soon as P1 is answered. If P2 is already
  open, choosing Exit again focuses it and does not open a second one. The dialog never blocks an
  operating-system shutdown, and it is the only added step: Exit is still the only way to quit.

The build/version diagnostic line (FR-13) is also part of this menu, placed last after a
separator — it is not a preference control and is listed separately in FR-13.

The application does **not** provide a way to quit from within the web page itself (no in-page
Exit control) — Exit is reachable only via the tray context menu, per the maintainer's explicit
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

  Scenario: [automatable] Exit asks first while a live call exists (stubbed page that objects to unload)
    Given a call window is open and its page objects to being closed
    When the user selects "Exit" from the tray context menu
    Then a native dialog "Exit Google Chat Desktop?" is shown with "Exit" and "Cancel"
    And "Cancel" is the default and the Escape answer
    When the user chooses "Exit"
    Then the application process terminates and the tray icon disappears
    When the user instead chooses "Cancel"
    Then the application keeps running and the call window is unchanged

  Scenario: [manual-only] Exit asks first in a real live call, and not after Leave
    Given the call window is open on a real Meet call the user has joined and interacted with
    When the user selects "Exit" from the tray context menu
    Then the dialog "Exit Google Chat Desktop?" is shown
    When the user instead leaves with Meet's own Leave button and then selects "Exit"
    Then the application terminates without a dialog

  Scenario: [automatable] Exit while the close dialog is open is never ignored
    Given a call window is open, its page objects to being closed, and the dialog
      "Close the call window?" is shown
    When the user selects "Exit" from the tray context menu
    Then the close dialog is dismissed (or, if it cannot be dismissed, focused) and the call window
      stays open
    And the dialog "Exit Google Chat Desktop?" is shown (immediately, or as soon as the close dialog
      is answered)
    When the user selects "Exit" from the tray context menu again while that dialog is shown
    Then the existing dialog is focused and no second one is opened

  Scenario: [automatable] Exit with the source picker open
    Given a call window is open with the source picker open
    When the user selects "Exit" from the tray context menu
    Then the source picker is closed as part of exiting and its request is denied, and no source is shared
    And the normal Exit rules apply: a live call gets the "Exit Google Chat Desktop?" dialog,
      otherwise the application terminates without one
    When the Exit dialog is cancelled
    Then the picker is not reopened and the call window stays open

  Scenario: [automatable] Exit is unchanged when there is no live call
    Given no call window exists, or its page does not object to being closed
    When the user selects "Exit" from the tray context menu
    Then the application process terminates without a dialog

  Scenario: [automatable] Show call window from the tray
    Given a call window is open behind other windows
    When the user selects "Show call window" from the tray menu
    Then the call window is restored, raised and focused (the picker, if one is open, takes focus)
    And the main Chat window is unchanged

  Scenario: [automatable] The entry is absent without a call window
    Given no call window exists
    When the user opens the tray menu
    Then the menu contains no "Show call window" entry
    And when a call window is created the entry appears, and when it is destroyed the entry disappears
```

**Resolved (was an open question):** the original draft of this document left "mute notifications"
and "start on login" out as unrequested speculative scope. The maintainer has since explicitly asked for
both, plus notification sound control — see FR-10, FR-11, FR-12 below. Of the three, only **Mute
notifications** is reflected in the tray menu list above; Start at login and Notification sound are
managed exclusively from the Settings window introduced by FR-15 (a later, explicit maintainer decision
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
Installable packages are produced for **Windows and Linux** (macOS is out of scope — maintainer
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

**Default — on (maintainer decision 2026-09-30).** After a fresh installation, the first run enables Start
at login, so the application launches hidden into the tray at every subsequent login without the user
visiting Settings. This default is applied **once, on the first run of a fresh install, and only when
no stored choice exists**. It never overrides a choice the user already made: a stored "off", or a
startup entry the user disabled outside the application (for example in the Windows Task Manager
"Startup apps" list), is respected, and the application does not re-enable it on later launches or
after an update. The full set of first-run defaults is in FR-15.

```gherkin
Feature: Start at login
  Scenario: First run of a fresh install enables start at login
    Given the application has just been installed and has never been run (no stored preferences)
    When the application runs for the first time
    Then the OS is configured to launch the application automatically at login, into the tray
    And the Settings window shows "Start at login" as checked

  Scenario: An existing user choice is preserved
    Given the user previously turned "Start at login" off in Settings
    Or the user disabled the application's startup entry in the Windows Task Manager
    When the application is launched again, including after an update or reinstall over the same data
    Then the application does not re-enable Start at login
    And the OS startup state and the Settings checkbox are unchanged

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

**Design decision — "quiet hours" and "mute" are the same feature, deliberately.** The maintainer's
ask named both terms; this spec treats them as one manual, persistent-until-toggled tray checkbox
rather than a scheduled time-window feature (e.g. "silence 22:00–08:00 automatically"). Rationale:
a scheduled quiet-hours UI (time pickers, per-day schedules, timezone handling) is real added
complexity disproportionate to a single-user personal utility, when a manual toggle achieves the
practical need the maintainer described ("a tray menu entry to temporarily silence notifications") with
far less surface. If the maintainer later wants a scheduled version, that is a distinguishable follow-up
requirement, not assumed here.

### FR-13 — Build/version diagnostic line in the tray menu
The tray context menu shows a disabled (non-clickable), visually de-emphasized line identifying the
exact build that is currently running: the app version, whether it is a packaged install or a dev
run from source, and a build timestamp. Placed last in the menu, after a separator, so it never
competes with the actual controls above it.

**Origin:** maintainer request, made mid-investigation of the FR-05 notification failure recorded in
[ADR-0002](../adr/0002-notification-delivery-mechanism.md). Diagnosing that failure lost a full
round to manually working out whether an installed build and a dev run from source were
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
maintainer's actual need ("can I tell this is the current build") without adding new build tooling.

### FR-14 — Attention indicator on unread: blinking tray icon and flashing taskbar button
**Priority: Must.** *Amended 2026-09-30 (maintainer decision): extended from "tray blink while hidden" to
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
the main Chat window focused, so a new message still triggers the indicator (maintainer decision,
2026-09-30).

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

  Decision rationale: the maintainer's stated intent is to have the shell "draw my eye when messages
  arrive". An attention signal tied to the *arrival event*, not to a stale "still have something
  unread" fact, is what serves that. The maintainer extended it to the taskbar button because a window
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

**Working assumption (not a maintainer decision): mute also suppresses the taskbar flash.** The maintainer
decided mute for the tray blink; extending it to the flash follows the same "don't poke me" logic but
was not stated. Pending the maintainer's confirmation.

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
trigger 3). **Maintainer decision (2026-09-30):** the one "Icon blinking" setting governs **both** the tray
blink and the taskbar flash; a separate flash setting is not provided.

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
    And the taskbar button does not flash [maintainer decision: one setting governs both]

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

**Maintainer decisions (2026-09-30):** (1) "Icon blinking" governs both the tray blink and the taskbar
flash; (2) while the user is in the Meet call window (FR-16) or the Settings window, a new chat message
still triggers the indicators (and notifications, FR-05a), because the main Chat window is not focused.

**Working assumptions pending the maintainer (not decisions):** (a) mute also suppresses the flash; (b)
turning mute or blinking back on does not start the indicators until the next arrival.

### FR-15 — Settings window
A dedicated Settings window consolidates preference management in one place, replacing the
tray context menu's role as the only place some of these are reachable, and giving the newly
added icon-blinking preference (FR-14) somewhere to live without growing the tray menu further.

**Covers, at minimum:** Start at login (FR-10), Notification sound (FR-11), Mute notifications
(FR-12), Icon blinking (FR-14).

**Maintainer decision (2026-09-30), from FR-14:** the "Icon blinking" setting also governs the taskbar
flash, so its label must say so, because "Icon blinking" no longer describes what it does. The
exact label wording is for the designer to propose; no separate flash control is added. FR-15 is
otherwise unchanged.

**Tray menu vs. Settings window — decided by the maintainer directly (supersedes the earlier draft):**
an earlier draft of this document kept all three existing tray checkboxes (Start at login,
Notification sound, Mute notifications) unchanged, on the reasoning that removing UX the maintainer
already relies on without asking first is against standing practice. That reasoning was sound, so
rather than guess, the maintainer was asked directly which way to resolve it — and decided the opposite
of the earlier draft's default:
- **Mute notifications** is the **only** setting that keeps its tray-menu quick-toggle. It is the
  one preference realistically toggled in the moment (silence notifications right now), which is
  exactly what a one-click tray checkbox is for.
- **Start at login** and **Notification sound** are removed from the tray menu and are now
  **Settings-window-only** controls — these are "set occasionally, not reacted to in the moment"
  preferences, and belong with the rest of Settings rather than splitting the same class of control
  across two places.
- **Icon blinking** (FR-14) was already Settings-only in the original design and remains so — the
  maintainer's own framing of this feature ("so that all this can be managed... instead of an
  ever-growing tray menu") is the reason new preferences go to Settings, not the tray, from here on.

The tray menu therefore carries exactly one preference checkbox (Mute notifications) plus a new
**"Settings…"** entry that opens this window. See FR-07 for the resulting tray menu contents.

The build/version diagnostic line (FR-13) is **not** moved into Settings — it is a diagnostic
display, not a user preference, and stays where FR-13 already placed it (last entry in the tray
menu). See "Read-only version/About line" below for the separate, Settings-window-only About line
this design also introduces.

**No native OS application menu — decided.** the designer proposed adding a native OS
application-menu entry point (a `Settings…` item under a standard app menu, with an `Ctrl+,`
accelerator) as a second way to open Settings, and correctly flagged it as unauthorized by any
requirement pending ratification. **Decision: rejected — Settings opens only from the tray menu, and
no application menu is present at all.** Rationale:
- The maintainer never asked for a second entry point to Settings; the tray menu's existing
  "Settings…" entry (see above and FR-07) is sufficient.
- Electron installs a default application menu (including a default Quit/Exit item) unless it is
  actively suppressed — introducing an application menu, even for a single harmless item, creates
  the single most likely way to reintroduce a second quit path into this application, which
  directly conflicts with the "Exit is reachable only via the tray context menu" requirement (see
  FR-07, "the application does **not** provide a way to quit from within the web page itself... Exit
  is reachable only via the tray context menu, per the maintainer's explicit requirement"). A carefully
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
is overhead this app's usage pattern (maintainer adjusts their own settings occasionally) doesn't
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

**First run, no saved preferences — everything is on except mute (maintainer decision 2026-09-30):** the
Settings window (and the tray menu's Mute checkbox) show these defaults:
- Start at login: on (launching hidden into the tray; FR-10)
- Notification sound: on
- Mute notifications: off (quiet mode stays off)
- Icon blinking: on (the feature exists specifically to be seen; defaulting it off would mean most
  users never discover it)

These defaults apply only on the first run of a fresh install, when no stored choice exists for the
setting. They never override a choice the user already made, including a startup entry disabled in the
Windows Task Manager; such a choice is respected on every later launch.

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
    Then Start at login is on, Notification sound is on, Mute notifications is off, and Icon
      blinking is on
    And the OS is configured to launch the application at login, into the tray

  Scenario: Existing user choices are not overridden by the first-run defaults
    Given stored preferences exist with Start at login off, Notification sound off and Icon blinking
      off
    When the application is launched again
    Then the Settings window shows those same stored values
    And no default is re-applied over them

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
of scope for this document — a designer owns that. This requirement specifies what must be
manageable, how it opens, when it takes effect, and where it persists, not what it looks like.

### FR-16 — Google Meet calls in an app-owned call window
**Priority: Must** (maintainer-requested 2026-09-30). **Scope cut to the minimum on 2026-10-02** (see the
change log): the call window contains only the Meet page; the one surface the application draws itself is
the screen-share source picker. Real Meet inside Electron is an unsupported configuration; see
"Verification — every release" below and
[ADR-0004](../adr/0004-desktop-shell-technology-and-electron-retention.md) (Spike B).

When the user opens a Google Meet call link from Chat, the call opens in an **app-owned call window**
instead of the system browser, and the call works inside it:
- **Camera, microphone and screen share must work** in the call window.
- **The Google login carries over** — the call window shares the app's signed-in session (FR-04), so there
  is no second sign-in.
- **The window holds only the Meet page.** No app-drawn view, status strip, banner or panel is placed in
  or over it. Whatever Meet shows (including its own errors) is what the user sees.
- **One call window at a time** (singleton). A second Meet link never opens a second window; see "Second
  Meet link".
- **Closing the call window destroys it** — never hides or keeps it alive — which ends the call for this
  participant and **releases the camera, microphone and any screen capture**. It never quits the
  application and does not close or hide the main Chat window (FR-06's close-to-tray applies to the main
  window only). During a live call the user is asked first, see "Closing and quitting during a call".
- **Only `https://meet.google.com` gets this treatment.** Every other link opens in the system browser.
  The exact matching rule and the window's hardening are in NFR-07.
- **Links clicked inside the call window.** Navigation in the call window is limited to `meet.google.com`
  and `accounts.google.com`. A link to any other address opens in the **system browser** (as from the main
  window), and the call window stays where it is; it never opens a second window. A Meet link clicked
  inside the call window follows the second-link rule below. No message is shown for a routed link.
- **Which links the application opens outside itself** (main window and call window alike): only
  **`http`, `https` and `mailto`** are handed to the operating system. Any other scheme (`file:`,
  `ms-settings:` and so on) is not opened and creates no window. The Meet test of NFR-07 runs first.
- **Notifications and attention indicators keep arriving during a call** (FR-05a and FR-14 still fire,
  because the main Chat window is not focused).

**Definitions (each defined once).**
- **Call window exists** — it has been created and not yet destroyed.
- **Meeting on screen** — the call window shows a Meet page that is *not* a known non-meeting page. The
  known non-meeting pages are: `accounts.google.com`; `meet.google.com` at path `/` or `/landing`; and a
  page that failed to load or whose process crashed. Defined by exclusion on purpose: an address the rule
  does not recognise counts as a meeting, so a running call is never navigated away by mistake.
- **Live call** — Meet's page *objects to being closed* (it asks the browser engine to block unloading,
  the "Leave site?" behaviour of a Meet tab). It is observed only at the moment of a close attempt. If the
  signal is missing or unobservable (the page does not object, never answers within the timeout, or the
  user has not yet interacted with the page), the call is treated as **not live**: no confirmation, the
  window closes or the application exits at once. The cost is one unguarded close; the opposite error
  would prompt at the end of every call. Whether real Meet raises the objection during a call is **not yet
  observed** (Spike B used a stand-in page); the maintainer-run check is part of the verification below.

**Known limitation — back-to-back meetings (kept, not fixed).** Meet's own end page ("You left the
meeting") has the **same address** as the meeting, so address-only detection counts it as a meeting on
screen. If the user leaves a call and, with the call window still open, clicks the next Meet link in Chat,
that link is **not loaded** (the window is only focused) and the notification "A call is already open. The
new link was not opened." is shown, which is false. The user must close the call window and click the link
again. Accepted as a documented limitation for this scope; a fix would need a non-destructive reading of
the live-call signal, which is not available today (it is observed only at a close attempt).

**What counts as "a Meet link from Chat".** Any Meet link the user activates inside the main Chat window:
a link in a message, Chat's own **Join / Meet buttons**, and calendar or meeting cards, whether the page
opens it as a new window or navigates the main frame to it (the main-frame case is intercepted, NFR-07).
A Meet link opened from outside the application is not the application's to route.

**Second Meet link** (maintainer decision 2026-09-30, revised 2026-10-01). Activating a Meet link while a call
window exists never opens a second window:
- **Meeting on screen** → the existing window is restored if minimized, raised and focused, and the
  existing call is **not** navigated. The user is told by a native OS notification, "A call is already
  open. The new link was not opened.", shown **regardless of mute** (app status, not a chat message).
  Clicking it focuses the call window. The action is never silent.
- **No meeting on screen** → the new link is **loaded into the existing window**, which is raised and
  focused. No notification (it would be false).

**Permissions.** Camera, microphone and screen capture are granted only for `https://meet.google.com`
(NFR-07).

**Screen-share source picker** (the one app-drawn surface; layout and states in
[design 05](../design/05-meet-source-picker.md)). When Meet requests a screen or window, the application
shows its own picker:
- It is **modal to the call window** and has a **loading state** (listing sources takes 3 to 8 s on
  Windows, measured in Spike B, so the picker must show at once and never look frozen).
- **Cancel (button, Escape, close) denies the request**; nothing is shared.
- **A source is never selected automatically or pre-selected.** The user picks one and presses Share.
- On **Linux the application's own picker is used**. Using the desktop portal's picker instead is not part
  of this scope: it could not be tested in WSLg and stays unverified until checked on native GNOME and KDE.
  If it is ever enabled, the user must still choose explicitly and nothing may be pre-selected.
- Screen share does not work when the application runs elevated (Administrator) on Windows (Spike B); the
  release notes say so.

**Closing and quitting during a call.** The close routes are the title-bar X, Alt+F4 and the taskbar
close. Confirmations are **native operating-system dialogs**; wording in
[design 06](../design/06-meet-native-wording.md).
- **P1 — close during a live call.** Page does not object (not live) → the window is destroyed at once, no
  dialog. Page objects (live call) → native dialog "Close the call window?" with **Close window** and
  **Keep window open** (default and Escape answer). *Close window* overrides the objection for this close
  and destroys the window (devices released); *Keep window open* leaves it open and focused.
- **P2 — tray Exit during a live call** (FR-07): native dialog "Exit Google Chat Desktop?" with **Exit**
  and **Cancel** (default and Escape answer). Without a live call, Exit terminates at once.
- **P3 — tray entry "Show call window"** (FR-07).
- **Meet's unload objection never silently blocks a close or a quit** (Spike B, ADR-0004: with no handler,
  an objecting page makes close and quit do nothing, with no UI). Every app-initiated close ends in
  exactly one of: the window destroyed; a confirmation shown and answered; or, with the picker open, the
  picker raised and focused. A quit started while a call page objects overrides the objection, so quitting
  is never cancelled silently, and the confirmation never blocks an OS shutdown.
- **Page never answers** the close check within a timeout (proposed 3 seconds, to be fixed from a real
  call) → treated as not live; the window is destroyed. During that bounded wait nothing is shown; it is
  the one permitted quiet moment and it ends by itself with the window destroyed.
- **While the source picker is open** the call window does not close: the picker is raised, focused and
  flashed once. Tray Exit is the exception: it closes the picker first (request denied, nothing shared)
  and then applies the normal Exit rules.
- **Exit while P1 is open is never ignored.** If P1 can be dismissed programmatically it is dismissed (as
  *Keep window open*) and P2 is shown. If the native P1 cannot be dismissed programmatically, P1 is
  focused and the Exit request is remembered; P2 is shown as soon as P1 is answered (if the answer was
  *Close window* the call is gone and the remembered Exit proceeds under the normal rules). Choosing Exit
  while P2 is already open focuses it and does not open a second one.
- **The override applies only to closes the application initiates.** A navigation the Meet page starts
  itself (reload, Meet-internal navigation) is not overridden; what the user then sees is unverified.

**Meet page crash.** When the Meet page's process ends unexpectedly, the application shows a native dialog
"The call window stopped working" with **Reload** and **Close window** (wording in design 06). *Close
window* destroys the window with no further confirmation; *Reload* reloads the same Meet address. An open
source picker is closed and its request denied. No app-drawn crash panel exists.

**Open question (maintainer): page load failure.** With no app-drawn panel, a Meet page that fails to load
shows whatever the browser engine shows for a failed load (typically a blank page). The window can be
closed, and clicking the Meet link again loads it into the existing window (no meeting on screen). No
dialog is specified because none was requested. Is that acceptable, or should the load failure also get a
native dialog like the crash?

**Working default, not confirmed (an assumption):** tray "Show/Hide Google Chat" acts on the main window
only while a call is open and never hides or closes the call window; the call window is reached by "Show
call window".

Each scenario is tagged **[automatable]** (unit/integration test, with real Meet replaced by a stub page
or stubbed handlers) or **[manual-only]** (needs a real Meet call, real devices and a real desktop).

```gherkin
Feature: Google Meet calls in an app-owned call window
  Scenario: [automatable] Open a Meet link from Chat
    Given the user is signed in and the main window shows a Chat message with a Meet link
      on https://meet.google.com
    When the user clicks the link
    Then a call window owned by the application is created for that URL
    And the system browser is not opened
    And the call window uses the same session as the main window

  Scenario: [automatable] Chat's own Join button and a calendar card open the call window
    Given the main window shows a Join button or a calendar card whose target is a Meet URL
    When the user activates it
    Then the call window is created and the system browser is not opened

  Scenario: [automatable] The main frame navigating to a Meet URL is intercepted
    Given the main window is about to navigate itself to a Meet URL
    Then the navigation is prevented in the main window
    And the call window is created for that URL instead

  Scenario: [automatable] The call window contains only the Meet page
    When the call window is created
    Then it contains one web page, the Meet page, and no other view, strip or panel drawn by the app

  Scenario: [manual-only] Login carries over, and camera, microphone and screen share work in a real call
    Given the user is signed in to the application
    When a real Meet call link is opened and the user joins
    Then the call loads signed in with no Google sign-in prompt
    And the other participants receive the user's video and audio
    And a real screen or window chosen in the app's picker is shared

  Scenario: [automatable] Screen share shows the app's picker and shares nothing until the user chooses
    Given the call window requests display capture and a stubbed list of sources is supplied
    Then the picker is shown at once in its loading state and then lists the stubbed sources
    And no source is returned to the page until the user selects one and presses Share

  Scenario: [automatable] Cancelling the picker denies the request
    Given the source picker is shown
    When the user presses Cancel, presses Escape or closes the picker
    Then the display-capture request is denied and nothing is shared

  Scenario: [automatable] Linux uses the application's own picker
    Given the application runs on Linux
    When Meet requests display capture
    Then the application's source picker is shown

  Scenario: [automatable] Closing the call window destroys it and does not quit the app (no live call)
    Given the call window is open and Meet's page does not object to being closed
    And the main Chat window is hidden to tray
    When the user closes the call window
    Then no confirmation is shown
    And the call window is destroyed (not hidden)
    And the application process keeps running, the tray icon remains and the main window stays hidden

  Scenario: [automatable] A live call asks before the window closes (stubbed page that objects to unload)
    Given the call window shows a page that objects to being closed
    When the user closes the call window
    Then a native dialog "Close the call window?" is shown with "Close window" and "Keep window open"
    And "Keep window open" is the default and the Escape answer
    When the user chooses "Keep window open"
    Then the call window stays open and focused
    When the user closes the call window again and chooses "Close window"
    Then the call window is destroyed and the application keeps running

  Scenario: [manual-only] In a real call the close dialog appears, and after Leave it does not
    Given the call window is open on a real Meet call the user has joined and interacted with
    When the user closes the call window
    Then the dialog "Close the call window?" is shown
    When the user instead leaves with Meet's own Leave button and then closes the call window
    Then the call window is destroyed without a dialog

  Scenario: [automatable] A missing signal, no interaction, or a hung page closes without a dialog
    Given the shell cannot tell whether the page objects, or the page objects only after user
      interaction and the user has not interacted, or the page never answers the close check
    When the user closes the call window
    Then (after at most the timeout, proposed 3 seconds, in the hung-page case, during which nothing
      is shown) the call window is destroyed without a confirmation

  Scenario: [automatable] An objecting page never silently blocks a close or a quit (invariant)
    Given a call window whose page objects to being unloaded
    When the user closes the call window by any route (title-bar close, Alt+F4, taskbar close)
    Then exactly one of these happens: the window is destroyed, or the dialog is shown
      (or, with the picker open, the picker is raised)
    When the application quits by any path (including an operating-system shutdown)
    Then the objection is overridden and the quit completes

  Scenario: [automatable] Closing is not silent while the source picker is open
    Given the call window has the source picker open
    When the user tries to close the call window
    Then the call window does not close
    And the source picker is raised, focused and flashed

  Scenario: [manual-only] Closing the call window releases the devices
    Given a real call with camera on and a screen shared
    When the user closes the call window
    Then the camera indicator turns off and no capture indicator remains
    And the call has ended for this participant

  Scenario: [automatable] A second Meet link while a meeting is on screen focuses the existing window
    Given a call window is open and shows a meeting
    When the user activates another Meet link
    Then the existing call window is restored if minimized, raised and focused
    And no second call window is created and the existing call is not navigated
    And a native OS notification "A call is already open. The new link was not opened." is shown,
      even if "Mute notifications" is on
    And clicking that notification focuses the existing call window (the picker, if one is open)

  Scenario: [automatable] A second Meet link while no meeting is on screen loads into the existing window
    Given a call window is open showing a Google sign-in page, the Meet landing page, a failed load or a
      crashed page
    When the user activates another Meet link
    Then the new link is loaded into the existing call window, which is raised and focused
    And no "call already open" notification is shown and no second call window is created

  Scenario: [automatable] An unrecognised Meet address form counts as a meeting
    Given a call window is open on a Meet address the shell does not recognise
    When the user activates another Meet link
    Then the existing call is not navigated and the notification is shown

  Scenario: [automatable] A Meet link clicked inside the call window follows the second-link rule
    Given a call window is open on a meeting
    When the page tries to open or navigate to another Meet link
    Then no popup is created, the existing call is not navigated and the notification is shown

  Scenario: [automatable] A non-Meet link inside the call window opens in the system browser
    Given the call window is open on a Meet page
    When the page tries to open a popup or navigate to a link on any other host, with scheme http, https
      or mailto
    Then no popup window is created and the call window does not navigate
    And the link opens in the system browser and no message is shown

  Scenario: [automatable] A link with another scheme is not opened (main window and call window)
    Given the main window or the call window has a link whose scheme is not http, https or mailto
    When the user activates it
    Then it is not handed to the operating system and no window is created

  Scenario: [automatable] A crashed Meet page offers Reload or Close window in a native dialog
    Given the call window's page process has ended unexpectedly
    Then a native dialog "The call window stopped working" is shown with "Reload" and "Close window"
    When the user chooses "Close window"
    Then the call window is destroyed without a further confirmation and the application keeps running
    And no app-drawn crash panel exists

  Scenario: [automatable] Tray Show/Hide does not affect the call window (working default)
    Given a call window is open
    When the user chooses "Show/Hide Google Chat" from the tray
    Then only the main window is shown or hidden and the call window stays open

  Scenario: [automatable] A non-Meet link still goes to the system browser
    Given the main window shows a Chat message with a link to any other address
    When the user clicks the link
    Then the link opens in the system browser and no call window is created
```

**Verification — every release.** Real Meet inside Electron is not a documented, supported configuration
for Meet, so it can break on a user-agent or embedding change on Google's side. Spike B observed the
mechanics on a stand-in page and a real sign-in page load, not a real signed-in call. Every
**[manual-only]** scenario above must be **re-run by hand on every release**, on a real desktop, stating
which platform was actually tested (the same discipline as sign-in under ADR-0001). A release that has not
re-verified it must say so in its release notes. The first maintainer run must also settle: does real Meet
raise the unload objection during a call, and how long does it take to answer (to fix the 3-second
timeout)? If the objection cannot be observed, the P1 and P2 dialogs never show, by the failure direction
in the *Live call* definition, and the maintainer decides whether to accept that.

**Open questions (maintainer):**
- If a real Meet call does not work in Electron, what does the maintainer want? ADR-0004 lists Meet in the
  system browser, a Windows-only in-app Meet, or accepting the limitation.
- Does a native Linux desktop (with a camera) exist for the Linux half of the real-call check? If not,
  Linux Meet stays unverified.
- Confirm the working default above: tray Show/Hide acts on the main window only while a call is open.
- A link with a scheme other than http, https or mailto is simply not opened, with no on-screen cue.
  Please confirm that no cue is wanted.
- Does the "call already open" notification follow the Notification sound setting (FR-11)? Working
  assumption: yes.
- Page load failure: see the open question above.

### FR-17 — Links to Google services open in app-owned windows (UI-04)
**Priority: Must** (maintainer request UI-04, 2026-10-04). Design: [Google App Windows](../architecture/google-app-windows.md),
which holds the exact hostname lists; the security rule is the second exception in
[project-rules.md](../architecture/project-rules.md).

A link to a Google service clicked in Chat opens in a **separate app-owned window that shares the signed-in
session** (FR-04), so the user does not sign in again.
- **Which links:** `https` links whose hostname is exactly one on the fixed list (Drive, Docs/Sheets/Slides/Forms,
  Calendar, and, as defaults awaiting maintainer confirmation, Gmail, Keep, Contacts, Sites; see the design). No
  port, no userinfo, no suffix or wildcard match; a `www.google.com/url?q=` wrapper is unwrapped once.
  `https://forms.gle/...` is followed only if it redirects to a listed host (a Google Forms page); otherwise it
  opens in the system browser and no app window is ever shown.
- **One window per link;** the same link again focuses the existing window; a link with a `#heading` to an open
  document still on that page scrolls it to the heading. Closing a window destroys it and never quits the app or
  touches the main window or tray.
- **A Chat conversation link** (`https://chat.google.com`, conversation path) clicked in a Google app window loads
  in the **main window** (shown and focused if hidden). Clicked in the main window itself, it only focuses the main
  window (no reload) until the real pop-out addresses have been observed. Chat's own attachment/download opens
  from the main window are **not** loaded into any window: they go to the save dialog; an attachment/download
  address from an app window, and every other Chat-opened address, opens in the system browser. **Meet links**
  still open the call window (FR-16).
- **A short Forms link** (`forms.gle`) behaves the same whether clicked in Chat or inside a Google window.
- **Everything else** (other hosts, `mailto`, other Google hosts not on the list such as Maps) opens in the system
  browser by FR-16's scheme rule. Inside a Google window, navigation to a listed host (and
  `accounts.google.com`, for signing in again) stays in the window; anything else goes to the system browser.
- **Downloads** (for example Drive "Download", Docs export, and Chat attachments in the main window) always show a
  save dialog and are never opened automatically. A download from an address the app does not allow is not silent:
  a native "Download blocked" message appears (default button "Close", with a choice to open it in the browser);
  a second blocked download while it is open does not stack a second message. A Google window that only ever
  started a download closes by itself afterwards.
- **Presenting:** Slides "Present" and Drive video can go fullscreen in a Google window.
- The window contains only the Google page: no app-drawn UI, no preload, no camera/microphone/notification access.
  Closing a window whose page objects to closing (unsaved changes) asks first through one native dialog; Exit from
  the tray never waits.

```
Scenario: The maintainer's Drive example opens signed in
  Given the app is signed in to Google Chat
  And a chat message contains https://drive.google.com/file/d/FILE_ID/view?usp=sharing
  When the user clicks the link
  Then a separate app window opens showing that Drive file
  And no sign-in prompt appears
  And the system browser is not opened
  And the main window stays where it is   [manual-only]

Scenario: A non-Google link still uses the system browser
  When the user clicks https://example.org/ in Chat
  Then it opens in the system browser and no app window is created   [automatable]

Scenario: A lookalike host is not treated as Google
  When the user clicks https://drive.google.com.evil.example/x or http://drive.google.com/x or https://drive.google.com:8443/x
  Then each opens in the system browser and no app window is created   [automatable]

Scenario: A Google host outside the list uses the browser
  When the user clicks https://maps.google.com/ in Chat, or such a link inside a Google app window
  Then it opens in the system browser and no app window is created   [automatable]

Scenario: The same link twice
  Given the Drive example is already open in an app window
  When the user clicks it again
  Then that window is raised and focused and no second window opens   [automatable]

Scenario: A heading link to an open document
  Given a Docs document is open in an app window and still on that page
  When the user clicks a link to the same document with a #heading fragment
  Then the same window is focused and scrolled to the heading and no second window opens   [automatable]

Scenario: A short Forms link
  When the user clicks a forms.gle link that redirects to docs.google.com/forms
  Then the form opens in an app window and is shown only once it is on the listed host   [manual-only]
  When the user clicks a forms.gle link that redirects anywhere else
  Then no app window is shown and the destination opens in the system browser   [automatable]

Scenario: A short Forms link that fails or never answers
  When the user clicks a forms.gle link and the load fails or gives no answer within 10 seconds
  Then no app window is ever shown and the original link opens in the system browser   [automatable]

Scenario: A short Forms link clicked twice, or inside a Google window
  When the user clicks the same forms.gle link again while it is still being resolved
  Then no second window is created and nothing is shown or focused until it resolves   [automatable]
  When a forms.gle link is clicked inside a Google window
  Then it follows the same rule as from Chat, in a new window, and the current window is not navigated away   [automatable]

Scenario: A Chat conversation link opens in the main window
  Given the main window is hidden in the tray
  When a link to a Chat conversation (https://chat.google.com/room/...) is opened from a Google window
  Then the main window loads it, is shown and focused, and the system browser is not opened   [automatable]

Scenario: A Chat conversation link clicked in the main window
  When a conversation-shaped Chat address is opened by the main window itself (a Chat popup)
  Then the main window is shown and focused, its current view is not reloaded, and the system browser is not opened   [automatable for the routing, manual-only for the real address]

Scenario: A Chat attachment does not take over the main window
  When Chat opens an attachment or download address (for example a get_attachment_url address)
  Then the main window keeps its current view and a save dialog appears   [automatable for the routing, manual-only for the real address]

Scenario: An attachment address from a Google window
  When a link to a Chat attachment or download address is clicked inside a Google window
  Then it opens in the system browser and the main window is untouched   [automatable]

Scenario: Download asks where to save
  Given a Drive file is open in an app window
  When the user chooses Download
  Then a save dialog appears and nothing is opened after the download finishes   [manual-only]

Scenario: An export download asks where to save
  Given a Docs document is open in an app window
  When a download starts from the page (for example Download as)
  Then a save dialog appears and nothing is opened afterwards   [automatable with a stand-in page; real Docs manual-only]

Scenario: A large-file virus-scan confirm
  Given a large Drive file whose download first shows Google's "can't scan this file for viruses" page
  When the user chooses "Download anyway"
  Then the save dialog appears and the file downloads, nothing is opened afterwards   [manual-only; automatable with a stand-in for the routing rule]

Scenario: A download link that leaves an empty window
  When a link such as https://drive.google.com/uc?export=download&id=... is clicked in Chat
  Then a save dialog appears and, once the download ends, the Google window that only started it closes by itself   [automatable with a stand-in; real Drive manual-only]

Scenario: A disallowed download is not silent
  Given a download whose address, or any redirect step of it, is outside the allowed hosts
  Then it is cancelled and a "Download blocked" message appears, whose default button is "Close", offering to open it in the browser   [automatable]

Scenario: Closing the blocked-download message
  Given a "Download blocked" message is shown
  When the user presses Enter, Esc or "Close"
  Then it closes and no browser is opened   [automatable]
  And a second blocked download while it is open does not show a second message   [automatable]
  And if the window it belongs to is closed meanwhile the message goes away, and if that window is hidden the message still appears on top   [automatable with stand-ins]

Scenario: Signing in again inside a Google window
  Given a Google window is showing a document and the session needs re-authentication
  When the page goes to accounts.google.com
  Then the sign-in stays inside the same window and the system browser is not opened   [automatable with a stand-in; real sign-in manual-only]

Scenario: Closing a window whose page objects
  Given a Google window whose page asks to confirm leaving (it registers a beforeunload objection)
  When the user closes the window with the X button
  Then one "Close this window?" message appears
  And choosing "Keep window open" leaves the window as it was, and choosing "Close window" destroys it   [automatable with a stand-in page; real unsaved Docs changes manual-only]

Scenario: Closing a window whose page does not object
  When the user closes a Google window whose page raises no objection (or does not respond within about 3 seconds)
  Then it closes with no message   [automatable]

Scenario: Camera, microphone and notifications are refused
  When a page in a Google window asks for the camera, microphone, screen capture or notifications
  Then the request is denied and no picker or prompt appears   [automatable]

Scenario: Copy link and Present work in Docs and Drive
  When the user chooses Copy link, or Present in Slides, in a Docs or Drive window
  Then the link is copied, or the slideshow enters fullscreen and Esc leaves it   [manual-only]

Scenario: Exit is never blocked
  Given one or more app windows are open
  When the user chooses Exit from the tray
  Then the application quits without a prompt   [automatable]
```

**Open questions (maintainer, all with a default in force):** (1) Gmail, Keep, Contacts and Sites are included by default (author's choice, to be confirmed), and `g.co`, Maps, Apps Script, Looker Studio and Groups stay in the system browser;
confirm or change. (2) Google links clicked inside the Meet call window stay unchanged (system browser).
(3) Main-window downloads now always ask where to save. See the design's open questions.

### FR-18 — Smart copy: link URL on right-click, selection on mouse release (UI-05)
**Priority: Should** (maintainer request UI-05, 2026-10-04). Design: [Smart Copy](../architecture/smart-copy.md).

- **Right-click on a link** (main Chat window and every Google app window (FR-17), **not** the Meet call window
  (FR-16)) copies the link address to the clipboard at once and shows the hint "Link copied" next to the cursor for
  about 1.5 seconds. Only `http`, `https` and `mailto` addresses are copied (a Google `google.com/url?q=` wrapper is
  replaced by its target, **once**: a wrapper whose target is itself a wrapper copies that inner wrapper address);
  any other scheme (`javascript:`, `data:`, `tel:` ...) copies nothing and shows no hint. The address is the one the
  browser engine reports for the link, so it may differ cosmetically from how the author typed it (for example a
  trailing `/` is added to a bare host). Right-click anywhere else behaves as before (the app adds no menu). **This
  works only where the page lets the right-click through:** where Chat or a Google page draws its own right-click
  menu on a link, nothing is copied (recorded per surface in the design's spike; a documented limitation, not a
  defect). If the spike shows Chat does this in the main window, the maintainer is told and right-click link copy works in
  Google app windows only; no extra page-reading channel is added for it.
- **Selecting text with the left mouse button** (drag, double-click or triple-click) **in the main Chat window only**
  copies the selection when the button is released and shows the hint "Copied" for about 1.5 seconds. A plain click,
  a keyboard selection and a page script never copy. Rapid repeated selections (double-click then triple-click) end
  with the last selection on the clipboard.
- **Never inside an editable field** (maintainer decision 2026-10-04): selecting text in the message composer, the search
  box or any other text box does not copy it and shows no hint. For this the main window's existing preload checks the
  selection and sends one validated, payload-free, one-way signal (see the security baseline in
  [project-rules.md](../architecture/project-rules.md) and the [IPC Contract](../architecture/ipc-contract.md)); the
  signal is accepted only from the Chat page, never from the sign-in page.
- **Google app windows have no copy-on-select** (they have no preload and so cannot tell an editable field from
  plain text): selecting text there behaves as before; Ctrl+C works as before.
- The hint is a small window of the app next to the cursor: it never takes focus, does not intercept clicks, follows
  the light or dark OS theme and disappears by itself. It is not a system notification. It means a selection was
  seen and a copy was issued; if the page itself blocks copying, the hint can still show.
- Ctrl+C and the page's own copy features keep working unchanged. Anything selected reaches the OS clipboard (and
  its history, if the user turned one on). In the main window the copy is the same as Ctrl+C (formatting kept).

```
Scenario: Selecting text in a chat message copies it
  Given the main window shows a conversation
  When the user selects text in a message by dragging, double-click or triple-click, and releases the button
  Then the selection is on the clipboard and the hint "Copied" appears next to the cursor for about 1.5 seconds   [automatable for the signal and its validation; real Chat manual-only]

Scenario: Double-click then triple-click copies the last selection
  When the user double-clicks a word and triple-clicks the paragraph within 100 ms
  Then the paragraph is on the clipboard   [automatable]

Scenario: Selecting text in the message composer does not copy
  Given the main window has text in the message composer (or the search box)
  And the clipboard holds something else
  When the user selects text inside that field with the mouse
  Then the clipboard is unchanged and no hint appears   [automatable against a stand-in page; real Chat manual-only]

Scenario: The main window on the sign-in page does not copy
  Given the main window shows accounts.google.com
  When a selection signal arrives from that page
  Then the signal is rejected, nothing is copied and no hint appears   [automatable]

Scenario: A plain click, a keyboard selection or a page script never copies
  When the user single-clicks, selects with Shift+arrows or Ctrl+A, or a page script selects text or dispatches mouse events
  Then nothing is copied and no hint appears   [automatable]

Scenario: Right-click on a link copies its address
  Given a message contains a link to https://example.org/page
  When the user right-clicks the link, and the page raises its context-menu event
  Then https://example.org/page is on the clipboard and "Link copied" appears   [automatable for the handler; which Chat surfaces raise the event is manual-only]

Scenario: Right-click where the page draws its own menu
  Given a surface where the page cancels the right-click event
  When the user right-clicks a link there
  Then the app copies nothing and shows nothing (documented limitation)   [manual-only]

Scenario: A wrapped or unsafe link
  When the user right-clicks a link to https://www.google.com/url?q=https://example.org/x
  Then https://example.org/x is copied   [automatable]
  When the link is a wrapper whose target is another wrapper
  Then the inner wrapper address is copied, not unwrapped again   [automatable]
  When the link is javascript:, data:, tel: or any other scheme
  Then nothing is copied and no hint appears   [automatable]

Scenario: Right-click away from a link
  When the user right-clicks text or an empty area
  Then the app does nothing and adds no menu   [automatable]

Scenario: The Meet call window is excluded
  When the user selects text or right-clicks a link in the Meet call window
  Then nothing is copied and no hint appears   [automatable (the binder is not wired there)]

Scenario: Google app windows do not auto-copy a selection
  When the user selects text in any Google app window (Drive, Docs, Gmail, Calendar ...)
  Then nothing is copied and no hint appears; right-click link copy still works where the page raises the event   [automatable (no selection handler is wired); real windows manual-only]

Scenario: The hint never takes focus or clicks
  Given text was just copied
  While the hint is visible
  Then keyboard focus stays in the page, a click on the spot under the hint reaches the page, and the hint is gone after about 1.5 seconds   [automatable for the window options and timer; real desktop manual-only]

Scenario: The hint appears fully formed on any screen
  When a hint is shown on a second monitor with a different scaling, near a screen edge, in light and dark OS theme
  Then it shows its text from the first frame, next to the cursor and inside the screen   [manual-only]
```

### FR-19 — Sign-in through the organisation's identity provider
**Priority: Must** (completes FR-03 for accounts that sign in through single sign-on). Design: [Sign-in Flow](../architecture/sign-in-flow.md).

- While a sign-in is in progress, the **main window** may load the pages of the user's identity provider (SAML single
  sign-on such as Okta, Microsoft Entra / Azure AD, ADFS, Ping, OneLogin, a Google-hosted or custom-domain provider) and
  second-step or passkey pages on other origins, so the sign-in completes in the application with no system-browser
  step. A sign-in is *in progress* from the moment the main window lands on Google's sign-in origin
  (`accounts.google.com`), or lands on an acceptable provider page after being redirected through it (a returning user
  taken straight to the provider), until Chat loads again.
- It ends when Chat loads, or in one of **four aborts**: (1) after 10 minutes without a page change, (2) after 30
  minutes in total, (3) after 40 changes to a different origin, or (4) when the user chooses **Back to Chat** (tray
  menu, or the button of the notice below). In each of the four aborts the window returns
  to the Chat start page (and shows the sign-in again if the user is still signed out), **even if the page asks the
  user to confirm leaving it**. Closing or quitting the application only stops the timers. A session refresh that
  bounces through `accounts.google.com` briefly turns the sign-in on and off again; this is harmless.
- **Back to Chat** when no sign-in is in progress does nothing except show and focus the window. On a desktop **without
  a tray** there is no such entry and only the three limits end a sign-in that does not reach Chat.
- When a redirect during a sign-in is cancelled (it targets a refused or unacceptable address), the application shows
  **one** native notice per sign-in, **"This sign-in step can't open in the app"**, with the buttons **Back to Chat**
  and **Close**; it never shows the address.
- Only `https` pages are accepted: no `http`, `file`, `data`, `javascript`, no address with a user name or a non-standard
  port, no IP address (including disguised forms such as `0x7f.1`), no `localhost`, `*.localhost`, `*.local` or
  trailing-dot name, and no site name with an international (`xn--`) label. A one-word intranet name (for example
  `https://adfs/`) **is** accepted; the risk (a hostile redirect could show a page from the user's own network) is
  accepted and bounded by certificate checks, the inert-page rules and the limits above.
- Not loaded in the main window during a sign-in, and handled as before: Google Meet (call window), every Google
  application address (Docs, Drive, Calendar, Mail, Keep, Contacts, Sites: Google app windows), `forms.gle`,
  `drive.usercontent.google.com` and `*.googleusercontent.com`. A **redirect** to one of these is cancelled; a **link or
  script navigation** is routed as it is today.
- Pages of the identity provider get **no additional ability**: no notifications, clipboard, camera, microphone or
  screen access, no downloads (every download from the main window is cancelled while a sign-in is in progress, with a
  "Download blocked" notice in sign-in wording that offers **no** "Open in browser"; outside a sign-in downloads and
  their notice are unchanged), and no connection to the
  application (the main window's preload and the service-worker preload do nothing on any page other than Chat, which
  also removes the former exposure on the Google sign-in page). Their page title never changes the unread indicator,
  neither live nor when the page finishes loading. *The preload, injection, title and IPC origin gates **already
  ship**; the download rule and the sign-in mode itself are not yet implemented.*
- While a sign-in is in progress the window's native title reads **"Sign-in · <site> — <full address host>"**, with the
  site (registrable domain, for example `evil.example`) **first** and the full host after it (for example
  `Sign-in · evil.example — signin-verify.evil.example`), so a long title cannot hide the real site. The user can tell
  where they are (the window has no address bar). This is the system title, not drawn UI.
- Pop-up windows are still not opened in the application: they go to the system browser as before. A link opened in a new
  tab from a sign-in page goes to the system browser, and so does a same-tab `http:` link. **Limitation:** a link to
  another `https` site followed in the same tab stays in the window (it cannot be told from a sign-in step); the limits
  above, or **Back to Chat**, return the window to Chat. The only new control is the tray entry **Back to Chat**,
  shown only while a sign-in is in progress; nothing new is drawn in the window.
- Hiding the window (close button) does not cancel the sign-in, so a phone approval completes in the background.
- **Not supported:** identity providers on a non-standard port, at an IP address, or with an international (`xn--`) site
  name; Windows integrated authentication. Hardware-key/passkey prompts are **not guaranteed** (see the design;
  security keys and passkeys are verified manually per platform and the result recorded here).

```gherkin
Feature: Single sign-on in the main window
  Scenario: Sign in through the organisation's identity provider
    Given the application is not signed in and the account uses single sign-on
    When the user enters the address, is taken to the identity provider's own page, signs in there (and passes a second step)
    Then the Chat conversations load in the main window
    And no system-browser window was opened for any step   [manual-only: needs a real SSO account; the navigation rules are automatable]

  Scenario: The identity provider's page navigates by itself to another origin
    Given the sign-in is in progress and the main window shows the identity provider's page
    When that page submits a form or redirects to another https origin
    Then the main window follows it   [automatable]

  Scenario: Navigation outside a sign-in is unchanged
    Given the user is signed in and Chat is showing
    When a page in the main window navigates to an origin other than Chat or the sign-in origin
    Then the navigation is prevented and routed as before (system browser, call window or Google app window)   [automatable]

  Scenario: A returning user is redirected straight to the identity provider
    Given the user is not signed in and Chat redirects through accounts.google.com to the provider's page without stopping there
    When the main window shows the provider's page
    Then the sign-in is in progress and the provider's next steps load in the window   [automatable; manual with a real account]

  Scenario: Redirects in a subframe never cancel the page
    Given the sign-in is in progress or not
    When a frame inside the page (not the page itself) is redirected to any address
    Then the main page's navigation is not cancelled and the sign-in state is unchanged   [automatable]

  Scenario: Unsafe targets are refused during a sign-in
    Given the sign-in is in progress
    When a redirect targets http, file, data, javascript, an address with a user name, a non-standard port, an IP address (including 0x7f.1 or 2130706433), localhost, *.localhost, *.local, a trailing-dot name or a name with an xn-- label
    Then the redirect and its navigation are cancelled and nothing opens in the system browser   [automatable]
    And a link or script navigation to an http address opens in the system browser as before and is not loaded in the window   [automatable]

  Scenario: Google application and content addresses keep their own handling
    Given the sign-in is in progress
    When the main frame is sent by a link or script to meet.google.com, a Google application address (such as docs.google.com or drive.google.com), forms.gle, drive.usercontent.google.com or a googleusercontent.com address
    Then it does not load in the main window (a Meet link opens the call window, an application link its app window, the rest the system browser, as before)   [automatable]
    And a redirect to such an address is cancelled   [automatable]

  Scenario: The window title shows where the user is
    Given the sign-in is in progress and the main window shows the provider's page
    When the page sets its own title
    Then the window title stays "Sign-in · <site> — <host>" with the site (registrable domain) first, and returns to normal when the sign-in ends   [automatable]

  Scenario: Downloads are cancelled during a sign-in
    Given the sign-in is in progress
    When a page in the main window starts a download
    Then it is cancelled and a "Download blocked" notice in sign-in wording is shown, with no "Open in browser" action   [automatable]
    And outside a sign-in downloads behave as before   [automatable]

  Scenario: Back to Chat
    Given the sign-in is in progress on a page that asks for confirmation before leaving
    When the user chooses Back to Chat in the tray menu
    Then the main window is shown on the Chat start page without the confirmation, and the entry is gone from the menu   [automatable for the wiring; manual-only on a real page]

  Scenario: Back to Chat when no sign-in is in progress
    Given no sign-in is in progress (for example a stale notice button or menu item)
    When the user chooses Back to Chat
    Then the main window is shown and focused and nothing is reloaded   [automatable]

  Scenario: A redirect is cancelled during a sign-in
    Given the sign-in is in progress
    When a redirect to a refused address is cancelled (twice in the same sign-in)
    Then one notice "This sign-in step can't open in the app" with Back to Chat and Close is shown, only the first time; Back to Chat returns to the Chat start page and Close leaves the page   [automatable for the wiring; manual-only on a real page]

  Scenario: The sign-in page has no application bridge
    Given the main window shows Google's sign-in page or a provider's page
    When the page's scripts look for the application's bridge
    Then it does not exist   [automatable; also checked manually on the real pages]

  Scenario: Identity-provider pages have no abilities
    Given the main window shows an identity provider's page
    When the page asks for notifications, clipboard, camera, microphone or screen access, calls the application's bridge, sends a selection signal, or sets a title such as "(99) x"
    Then every request is denied or absent, no bridge exists on the page, and the unread indicator does not change   [automatable]

  Scenario: Sign-in ends when Chat loads
    Given the sign-in is in progress
    When the main frame commits on Chat
    Then the window is back on the fixed allow-list   [automatable]

  Scenario: An abandoned sign-in times out
    Given the sign-in is in progress and the user does nothing for 10 minutes (or 30 minutes have passed since it began, or more than 40 changes to a different origin happened)
    When the limit is reached, even if the page asks for confirmation before leaving
    Then the main window returns to the Chat start page   [automatable with a fake clock]

  Scenario: A link in a new tab from a sign-in page
    Given the main window shows an identity provider's page
    When the user opens a link in a new tab
    Then it opens in the system browser and the sign-in page stays   [automatable for the router; manual-only on a real page]

  Scenario: Hiding the window during a phone approval
    Given the sign-in waits for approval on the user's phone
    When the user closes the window to the tray, approves on the phone, and reopens the window
    Then Chat is showing and the user is signed in   [manual-only]

  Scenario: Security key or passkey as the second step
    Given the account requires a security key or passkey
    When the user uses it on Windows 11 and on Linux
    Then the outcome per platform is recorded here (completes, or is blocked)   [manual-only; not guaranteed]
```

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
- During a sign-in through an identity provider (FR-19) the main window may load that provider's `https` pages; they
  get no permission, no download, no preload bridge, no injected script and no accepted IPC (the origin gates and the
  download rule have shipped), and the widening ends when Chat loads, a limit is reached, or the user chooses Back to Chat.

### NFR-05 — Distribution/signing reality (ties to FR-09)
See the corresponding item in Risks & Open Questions for the full justification. Summary of what
is actually achievable for the two in-scope platforms:
- **Windows**: an installer (e.g. NSIS `.exe`) can be built and is functional without
  code-signing; unsigned, it will show a SmartScreen "unknown publisher" warning on first run.
  Signing requires a code-signing certificate, which is a separate, explicit decision — not
  assumed to be in scope unless the maintainer acquires one.
- **Linux**: both an AppImage and a `.deb` package are built, neither requiring any code signing.
  The `.deb` targets Debian/Ubuntu, the distro family the maintainer actually runs; AppImage runs
  anywhere without installation.
- **macOS is out of scope** — an explicit maintainer decision, recorded in
  [ADR-0003](../adr/0003-packaging-and-code-signing-approach.md). Confirmed directly against
  Electron's own docs (`https://www.electronjs.org/docs/latest/api/notification`): macOS requires
  an application to be code-signed for notifications to appear at all — an unsigned build there
  wouldn't just show a warning, it would silently lose FR-05 entirely on that platform. Signing
  requires an Apple Developer Program membership (US $99/year). The maintainer does not use macOS, so
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
**Priority: Must.** Mirrors the *Electron security baseline* project rule in
[project-rules.md](../architecture/project-rules.md), which is the authority if the two ever differ. FR-16
is the single exception to "external links open in the system browser"; this requirement bounds it.

- **Exact origin match.** A link gets the call window only if, after normal URL parsing, its scheme is
  `https` and its hostname is **exactly** `meet.google.com`. No suffix, substring or wildcard matching.
  Host case is normalised by URL parsing. Anything that only *looks* like the host is refused: a trailing
  dot, userinfo tricks (`meet.google.com@evil.example`), lookalike hosts. Per the project rule the origin
  must equal `https://meet.google.com`: an explicit port other than the default 443 is refused, and a URL
  carrying userinfo is refused.
- **Wrapper unwrapping.** Only a `https://www.google.com/url?q=<target>` wrapper is unwrapped, and only
  **once**. The wrapper's own URL must be exactly that host and path; the target must be a parseable URL
  and must then pass the exact test above on its own. A wrapper without `www`, a nested wrapper, an
  unparseable `q`, and a wrapper whose target is `http` or any other host all go to the system browser. A
  wrapper-shaped URL on any other host is **not** unwrapped.
- **Duplicated `q` parameter — refused (recommended default; the maintainer has not acknowledged it).** A
  wrapper carrying **more than one** `q` parameter is not unwrapped and goes to the system browser,
  because two parsers could pick different values. It is stricter than the maintainer's stated rule, so it
  cannot let a non-Meet link into the call window.
- **Which non-Meet links are opened in the operating system (maintainer decision 2026-10-01).** For the main
  window's external-link handling (new-window requests and navigations away from the allowed Chat origins)
  **and** the call window's, a URL that is not a Meet link is handed to the operating system **only if its
  scheme is `http`, `https` or `mailto`**. Any other scheme (`file:`, `ms-settings:`, `javascript:`, a
  custom application scheme, and so on) is not opened and creates no window. The scheme is the one
  produced by normal URL parsing, compared case-insensitively; an unparseable value is not opened.
- **Call window hardening**, checked on the `webPreferences` the call window is **created with**:
  `contextIsolation` on, `nodeIntegration` off, `sandbox` on, **no preload script**, so the Meet page has
  no bridge to the application; it shares the main session (so the login carries over); it **denies its
  own popups**; its navigation is limited to `meet.google.com` and `accounts.google.com`. A popup or
  navigation it blocks for pointing at any other address is **routed, not dropped**: `http`, `https` and
  `mailto` open in the system browser, any other scheme is not opened. The call window itself never opens
  a second window or navigates away. The window contains only the Meet page (FR-16).
- **Main-window navigation.** A Meet URL that the **main window** tries to navigate itself to
  (`will-navigate`, not just a new-window request) is intercepted and treated exactly like a link click:
  prevented in the main window and routed by these rules. All other main-window navigation is unchanged.
- **Permissions scoped to Meet** (the two-origin rule is a recommended default; the maintainer has not
  separately decided it). Camera, microphone and screen-capture permissions are granted only when **both**
  the requesting origin and the top-level page's origin are exactly `https://meet.google.com`, enforced in
  **both** the permission-request handler and the permission-check handler. Every other case is refused:
  any other origin (including the main Chat window's own), `http://meet.google.com`, and a Meet frame
  embedded inside a page that is not Meet. The existing notifications permission for the main window is
  unchanged.
- **Screen share is never automatic** — it always goes through the application's own source picker
  (FR-16), and the user chooses the source explicitly. On Linux the application's picker is used.
- **Closing the call window never quits the app** (FR-06/FR-07).
- **Everything else is unchanged:** every other `http`, `https` or `mailto` URL still goes to the system
  browser; the main window's NFR-04 baseline is untouched; session cookies and credentials are never
  logged, persisted or transmitted by this feature.

All scenarios below are **[automatable]** (URL classification and handlers are pure decisions and can be
tested without a real Meet). The real-call checks are the **[manual-only]** scenarios in FR-16.

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
      | https://www.google.com/url?q=https%3A%2F%2Fmeet.google.com%2Fabc-defg-hij&q=https%3A%2F%2Fevil.example%2F | system browser (duplicated q; recommended default) |
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
      sandbox on, and no preload script
    And it uses the main session
    And a popup opened from it is denied

  Scenario: [automatable] Call window navigation is limited, and the blocked link is routed
    Given the call window is open on a Meet call
    When the page attempts to navigate to https://example.org/ (a host other than meet.google.com or
      accounts.google.com)
    Then the navigation is blocked in the call window
    And https://example.org/ opens in the system browser

  Scenario: [automatable] A popup from the call window is denied and routed
    Given the call window is open on a Meet call
    When the page calls window.open("https://example.org/")
    Then no popup window is created
    And https://example.org/ opens in the system browser

  Scenario Outline: [automatable] Only http, https and mailto are handed to the operating system
    When a link "<url>" is activated in the main window or in the call window
    Then the outcome is "<outcome>"

    Examples:
      | url                                  | outcome                            |
      | https://example.org/page             | system browser                     |
      | http://example.org/page              | system browser                     |
      | HTTPS://example.org/page             | system browser                     |
      | mailto:someone@example.org           | operating system mail handler      |
      | file:///C:/Windows/System32/calc.exe | not opened                         |
      | ms-settings:privacy                  | not opened                         |
      | javascript:alert(1)                  | not opened                         |
      | ssh://host.example                   | not opened                         |
      | not a url                            | not opened                         |

  Scenario Outline: [automatable] Media and screen-capture permissions only for the Meet origin
    When a page at "<requesting>" embedded in a top-level page at "<top>" requests camera, microphone
      or screen capture
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

  Scenario: [automatable] No automatic screen source (stubbed source list)
    When Meet requests screen capture
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
  assumption pending the maintainer:** the Linux **AppImage artifact file name** contains no space
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
build-time configuration choice for the maintainer/the implementer to apply, not a requirement this
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
differently: the maintainer decided macOS isn't a target platform at all (see NFR-05, ADR-0003), so
there is no longer a three-platform signing problem to solve — only Windows' (unsigned, accepted)
and Linux's (no signing concept) remain, and neither needs a multi-machine build story.

### Resolved — start-on-login (FR-10)
Originally left as an open question ("not requested; natural companion feature but not assumed").
The maintainer has since explicitly asked for it — see FR-10.

### Resolved — notification sound / mute (FR-11, FR-12)
Originally left as an open question ("not specified; OS defaults assumed, no in-app override"). The
maintainer has since explicitly asked for both an independent sound toggle and a manual mute — see FR-11
and FR-12, including the design decision that "quiet hours" and "mute" are treated as one feature
(a manual toggle, not a scheduled time window) and the stated rationale for that choice.

### Resolved — build/version diagnostic line (FR-13)
Not part of the original scope; added when the maintainer ran into a real diagnostic need mid-incident
(distinguishing an installed build from a dev run from source while investigating the
FR-05 notification failure) — see FR-13 and [ADR-0002](../adr/0002-notification-delivery-mechanism.md).

### Resolved — blinking tray icon and Settings window (FR-14, FR-15)
Not part of the original scope; added on explicit maintainer request ("I want the tray icon to blink
when there are messages, like in the old days" / "so that all this can be managed — sound, icon
blinking, and so on"). Decided rather than left open: the attention indicator (tray blink and, since
2026-09-30, taskbar flash) stops only when the main window **gains focus** (never on a timer or blink
count, and no longer merely on becoming visible) and resumes on any subsequent new message that
arrives while the window is not focused, even if it had already stopped once — FR-14 holds the full
start/resume and stop conditions and is the single authority; muted unread state stays visible but
does not blink; Settings changes apply immediately with no Save/Cancel.

**Tray menu vs. Settings — superseded decision.** An earlier draft kept the tray menu's three
existing checkboxes (Start at login, Notification sound, Mute notifications) unchanged, reasoning
that the maintainer shouldn't have UX they rely on removed without being asked. Asked directly, the
maintainer decided the opposite: only **Mute notifications** keeps a tray quick-toggle; **Start at
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
| FR-17 | Links to Google services open in app-owned windows (new 2026-10-04, UI-04) |
| FR-18 | Smart copy: link URL on right-click, selection on mouse release, with a cursor hint (new 2026-10-04, UI-05) |
| FR-19 | Sign-in through the organisation's identity provider: time-boxed sign-in mode in the main window (new 2026-10-06) |
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
| FR-05b | Must (conditional) | Title = chat name, body = message text; applies under maintainer answer (a) only | ADR-0004 Spike C; ADR-0002 piece 2; the *Wrapper, not a rewrite* project rule; open question in FR-05 |
| FR-05c | Must (step 1 unconditional, step 2 conditional) | Click brings window forward from tray/minimized; step 2 opens that conversation under (a) only; degraded outcome logged | ADR-0004 Spike C; open question in FR-05 |
| FR-06, FR-07 | Must | Scoped: close-to-tray and tray Show/Hide act on the main window only | FR-16 |
| FR-07 | Must | Amended 2026-10-01: tray entry "Show call window" (P3); Exit asks first while a live call exists (P2). Amended 2026-10-02: both are native dialogs/entries only, wording in design 06; Exit-while-P1 fallback when P1 cannot be dismissed | Maintainer decisions 2026-10-01 and 2026-10-02; FR-16 |
| FR-16 | Must | Cut 2026-10-02 to the minimum: call window holds only the Meet page; the source picker is the one app-drawn surface; P1/P2/P3 and the Meet-crash dialog are native; app view, status strip, crash panel and Linux OS-picker option removed | Maintainer decision 2026-10-02; NFR-07; ADR-0004 (Spike B) |
| NFR-07 | Must | Amended 2026-10-02: app view removed from the hardening list; call window created without a preload; permissions reworded as media and screen capture | Maintainer decision 2026-10-02; the *Electron security baseline* project rule |
| FR-09 | Must | Prose and Linux scenario now reference NFR-08 | NFR-08, NFR-05 |
| FR-10 | Must | Linux autostart `Exec` path must be the space-free executable path (checked under NFR-08); first-run default changed to on, see the last row of this table | NFR-08, FR-15 |
| FR-10, FR-15 | Must | Amended: first-run defaults all on (Start at login, sound, blinking), mute off; applied once on a fresh install, never over an existing user choice | Maintainer decision 2026-09-30 |
| FR-14 | Must | Amended: taskbar flash added; condition "hidden" becomes "not focused"; stop on focus; degraded trigger stated; working assumptions on flash, mute and the setting | ADR-0004 (S2: `flashFrame` unimplemented), FR-05a, FR-12, FR-15, NFR-06 |
| FR-16 | Must | New 2026-09-30: Meet in app-owned call window, own screen-share picker (history: see the rows above and the change log) | ADR-0004 Spike B; the *Electron security baseline* project rule; NFR-07; design 05 |
| NFR-07 | Must | New 2026-09-30: exact-origin match, hardened call window, permissions scoped to Meet; duplicated-`q` wrapper refused (narrowing; recommended default, maintainer acknowledgement outstanding) | The *Electron security baseline* project rule; NFR-04 |
| NFR-08 | Must | New: no spaces in Linux install path/executable name; deb declares audio dependency | FR-09, FR-10, NFR-05 |

## Change log

- **2026-10-06 (FR-19)** — A compatibility audit found that sign-in through an organisation's identity provider (single
  sign-on, some second-step and passkey pages) died when the provider's page navigated to its own origin, because the
  main window's navigation list was only Chat and `accounts.google.com`. FR-19 added: a time-boxed sign-in mode in the main
  window, with no added permission, bridge or IPC for those pages. Design: [sign-in-flow.md](../architecture/sign-in-flow.md);
  fourth exception recorded in [project-rules.md](../architecture/project-rules.md); the overview's "provisional list" note
  replaced. FR-03 and NFR-04 cross-refer.
- **2026-10-04 (UI-05, FR-18)** — Maintainer request: right-click on a link copies its URL and releasing the mouse after a
  selection copies the text, each with a short hint next to the cursor (app-owned hint window, not an OS
  notification); right-click link copy in the main window and Google app windows, not the Meet call window. FR-18 added. Design:
  [smart-copy.md](../architecture/smart-copy.md). Revised same day after review and a maintainer decision:
  copy-on-select never fires in editable fields of the main window, which gives the main window's existing preload
  one narrow, validated, one-way signal (Google app windows still have no preload); FR-18 moved after FR-17's
  scenarios and given its own tagged scenarios; right-click link copy stated as conditional on the page. Second revision
  (spec review, maintainer go): copy-on-select is main Chat window only, Google app windows get none (no preload, so editable
  fields cannot be told apart); the preload link-payload fallback is not authorised; trailing-edge rate limit; nested
  wrapper unwrapped once.

- **2026-10-04 (UI-04, FR-17)** — Maintainer request: links to Google services open in app-owned windows sharing
  the signed-in session instead of the system browser; Chat links load in the main window. FR-17 added; the
  "other Google hosts in-app" scope exclusion narrowed to the fixed list; the project rules' security baseline
  gained a second exception. Design: [google-app-windows.md](../architecture/google-app-windows.md).
- **2026-10-02 (Meet scope cut to the minimum)** — The Meet design set had grown well beyond what the maintainer
  asked for (23 mockup states, an app-owned view inside the call window, a status strip, a crash panel).
  The maintainer approved cutting it, under the *Design scaled to the wrapper* project rule (only surfaces the
  shell must draw get design; native dialogs and tray entries get a wording spec, not a mockup; see
  [project-rules.md](../architecture/project-rules.md)). FR-16, NFR-07 and the Meet parts of FR-07 now
  state exactly this scope: (1) URL classifier unchanged; (2) the call window contains only the Meet page,
  no app-owned view, strip or panel, no preload; (3) second link: no meeting on screen loads into the
  existing window, a live meeting gets focus plus the native notification, and the end-page defect is kept
  as a documented known limitation; (4) media and screen-capture permissions only for the Meet origin;
  (5) the source picker is the one app-drawn surface (modal, loading state, cancel denies, never
  auto-selected; the Linux OS-picker option is dropped, the app picker is used and the portal stays
  unverified); (6) P1 and P2 are native OS dialogs and P3 a tray entry, with a fallback when a native P1
  cannot be dismissed (focus P1, show P2 after it is answered); (7) a Meet page crash gets a native dialog
  (Reload / Close window), the app-drawn crash panel and the opening and load-error panels are removed;
  (8) Meet's unload objection must never silently block a close or quit (Spike B finding, ADR-0004).
  Removed: app-view hardening, status-strip and panel requirements, the "opening / slow-load / load error"
  states, the Linux OS-picker scenario, the conditional-on-Spike-B tagging of most Meet scenarios (Spike B
  has run; what remains unobserved is a real signed-in call, kept as a manual check). New open question:
  what a page load failure should show now that no panel exists. Design docs 03, 04, 06 to 10 and the
  Meet mockups were deleted; design 05 trimmed to the picker; new design 06 holds the dialog wording.

- **2026-10-01 (Meet review fixes)** — After the review: (1) the project rule now holds the
  http/https/mailto allow-list, so the "maintainer must add a line" item is removed; (2) tray Exit is never
  ignored: with the close confirmation (P1) open it is dismissed and the Exit confirmation (P2) is shown,
  with P2 already open it is focused (default, maintainer to confirm; FR-07, FR-16); (3) P1/P2
  scenarios and the FR-07 Exit paragraph tagged conditional on Spike B, and manual-only cases against a
  real Meet call added (dialog appears in a live call, none after Leave); (4) the Meet end page shares the
  meeting's address, so address-only detection refuses the next Meet link and shows a false "A call is
  already open" notification; recorded as a known defect with a mitigation proposed pending Spike B;
  (5) "never nothing visibly happens" now states the bounded hung-page wait (at most 3 s) as its only
  exception; (6) outcome of cancelling the Exit confirmation after Exit closed the picker stated; (7) the
  picker wireframe exists, stale "requires a wireframe" removed.

- **2026-10-01 (Meet maintainer decisions)** — The maintainer decided: (1) a second Meet link while the call window
  is open but shows no meeting page loads into the existing window (revises FR-16's "does not navigate
  away unprompted" for that case; with a meeting page on screen it still focuses the window and shows the
  notification, no navigation); (2) all three call-time confirmations: P1 confirm on closing the call
  window during a live call, P2 confirm on tray Exit (amends FR-07), P3 tray entry "Show call window";
  (3) the external-link handler opens only `http`, `https` and `mailto`, any other scheme is not opened;
  (4) non-Meet links clicked inside the call window open in the system browser (the "A link was not
  opened" strip was rejected). Definitions of *call window
  exists*, *meeting page on screen* and *live call* moved into FR-16; the app view's hardening (decided by
  the maintainer) recorded in NFR-07. Kept as recommended defaults, not maintainer-decided: the two-origin Meet
  permission rule, refusal of a duplicated `q`, Linux keeping the app picker until Spike B passes there,
  tray Show/Hide acting on the main window only. Design docs and the architecture note updated to match.

- **2026-09-30 (first-run defaults)** — Maintainer decision: after installation everything is on by
  default: Start at login (previously off; launches hidden into the tray), notification sound and icon
  blinking (both already on); Mute stays off. Defaults apply only on the first run of a fresh install
  and never override an existing user choice, including a startup entry disabled in the Windows Task
  Manager. FR-10 and FR-15 amended, scenarios added for first-run defaults and for preserved user
  choices. Nothing else changed.

- **2026-09-30** — Maintainer decisions folded in. FR-05 sharpened (notification title/body content; click
  from tray or minimized opens that conversation) and marked doubtful in mechanism after the
  service-worker finding, with the deep-link approach left as an open maintainer question (ADR-0004
  Spike C). FR-14 reworked: taskbar flash added, trigger and stop changed from hidden/visible to
  not-focused/focused (the earlier "becoming visible stops blinking" rule is reversed). FR-16 and
  NFR-07 added for Meet in an app-owned call window (unverified in Electron, Spike B, re-verify each
  release). NFR-08 added for Linux packaging. Scope lists updated. FR-06 and FR-07 scoped to the
  main window; FR-09 references NFR-08. FR-01..FR-04, FR-08, FR-10..FR-13 and FR-15 otherwise
  unchanged.
- **2026-09-30 (review pass)** — After adversarial review: FR-05 split into FR-05a (unconditional
  delivery), FR-05b/FR-05c (conditional on Spike C and the maintainer's answer), with a table of what
  applies under each answer, the degraded-outcome logging defined, the tray unread indicator restated
  as a single global observable state, "with that message visible" dropped (the maintainer said "open that
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
  rule stated as the project rule's, without hedge. Design docs added to the superseded list; FR-15 gained
  the label question; FR-09 and FR-10 added to the changes table.

- **2026-09-30 (maintainer decisions recorded)** — The maintainer approved four defaults:
  (1) the one "Icon blinking" setting governs both the tray blink and the taskbar flash (FR-14, FR-15
  label must say so); (2) new-message notifications and indicators keep arriving during a Meet call
  (FR-14, FR-16); (3) one call window at a time, with the "call already open" notification (FR-16);
  (4) on Linux the OS screen-share picker may replace the app picker if Spike B shows it works, the
  user always choosing explicitly (FR-16, NFR-07). Still working assumptions, not approved: mute also
  suppresses the taskbar flash; mute or blinking turned back on does not start indicators until the
  next arrival; tray Show/Hide acts on the main window only during a call. NFR-07 gained a
  duplicated-`q` wrapper refusal proposed during review, marked a narrowing pending maintainer
  acknowledgement.

### Downstream docs superseded

These documents still describe rules this requirements document has changed. They are **not
authoritative where they conflict**; they are to be updated once this
document is approved.
- [tray-lifecycle.md](../architecture/tray-lifecycle.md) — the blink start/stop rules ("hidden" /
  "becomes visible", including its `applySetting` and stop-condition sections) and the tray
  Show/Hide behaviour now conflict with FR-14 (focus-based, plus the taskbar flash) and FR-07.
- [notifications.md](../architecture/notifications.md) — the page-`Notification` bridge mechanism, the
  Page Visibility dependency and the click-to-conversation mechanism now conflict with FR-05 (three
  parts, the service-worker finding, conditional content and click).
- [00-settings-surface-spec.md](../design/00-settings-surface-spec.md) — the "Blink tray icon on
  unread" label (lines 127, 154, 171), the §9 tray-only blink state machine (hidden/visible triggers,
  no taskbar flash) and the mute note now conflict with FR-14. **Maintainer decided (2026-09-30):** the
  "Icon blinking" setting also governs the taskbar flash, so its label in FR-15 and the Settings
  window must change to say so (for example "Flash and blink on new message").
- [01-settings-wireframes.md](../design/01-settings-wireframes.md) — repeats the same label
  (lines 36, 76, 116, 138), the same "Blinks on a new message; stops…" helper text, and a state table
  whose stop trigger is "window becomes visible"; both conflict with FR-14. `02-rationale.md` cites
  the same rules (its proposed "FR-14" text) and needs the same check.
- To be checked by the maintainer for the same reason (not verified here): ADR-0002 piece 2 and its
  fallback (ADR-0004 already touches them), `ipc-contract.md`, and `packaging-release.md` (NFR-08).

Later design/test artifacts should cite these IDs directly (e.g. "implements FR-05", "covers
NFR-04") rather than re-describing the requirement.
