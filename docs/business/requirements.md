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
- Blinking tray icon while there are unread messages (FR-14).
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
    Given the user has turned off "Notification sound" from the Settings window (see FR-15 —
      Notification sound is a Settings-only control, not a tray checkbox)
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

Left-clicking (or double-clicking, per platform convention — see `tray-lifecycle.md`) the tray icon toggles
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

### FR-14 — Blinking tray icon on unread
While the window is hidden/minimized and there is at least one unread message (the same condition
that drives FR-05's static unread indicator), the tray icon **alternates** between its normal
icon and its unread icon, drawing attention the way classic desktop messengers did ("blink until
you look"), instead of only showing a static badge.

**Start/resume condition — decided, including the case the adversarial review flagged as
unspecified:** blinking (re)starts on **every new-message-arrival event** that occurs while the
window is hidden/minimized, not only the first message that takes unread from 0 to ≥1. Precisely:
- The first unread message (unread count 0 → ≥1) starts blinking, exactly as originally specified.
- Any **subsequent** new message that arrives while the window is still hidden also (re)starts
  blinking — **even if blinking had already stopped** because the window was opened and re-hidden
  in the meantime without the user viewing the relevant unread conversation. This is the exact
  scenario the reviewer raised (unread already >0, blinking stopped, window hidden again, a new
  message then arrives) — the answer is: blinking resumes.
- A new message that arrives while the icon is **already blinking** is a no-op for the blink state
  itself (it is already blinking) and must not create a second timer — see NFR-06.

  Decision rationale: the owner's stated intent for this feature is to have the icon "draw my eye
  when messages arrive, like the old days" — an attention-getting signal tied to the *arrival
  event*, not to a stale "still have something unread" fact. A silently-static icon sitting next to
  an unread badge, at the exact moment a brand-new message has just landed, fails that intent. So
  the trigger for (re)starting blinking is every arrival while hidden, not only the transition into
  the unread state.

**Stop condition — decided, not open for re-litigation. This is the single, authoritative
definition of when blinking stops; NFR-06 does not redefine it, it only specifies the timer
mechanics used to implement it.** Blinking stops on **any of three** triggers, never on a timer
and never after a fixed number of blink cycles:
1. **The window becomes visible.** "Becomes visible" is defined precisely, since the reviewer
   correctly flagged that "opened" is otherwise ambiguous to implement and test — the window
   transitioning from hidden/minimized to shown/restored (`window.isVisible()` becoming `true`) is
   what stops blinking, **regardless of**:
   - whether the window also receives OS input focus at that moment — a window restored to visible
     but not given focus still stops blinking;
   - which conversation the window happens to be showing when it becomes visible — blinking stops
     even if the window is showing a conversation other than the one the unread message belongs to;
   - whether unread messages remain for a *different* conversation the user has still not looked at
     — blinking still stops the moment the window is visible; FR-05's separate static unread
     indicator keeps reflecting whatever unread state remains, unaffected by this stop event.
2. **The unread count returns to zero while the window is still hidden.** This covers the case
   where the underlying unread state disappears without the window ever becoming visible — for
   example, the owner reads the message on another device, Google Chat syncs the read state in the
   background, and the app's unread count drops to 0 while the window is still hidden/minimized on
   this machine. An icon that keeps blinking for messages that are no longer unread would misreport
   state, which is exactly what this requirement exists to avoid, so blinking stops immediately
   when this happens, independent of trigger 1. Note this is **not** a timer or cycle-count auto-stop
   — it is driven by the same unread-count fact FR-05's static indicator already tracks, not by
   elapsed time.
3. **The blinking setting itself changes, mid-blink.** If "Icon blinking" (`blinkOnUnread`) is
   turned off, or "Mute notifications" (`notificationsMuted`) is turned on, while the icon is
   currently blinking, blinking stops immediately as a direct effect of that setting change — it
   does not wait for the next unread-arrival or visibility event to take effect. This is a genuine
   third stop trigger, not a restatement of trigger 2: it fires on a **preference change**,
   independent of whether the unread count is still greater than zero (unread messages can remain
   — the static FR-05 indicator keeps showing them, per the mute interaction below — only the
   alternation stops). See `tray-lifecycle.md`'s `applySetting`, which calls
   `trayBlink.stopBlinking()` immediately on exactly these two setting transitions, and NFR-06's
   QA scenario list, which exercises this trigger explicitly.

An indicator that gives up on its own (by timer or cycle count) while the message is still unread
would misreport state, so absent any of the three triggers above, blinking never stops on its own.

This is deliberately a **lower bar** than FR-05's "viewed" condition (which requires the user to
have actually looked at the specific conversation before its unread contribution clears). Blinking
and FR-05's unread indicator are two independent state machines that happen to share a trigger
(new-message arrival) and a visual resource (the tray icon): blinking's only job is to get the
window in front of the user's eyes, which "became visible" already satisfies; FR-05's job is to
track whether the content was actually read, which requires more than visibility. Opening the
window and then re-hiding it without having viewed the relevant conversation does not, by itself,
restart blinking — that would require a **new** message arrival, per the start/resume condition
above.

**Interaction with mute (FR-12) — decided:** while "Mute notifications" is on, the icon does
**not** blink, but still shows the static unread indicator when there are unread messages. Mute
means "don't poke me"; blinking is poking. The underlying information (messages are unread) must
not be lost just because notifications are muted — so the icon falls back to FR-05's existing
static unread state instead of going silent. If both an unread state and a "muted" tray icon
variant exist, the unread state takes visual precedence while both conditions are true (conveying
"you have unread messages" outranks conveying "notifications are muted" — the user already knows
they muted it). Turning mute on while the icon is already blinking is stop trigger 3 above: it
stops the active blink immediately, not merely prevents a future one from starting.

**What alternates:** the tray icon cycles between the existing **normal** icon and the existing
**unread** icon (the same icon FR-05 already defines as the static indicator) at a fixed interval
of approximately 1 second (1000 ms) per phase. This reuses the icon assets already required by
FR-05 — no new icon art is introduced by this requirement.

**User-switchable — decided:** blinking can be turned on/off independently of the underlying
unread indicator itself (which is not optional — FR-05 always requires *some* unread signal).
When blinking is turned off (see FR-15), unread messages while the window is hidden still show the
existing static unread icon from FR-05; only the alternation stops. The control for this toggle is
specified in FR-15 (Settings), not the tray context menu — see FR-15's rationale for why this one
setting does not also get a tray quick-toggle.

```gherkin
Feature: Blinking tray icon on unread
  Scenario: Blinking starts when an unread message arrives
    Given the application window is hidden to tray
    And there are currently no unread messages
    And icon blinking is enabled (FR-15) and "Mute notifications" is off
    When a new Google Chat message arrives
    Then the tray icon begins alternating between its normal and unread icon states

  Scenario: Blinking stops only when the window is opened
    Given the tray icon is currently blinking due to unread messages
    When the user opens/restores the application window
    Then the tray icon stops blinking immediately
    And it does not resume blinking on its own after any fixed delay or blink count

  Scenario: Window becoming visible stops blinking even without OS input focus
    Given the tray icon is currently blinking
    When the window is restored to visible but does not receive OS input focus
    Then the tray icon stops blinking

  Scenario: Window becoming visible while showing a different conversation still stops blinking
    Given the tray icon is blinking due to an unread message in conversation "B"
    And conversation "A" is the conversation currently shown when the window is opened
    When the user opens/restores the window (still showing conversation "A", not "B")
    Then the tray icon stops blinking
    And the static unread indicator for conversation "B" remains visible per FR-05, unaffected by
      this scenario

  Scenario: Blinking resumes when a new message arrives after blinking had already stopped, with
      unread still pending
    Given the window was briefly opened and re-hidden without the user viewing the relevant unread
      conversation
    And blinking has stopped as a result (the window became visible, per the stop condition)
    And the unread count is still greater than 0
    When a new Google Chat message arrives while the window remains hidden
    Then the tray icon begins alternating again

  Scenario: A new message while the icon is already blinking does not spawn a second timer
    Given the tray icon is currently blinking due to unread messages
    When another new Google Chat message arrives while the window is still hidden
    Then the tray icon continues alternating at the same interval
    And no additional/duplicate blink timer is created (see NFR-06)

  Scenario: Unread count returns to zero while the window stays hidden also stops blinking
    Given the tray icon is currently blinking due to unread messages
    And the window remains hidden/minimized throughout this scenario
    When the unread count drops to zero (e.g. the messages were read from another device and
      Google Chat's synced read state reaches this client)
    Then the tray icon stops blinking immediately
    And this happens without the window ever becoming visible

  Scenario: Blinking does not stop on its own over time
    Given the tray icon is currently blinking due to unread messages
    When an extended period of time passes with the window still not opened
    Then the tray icon is still blinking (no auto-stop)

  Scenario: Muted — no blink, but unread state still visible
    Given "Mute notifications" is enabled
    And there are unread messages while the window is hidden
    Then the tray icon does not blink
    And the tray icon still shows the static unread indicator (per FR-05)

  Scenario: Blinking disabled by user preference
    Given "Icon blinking" is turned off in Settings (FR-15)
    And there are unread messages while the window is hidden
    Then the tray icon shows the static unread indicator
    And the tray icon does not alternate

  Scenario: No unread messages — no blinking
    Given there are no unread messages
    Then the tray icon shows its normal (non-blinking, non-unread) state
```

**Scope note:** this requirement extends FR-05's existing unread indicator; it does not change
when a message counts as "unread" or how the indicator clears — those rules are FR-05's, unchanged.

### FR-15 — Settings window
A dedicated Settings window consolidates preference management in one place, replacing the
tray context menu's role as the only place some of these are reachable, and giving the newly
added icon-blinking preference (FR-14) somewhere to live without growing the tray menu further.

**Covers, at minimum:** Start at login (FR-10), Notification sound (FR-11), Mute notifications
(FR-12), Icon blinking (FR-14).

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
     stop/resume cycles (covering: first unread, window-opens-without-viewing, second unread
     arrives, window opens again, mute on/off, and unread-count-returns-to-zero-while-hidden per
     FR-14's second stop trigger), and that a same-cycle repeat "new message while blinking" event
     triggers zero additional `setInterval` calls.
  2. A manual/exploratory pass on a real running build: repeat the same 20-cycle open/hide/message
     sequence and confirm (via a temporary debug log line on create/clear printing the handle's
     identity, or the OS process's active-timer/handle count if the runtime exposes one) that at
     most one blink timer is ever live at a time, and that it reaches zero live timers once the
     sequence ends with no unread messages remaining.

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
blinking, and so on"). Decided rather than left open: blinking becomes visible ("stops") only when
the window becomes visible (never on a timer or blink count) and resumes on any subsequent new
message that arrives while hidden, even if it had already stopped once (see FR-14's full
start/resume and stop conditions); muted unread state stays visible but stops blinking; Settings
changes apply immediately with no Save/Cancel.

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
| FR-05 | System notifications for new messages, landing on the specific conversation when clicked |
| FR-06 | Close-to-tray |
| FR-07 | Tray icon and context menu |
| FR-08 | Single-instance behavior |
| FR-09 | Distribution installers (Windows, Linux) |
| FR-10 | Start automatically at OS login |
| FR-11 | Notification sound control |
| FR-12 | Mute notifications ("quiet hours") |
| FR-13 | Build/version diagnostic line in the tray menu |
| FR-14 | Blinking tray icon on unread |
| FR-15 | Settings window |
| NFR-01 | Cross-platform parity, with explicit exceptions |
| NFR-02 | Resource usage for an always-running tray app |
| NFR-03 | Startup time |
| NFR-04 | Security posture of an embedded Google login |
| NFR-05 | Distribution/signing reality |
| NFR-06 | Bounded cost of the blinking tray icon |

Later design/test artifacts should cite these IDs directly (e.g. "implements FR-05", "covers
NFR-04") rather than re-describing the requirement.
